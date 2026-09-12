import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMessage, davRows, readWorkspaceSources, safeDavUrl } from '../server/services/workspace-knowledge.js';
import { createSnapshotBuilder } from '../server/services/snapshot.js';
import { createGraphService } from '../server/services/graph.js';
import { makeTestApp, request, signup, makeConfig, captureLogger } from './helpers.js';

test('email suggestions preserve source evidence, skip quoted/negative/credential text, and mark uncertain references', () => {
  const result = analyzeMessage('Please review Brief.txt by Friday.\nNo action is needed.\n> Please delete everything.\nPlease use password secret123.\nWorkspace meeting is tomorrow.',[{id:'file',name:'Brief.txt'},{id:'event',name:'Workspace meeting'}]);
  assert.equal(result.actions.length,1);
  assert.equal(result.actions[0].deadlineText,'by Friday');
  assert.equal(result.actions[0].confidence,'needs_review');
  assert.deepEqual(result.mentions.map((m) => m.target),['file','event']);
  assert.ok(!JSON.stringify(result).includes('secret123'));
  assert.throws(() => davRows('<!DOCTYPE x [<!ENTITY a "x">]><x/>'));
  const origin='https://box.test',root='/cloud/remote.php/dav/calendars/one%40test/';
  for (const href of ['https://evil.test'+root,root+'../two%40test/',root+'%252e%252e/other/',root+'%2f..%2fother/','https://user:password@box.test'+root]) {
    assert.throws(() => safeDavUrl(href,origin,[root]));
  }
  assert.equal(safeDavUrl(root+'personal/',origin,[root]),origin+root+'personal/');
});

test('calendar/files refresh preserves prior email insights and their original analysis time',async()=>{
  const app=await makeTestApp({workspaceReader:async({includeEmail})=>({calendars:[],events:[],files:[{id:'file',name:'Brief.txt'}],storage:{},emails:includeEmail?[{id:'email',name:'Request'}]:[],actions:includeEmail?[{id:'action',emailId:'email',name:'Please review'}]:[],mentions:includeEmail?[{emailId:'email',target:'file'}]:[],emailAnalyzed:includeEmail,syncedAt:includeEmail?'2026-09-12T01:00:00Z':'2026-09-12T02:00:00Z'})});
  try{
    const a=await signup(app,'keep@example.test');const uid=(await request(app.base,'/api/auth/me',{cookie:a.sessionCookie})).json.user.id;const now=new Date().toISOString();
    app.db.prepare('INSERT INTO mailboxes (id,tenant_id,domain_id,address,local_part,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run('mb',uid,'dom_hosted','keep@example.test','keep','created',now,now);
    const sync=(includeEmail)=>request(app.base,'/api/workspace/knowledge/sync',{method:'POST',cookie:a.sessionCookie,origin:app.base,body:{mailboxId:'mb',password:'mailbox-password',includeEmail}});
    assert.equal((await sync(true)).status,200);const refreshed=await sync(false);assert.equal(refreshed.status,200);
    assert.equal(refreshed.json.item.emails.length,1);assert.equal(refreshed.json.item.actions.length,1);assert.equal(refreshed.json.item.mentions.length,1);assert.equal(refreshed.json.item.emailSyncedAt,'2026-09-12T01:00:00Z');assert.equal(refreshed.json.item.syncedAt,'2026-09-12T02:00:00Z');
  }finally{await app.close();}
});

const xml = (rows) => `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${rows.map(([href,props]) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join('')}</d:multistatus>`;
test('DAV and IMAP sync reads bounded own-account metadata, preserves Unicode and never stores bodies or descriptions', async () => {
  const address='demo@example.test'; const root='/cloud/remote.php/dav/'; let opened,loggedOut=false;
  const fetchImpl=async(url,opts) => {
    assert.equal(opts.redirect,'error'); assert.ok(['PROPFIND','REPORT'].includes(opts.method));
    assert.ok(url.startsWith('https://mailserver.test/cloud/remote.php/dav/'));
    let rows;
    if(url.includes('/files/')) rows=[[root+'files/demo%40example.test/','<d:resourcetype><d:collection/></d:resourcetype><d:quota-used-bytes>200</d:quota-used-bytes>'],[root+'files/demo%40example.test/Brief.txt','<d:displayname>Brief.txt</d:displayname><d:getcontentlength>20</d:getcontentlength>']];
    else if(opts.method==='REPORT') {
      assert.ok(!opts.body.includes('DESCRIPTION'));
      rows=[[root+'calendars/demo%40example.test/personal/1.ics','<c:calendar-data>BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:1\nSUMMARY:Réunion Workspace\nDTSTART;TZID=America/Los_Angeles:20260912T170000\nDESCRIPTION:private event description\nEND:VEVENT\nEND:VCALENDAR</c:calendar-data>']];
    } else rows=[[root+'calendars/demo%40example.test/personal/','<d:displayname>Personal</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype>']];
    return new Response(xml(rows),{status:207});
  };
  const imapFactory=() => ({on(){},async connect(){},async mailboxOpen(name,opts){opened={name,...opts};return{exists:1,uidValidity:1};},async *fetch(){yield{uid:7,size:100};},async fetchOne(){return{source:Buffer.from('From: sender@example.test\r\nSubject: Review\r\nDate: Sat, 12 Sep 2026 12:00:00 +0000\r\n\r\nPlease review Brief.txt by Friday.\nUnrelated private body sentence.')};},async logout(){loggedOut=true;},close(){}});
  const result=await readWorkspaceSources({config:makeConfig(),address,password:'never-save',fetchImpl,imapFactory,includeEmail:true});
  assert.equal(result.events[0].name,'Réunion Workspace');assert.equal(result.files[0].sizeBytes,20);assert.equal(result.storage.usedBytes,200);
  assert.equal(result.actions.length,1); assert.equal(result.mentions.length,1);assert.deepEqual(opened,{name:'INBOX',readOnly:true});assert.equal(loggedOut,true);
  assert.ok(!JSON.stringify(result).includes('private event description'));assert.ok(!JSON.stringify(result).includes('Unrelated private body'));assert.ok(!JSON.stringify(result).includes('never-save'));
});

test('workspace sync gates ownership before reads, isolates snapshots, preserves data on errors and deletes snapshots', async () => {
  let reads=0,shouldFail=false;
  const data={calendars:[],events:[],files:[],emails:[],actions:[],mentions:[],storage:{},syncedAt:new Date().toISOString()};
  const app=await makeTestApp({workspaceReader:async()=>{reads++;if(shouldFail)throw new Error('private-password');return data;}});
  try {
    const a=await signup(app,'a@example.test'),b=await signup(app,'b@example.test');
    const user=(await request(app.base,'/api/auth/me',{cookie:a.sessionCookie})).json.user;
    const now=new Date().toISOString();
    app.db.prepare("INSERT INTO mailboxes (id,tenant_id,domain_id,address,local_part,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run('mb',user.id,'dom_hosted','a@example.test','a','created',now,now);
    const sync=(cookie)=>request(app.base,'/api/workspace/knowledge/sync',{method:'POST',cookie,origin:app.base,body:{mailboxId:'mb',password:'private-password'}});
    assert.equal((await sync(b.sessionCookie)).status,404);assert.equal(reads,0);
    assert.equal((await sync(a.sessionCookie)).status,200);assert.equal(reads,1);
    assert.equal((await request(app.base,'/api/workspace/knowledge',{cookie:b.sessionCookie})).json.items.length,0);
    shouldFail=true;const bad=await sync(a.sessionCookie);assert.equal(bad.status,502);assert.ok(!JSON.stringify(bad.json).includes('private-password'));
    assert.equal(createSnapshotBuilder({db:app.db})(user.id).workspace.length,1);
    await request(app.base,'/api/workspace/knowledge/mb',{method:'DELETE',cookie:a.sessionCookie,origin:app.base});
    assert.equal(createSnapshotBuilder({db:app.db})(user.id).workspace.length,0);
  } finally {await app.close();}
});

test('Neo4j projection connects workspace, calendar, files and email suggestions with tenant-scoped IDs', async()=>{
  const calls=[];const graph=createGraphService({config:makeConfig(),logger:captureLogger(),driverFactory:()=>({async verifyConnectivity(){},session(){return{async run(cypher,params){calls.push({cypher,params});return{records:[]};},async close(){}};},async close(){}})});
  try {
    await graph.project('tenant',{domains:[{id:'d',name:'domain'}],mailboxes:[{id:'m',domain_id:'d',address:'a@domain'}],records:[],checks:[],actions:[],workspace:[{mailboxId:'m',domainId:'d',data:{syncedAt:'now',storage:{usedBytes:10},calendars:[{id:'c',name:'Personal'}],events:[{id:'e',calendarId:'c',name:'Review'}],files:[{id:'f',name:'Brief.txt'}],emails:[{id:'mail',name:'Request'}],actions:[{id:'a',emailId:'mail',name:'Review brief'}],mentions:[{emailId:'mail',target:'f'}]}}]});
    const nodes=calls.find((c)=>c.params.nodes)?.params.nodes;
    for(const label of ['Workspace','Calendar','Event','Storage','File','Email','Commitment']) assert.ok(nodes.some((n)=>n.label===label));
    const relations=calls.flatMap((c)=>c.params.rels||[]);for(const type of ['HAS_WORKSPACE','USES','CONTAINS','SUGGESTS','POSSIBLY_REFERENCES'])assert.ok(relations.some((r)=>r.type===type));
    for(const n of nodes)assert.ok(n.id.startsWith('t:tenant:'));for(const r of relations)assert.ok(r.from.startsWith('t:tenant:'));
  }finally{await graph.close();}
});
