import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentService } from '../server/services/agent.js';
import { makeConfig } from './helpers.js';

function service({ kind = 'custom', dkim = 'warn', graphAvailable = true } = {}) {
  const checks = ['ownership', 'mx', 'spf', 'dkim', 'dmarc'].map(scope => ({
    scope, status: scope === 'dkim' ? dkim : 'pass',
    details: scope === 'dkim' ? { summary: 'Published DKIM does not match the mail server signing key.' } : {}
  }));
  const detail = {domain:{name:'example.test',kind,status:kind === 'hosted' ? 'managed' : 'verified',verifiedAt:'2026-09-12'},mailboxes:[{address:'hello@example.test',status:'created'}],plan:null};
  return createAgentService({db:{prepare:()=>({run(){}})},config:makeConfig(),logger:{warn(){}},domainService:{
    getDomainDetail:()=>detail,
    inspectDomain:async()=>({ok:true,checks,delivery:{inbound:'unknown',outbound:'unknown'}})
  },graph:{status:()=>({enabled:graphAvailable,available:graphAvailable,degraded:false}),blockers:async()=>dkim === 'pass' ? [] : [{scope:'dkim',type:'TXT',state:'mismatch',dependentMailboxes:['hello@example.test']}]}});
}

test('assistant does not recommend activation when DKIM fails despite passing MX and SPF',async()=>{
  const r=await service().runAgent({tenantId:'tenant',domainId:'domain',question:'Can I activate?'});
  assert.equal(r.ok,true);
  assert.equal(r.suggestions.some(x=>x.id==='activate_domain'),false);
  assert.match(r.answer,/Published DKIM does not match/);
  assert.equal(r.steps.find(x=>x.tool==='find_blockers').source,'graph');
});
test('shared-domain DNS problems direct user to operator without proposing tenant DNS writes',async()=>{
  const r=await service({kind:'hosted'}).runAgent({tenantId:'tenant',domainId:'domain'});
  assert.ok(r.suggestions.some(x=>x.id==='review_managed_dns'));
  assert.equal(r.suggestions.some(x=>x.id==='apply_dns_plan'),false);
});
test('pending checks remain visible as blockers when graph is unavailable',async()=>{
  const r=await service({graphAvailable:false,dkim:'pending'}).runAgent({tenantId:'tenant',domainId:'domain'});
  assert.ok(r.blockers.some(x=>x.scope==='dkim'&&x.state==='pending'));
  assert.equal(r.suggestions.some(x=>x.id==='activate_domain'),false);
});
