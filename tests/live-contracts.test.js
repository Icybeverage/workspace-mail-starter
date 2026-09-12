import test from 'node:test';
import assert from 'node:assert/strict';
import {createMailServerClient} from '../server/services/mailserver.js';
import {normalizeMailServerDump,mergeSpf,buildDnsPlan} from '../server/services/dns.js';
import {createCloudflareClient} from '../server/services/cloudflare.js';

test('MAIL_SERVER grouped users prevent existing mailbox takeover',async()=>{
 const mailserver=createMailServerClient({config:{mailserver:{baseUrl:'https://mail.invalid/admin',username:'test',password:'test',timeoutMs:1000}},fetchImpl:async()=>new Response(JSON.stringify([{domain:'example.com',users:[{email:'owner@example.com',privileges:['admin']}]}]))});
 assert.equal((await mailserver.userExists('owner@example.com')).exists,true);
});
test('MAIL_SERVER nested DNS dump excludes website and child-domain mail routing from desired mail records',()=>{
 const parsed=normalizeMailServerDump([['example.com',[{qname:'example.com',rtype:'MX',value:'10 mail.example.com.'},{qname:'child.example.com',rtype:'MX',value:'10 other.example.com.'},{qname:'mail._domainkey.example.com',rtype:'TXT',value:'v=DKIM1; p=public'}]]],'example.com');
 assert.equal(parsed.records.length,2);assert.equal(parsed.supported,true);
});
test('SPF refuses an early all or negative mechanism',()=>{
 assert.equal(mergeSpf(['v=spf1 -all include:sender.example'],'v=spf1 mx -all').ok,false);
 assert.equal(mergeSpf(['v=spf1 -mx -all'],'v=spf1 mx -all').ok,false);
});
test('Cloudflare adds SPF alongside unrelated TXT, preserving verification',async()=>{
 const writes=[];
 const fetchImpl=async(url,opts)=>{
  if(opts.method==='GET')return new Response(JSON.stringify({success:true,result:[{id:'verify',type:'TXT',name:'example.com',content:'google-site-verification=keep',ttl:300}],result_info:{total_pages:1}}));
  writes.push({url,method:opts.method,body:JSON.parse(opts.body)});return new Response(JSON.stringify({success:true,result:{id:'new'}}));
 };
 const cf=createCloudflareClient({config:{cloudflareApiBase:'https://api.cloudflare.com/client/v4'},fetchImpl});
 const res=await cf.applyOperations('fake-token','zone','example.com',[{key:'spf:@',name:'@',type:'TXT',action:'create',proposed:'v=spf1 mx -all'}]);
 assert.equal(res.ok,true);assert.equal(writes.length,1);assert.equal(writes[0].method,'POST');
});
test('Cloudflare updates the SPF record only, not another TXT at the apex',async()=>{
 const writes=[];
 const cf=createCloudflareClient({config:{cloudflareApiBase:'https://api.cloudflare.com/client/v4'},fetchImpl:async(url,opts)=>{
  if(opts.method==='GET')return new Response(JSON.stringify({success:true,result:[{id:'spf',type:'TXT',name:'example.com',content:'v=spf1 -all',ttl:300},{id:'verify',type:'TXT',name:'example.com',content:'keep',ttl:300}],result_info:{total_pages:1}}));
  writes.push(url);return new Response(JSON.stringify({success:true,result:{id:'spf'}}));
 }});
 await cf.applyOperations('fake','zone','example.com',[{key:'spf:@',name:'@',type:'TXT',action:'update',proposed:'v=spf1 mx -all'}]);
 assert.deepEqual(writes,['https://api.cloudflare.com/client/v4/zones/zone/dns_records/spf']);
});
test('Cloudflare ownership TXT uses fully qualified name exactly once',async()=>{
 let body;
 const cf=createCloudflareClient({config:{cloudflareApiBase:'https://api.cloudflare.com/client/v4'},fetchImpl:async(url,opts)=>{
  if(opts.method==='GET')return new Response(JSON.stringify({success:true,result:[]}));
  body=JSON.parse(opts.body);return new Response(JSON.stringify({success:true,result:{id:'v'}}));
 }});
 await cf.applyOperations('fake','zone','example.com',[{key:'verify:dns_txt',name:'_workspace-verify.example.com',type:'TXT',action:'create',proposed:'workspace-verify=proof'}]);
 assert.equal(body.name,'_workspace-verify.example.com');
});
