// Bounded adaptive policy: tool choices follow observed DNS and graph evidence.
// No model-generated commands, provider writes, or message sends.
export function createInvestigator({ domainService, graph }) {
  return async function investigate({ tenantId, domainId, onEvent = () => {}, signal }) {
    const checkAbort = () => { if (signal?.aborted) throw new Error('Investigation cancelled'); };
    checkAbort();
    const detail = domainService.getDomainDetail(tenantId, domainId);
    if (detail.error) return { ok:false, ...detail.error };
    const startedAt = new Date().toISOString();
    const steps = [];
    const owned = new Set(detail.mailboxes.map(m => m.address));
    let hadError = false;
    function emit(id, title, status, summary) {
      checkAbort();
      const step = { id, title, status, summary, at:new Date().toISOString() };
      const index = steps.findIndex(s => s.id === id);
      if (index < 0) { if (steps.length >= 12) throw new Error('Step limit reached'); steps.push(step); }
      else steps[index] = step;
      onEvent({ type:'step', step });
    }
    async function tool(id, title, summary, fn) {
      emit(id,title,'running',summary);
      try { const value = await fn(); checkAbort(); return value; }
      catch { checkAbort(); hadError = true; emit(id,title,'error','This check could not complete. Its result remains unknown.'); return null; }
    }
    emit('domain','Read domain scope','complete',`${detail.domain.name}: ${owned.size} mailbox${owned.size === 1 ? '' : 'es'} in your account.`);
    const inspection = await tool('dns','Inspect live DNS','Reading current DNS and mail-server configuration.', async () => {
      const r = await domainService.inspectDomain({tenantId,domainId,persist:false});
      if (!r.ok) throw new Error('DNS inspection unavailable');
      return r;
    });
    const checks = (inspection?.checks || []).map(c => ({scope:c.scope,status:c.status}));
    const dnsProblems = checks.filter(c => !['pass','managed'].includes(c.status));
    // Missing checks are not a clean bill of health.
    const dnsPass = ['ownership','mx','spf','dkim','dmarc'].every(scope => checks.some(c => c.scope === scope && ['pass','managed'].includes(c.status)));
    if (inspection) emit('dns','Inspect live DNS',dnsPass?'complete':'warning',dnsPass?'Ownership, MX, SPF, DKIM and DMARC checks pass.':`${dnsProblems.length || 'Some'} setup checks need attention. ${dnsProblems.map(c=>`${c.scope.toUpperCase()}: ${c.status}`).join(' · ')}`);
    let graphData = await tool('dependencies','Read Neo4j dependencies','Tracing the domain, DNS records and mailbox relationships.',async()=>{
      const data = await graph.getDomainGraph(tenantId,domainId);
      if (data.degraded) throw new Error('Graph degraded');
      // Defense in depth in addition to the scoped Cypher query.
      const nodes=data.nodes.filter(n=>n.tenantId===tenantId&&(n.type!=='Mailbox'||owned.has(n.address)));
      const ids=new Set(nodes.map(n=>n.id));
      return {nodes,edges:data.edges.filter(e=>ids.has(e.from)&&ids.has(e.to))};
    });
    if (graphData) emit('dependencies','Read Neo4j dependencies','complete',`${graphData.nodes.length} nodes and ${graphData.edges.length} relationships read from Neo4j. DNS status above is from this live check; graph statuses are saved snapshots.`);
    const affected = new Set();
    if (dnsProblems.length && graphData) {
      const blockers = await tool('blockers','Choose an impact investigation','DNS needs attention, so trace the records that may affect delivery.',()=>graph.blockers(tenantId,domainId));
      if (blockers) {
        const records = blockers.filter(b=>b.recordId).slice(0,3);
        emit('blockers','Choose an impact investigation',records.length?'warning':'complete',records.length?`${records.length} graph blocker${records.length===1?'':'s'} selected for mailbox impact tracing.`:'The saved graph has no blocking records. Use the current DNS findings to review your configuration.');
        for (let i=0;i<records.length;i++) {
          const b=records[i];
          const impact=await tool(`impact-${i}`,'Trace affected mailboxes',`Following dependencies for ${b.scope || b.type || 'DNS'}.`,()=>graph.impact(tenantId,b.recordId));
          if (impact) {
            const addresses=impact.map(m=>m.address).filter(a=>owned.has(a));addresses.forEach(a=>affected.add(a));
            emit(`impact-${i}`,'Trace affected mailboxes',addresses.length?'warning':'complete',addresses.length?`${addresses.length} of your mailbox${addresses.length===1?'':'es'} depend on this record.`:'No mailbox in your account was returned for this record.');
          }
        }
      }
    } else if (dnsPass) emit('decision','Choose the next check','complete','DNS checks pass. Skip repair tracing and review message-delivery evidence.');
    const state = value => ['pass','fail'].includes(value) ? value : 'unknown';
    const delivery = {inbound:state(inspection?.delivery?.inbound),outbound:state(inspection?.delivery?.outbound)};
    const deliveryPass = delivery.inbound==='pass'&&delivery.outbound==='pass';
    emit('delivery','Review delivery evidence',deliveryPass?'complete':'warning',deliveryPass?'Stored inbound and outbound delivery checks pass.':`Inbound: ${delivery.inbound}. Outbound: ${delivery.outbound}. DNS configuration alone does not prove message delivery. No test email was sent by this investigation.`);
    const outcome=hadError||!dnsPass||delivery.inbound==='fail'||delivery.outbound==='fail'?'attention':deliveryPass?'verified':'unverified';
    const headline=hadError?'Some evidence is unavailable.':!dnsPass?'Your configuration needs attention.':deliveryPass?'Configuration and delivery evidence pass.':'Configuration passes. Delivery needs evidence.';
    const nextActions=[];
    if (hadError) nextActions.push({id:'retry',title:'Retry unavailable checks',detail:'A failed tool is not a passing result. Retry when the service is available.'});
    if (!dnsPass && inspection) nextActions.push({id:'review_dns',title:detail.domain.kind==='hosted'?'Ask the operator to review DNS':'Review your DNS plan',detail:'Compare current findings with the reviewed plan before making any changes. This investigation has not changed DNS.'});
    if (!deliveryPass) nextActions.push({id:'verify_delivery',title:'Verify a real message round trip',detail:'Use a controlled test address and review inbound and outbound receipts. External receipts are not automatically imported here.'});
    if (!nextActions.length) nextActions.push({id:'monitor',title:'Keep evidence current',detail:'Run a new investigation after domain or provider configuration changes.'});
    emit('conclusion','Summarize evidence',outcome==='verified'?'complete':'warning',headline);
    return {ok:true,mode:'rule_based',domain:{id:domainId,name:detail.domain.name},steps,checks,graph:graphData,graphSource:graphData?'neo4j':'unavailable',affectedMailboxes:[...affected],delivery,outcome,headline,summary:outcome==='verified'?'All required checks and stored delivery evidence pass.':dnsPass?'Your domain is configured. Confirm actual delivery separately before treating the mailbox as fully verified.':'Review the evidence and next steps below. Missing or failed checks stay visible.',nextActions,startedAt,finishedAt:new Date().toISOString()};
  };
}
