import React, { useEffect, useRef, useState } from 'react';
import { apiBase } from '../api.js';
import { Banner, Chip, Spinner } from './Bits.jsx';
import { fmtDateTime } from '../util.js';

const LABELS = {Domain:'Domain', Mailbox:'Mailbox', DNSRecord:'DNS record', Check:'Check'};
const GOOD = new Set(['pass','configured','managed','created','active']);

function EvidenceGraph({ graph }) {
  const [selected, setSelected] = useState(null);
  if (!graph?.nodes?.length) return <div className="investigation-graph-empty">The dependency map appears when Neo4j returns your domain relationships.</div>;
  const domain = graph.nodes.find(n => n.type === 'Domain');
  const records = graph.nodes.filter(n => n.type === 'DNSRecord').slice(0,6);
  const mailboxes = graph.nodes.filter(n => n.type === 'Mailbox').slice(0,2);
  const nodes = [domain, ...records, ...mailboxes].filter(Boolean);
  const positions = new Map();
  if(domain) positions.set(domain.id,{x:330,y:125,w:220});
  records.forEach((n,i)=>positions.set(n.id,{x:i<3?20:670,y:25+(i%3)*105,w:190}));
  mailboxes.forEach((n,i)=>positions.set(n.id,{x:mailboxes.length===1?310:200+i*270,y:310,w:260}));
  const related = new Set([selected]);
  for(const e of graph.edges || [])if(e.from===selected||e.to===selected){related.add(e.from);related.add(e.to);}
  const chosen=nodes.find(n=>n.id===selected);
  const name=n=>n.address||n.name||n.type;
  return <>
    <div className="investigation-map-scroll">
      <svg className="investigation-map" viewBox="0 0 880 390" role="group" aria-label="Live Neo4j domain dependencies">
        {(graph.edges||[]).map((e,i)=>{
          const a=positions.get(e.from),b=positions.get(e.to);if(!a||!b)return null;
          return <path key={i} className={`investigation-connection ${selected&&(e.from===selected||e.to===selected)?'highlight':''}`} d={`M${a.x+a.w/2},${a.y+29} C${a.x+a.w/2},${(a.y+b.y)/2+29} ${b.x+b.w/2},${(a.y+b.y)/2+29} ${b.x+b.w/2},${b.y+29}`}><title>{e.type.replaceAll('_',' ').toLowerCase()}</title></path>;
        })}
        {nodes.map(n=>{const p=positions.get(n.id);const state=n.state||n.status||'unknown';const label=name(n);return <g key={n.id} role="button" tabIndex={0} aria-label={`Inspect ${LABELS[n.type]} ${label}`} aria-pressed={selected===n.id} className={`investigation-node ${n.type==='Domain'?'domain':''} ${selected===n.id?'selected':''}`} style={{opacity:selected&&!related.has(n.id)?.4:1}} onClick={()=>setSelected(n.id)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();setSelected(n.id);}}}>
          <title>{label}</title><rect x={p.x} y={p.y} width={p.w} height={60} rx="12"/>
          <circle cx={p.x+16} cy={p.y+19} r="3" fill={GOOD.has(state)?'#66deb9':'#f5c577'}/>
          <text x={p.x+26} y={p.y+23} className="map-kind">{n.dnsType||LABELS[n.type]}</text>
          <text x={p.x+13} y={p.y+44} className="map-label">{label.length>(p.w===190?24:32)?label.slice(0,p.w===190?23:31)+'…':label}</text>
        </g>})}
      </svg>
    </div>
    <div className="investigation-selection">{chosen?<><strong>{name(chosen)}</strong><span>{LABELS[chosen.type]} · {chosen.state||chosen.status||'Status unavailable'}</span></>:<span>Select a node to highlight its real dependencies.</span>}</div>
  </>;
}

export default function InvestigationPanel({ domainId, domainName }) {
  const [steps,setSteps]=useState([]),[result,setResult]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const controller=useRef(null);
  useEffect(()=>{setSteps([]);setResult(null);setError('');setBusy(false);return ()=>{controller.current?.abort();controller.current=null;};},[domainId]);
  async function run(){
    controller.current?.abort();const current=new AbortController();controller.current=current;
    setSteps([]);setResult(null);setError('');setBusy(true);
    let completed=false;
    const receive=line=>{
      if(!line.trim()||controller.current!==current)return;
      const event=JSON.parse(line);
      if(event.type==='step')setSteps(prev=>{const index=prev.findIndex(s=>s.id===event.step.id);return index<0?[...prev,event.step]:prev.map((s,i)=>i===index?event.step:s);});
      if(event.type==='error')throw new Error(event.message||'The investigation could not finish.');
      if(event.type==='result'){
        if(!event.result?.ok)throw new Error(event.result?.message||'The investigation could not finish.');
        completed=true;setResult(event.result);if(event.result.steps)setSteps(event.result.steps);
      }
    };
    const timeout=setTimeout(()=>current.abort(new Error('Investigation timed out. Try again.')),90000);
    try{
      const response=await fetch(`${apiBase()}api/agent/investigate`,{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({domainId}),signal:current.signal});
      if(!response.ok){const data=await response.json().catch(()=>null);throw new Error(data?.error?.message||`Unable to investigate (${response.status}).`);}
      if(!response.body)throw new Error('Streaming is unavailable. Please try again.');
      const reader=response.body.getReader(),decoder=new TextDecoder();let pending='';
      while(true){const {value,done}=await reader.read();if(done)break;pending+=decoder.decode(value,{stream:true});let newline;while((newline=pending.indexOf('\n'))!==-1){receive(pending.slice(0,newline));pending=pending.slice(newline+1);}}
      pending+=decoder.decode();receive(pending);if(!completed)throw new Error('Connection ended before the investigation finished.');
    }catch(err){if(controller.current===current){setError(current.signal.aborted?'Investigation stopped. You can run it again.':err.message);setSteps(prev=>prev.map(s=>s.status==='running'?{...s,status:'error',summary:'Stopped before this check completed.'}:s));}}
    finally{clearTimeout(timeout);if(controller.current===current)setBusy(false);}
  }
  const running=steps.find(s=>s.status==='running');
  return <section className="investigation-panel" aria-label="Workspace Mail investigation">
    <div className="investigation-header">
      <div><div className="investigation-eyebrow"><span className="investigation-signal"/> WORKSPACE MAIL · OPERATIONS</div><h2>Understand your email infrastructure.</h2><p>Follow the evidence. See what needs attention. Stay in control.</p></div>
      <button className="btn btn-primary investigation-run" onClick={run} disabled={busy} aria-busy={busy}>{busy?<Spinner label="Investigating…"/>:result?'Run again ↗':'Investigate domain ↗'}</button>
    </div>
    <div className="investigation-toolbar"><span className="mono">{domainName}</span><div className="row-tight"><Chip tone="info">Adaptive rules</Chip><span>Checks and graph reads · no infrastructure changes</span></div></div>
    {error?<Banner tone="bad">{error}</Banner>:null}
    <div className="investigation-body">
      <div className="investigation-trace"><div className="investigation-label">INVESTIGATION TRAIL</div>
        {!steps.length?<div className="investigation-intro"><span className="investigation-orbit">⌁</span><h3>Every answer starts with evidence.</h3><p>Inspect live DNS, trace mailbox dependencies, and distinguish setup health from delivery proof.</p><span>Next checks adapt to the findings.</span></div>:<ol aria-label="Investigation steps">{steps.map((s,i)=><li key={s.id} className={`investigation-step ${s.status}`}><div className="investigation-step-marker">{s.status==='running'?<span className="spin"/>:s.status==='complete'?'✓':s.status==='warning'?'!':s.status==='error'?'×':i+1}</div><div><strong>{s.title}</strong><p>{s.summary}</p><span>{s.status==='running'?'In progress':fmtDateTime(s.at)}</span></div></li>)}</ol>}
        <div className="sr-only" role="status" aria-live="polite">{running?.title||result?.headline||''}</div>
      </div>
      <div className="investigation-evidence"><div className="investigation-label">CONNECTED EVIDENCE <span>{result?.graphSource==='neo4j'?'NEO4J · LIVE READ':busy?'READING…':'DOMAIN → DNS → MAILBOX'}</span></div>
        <EvidenceGraph key={domainId+(result?.finishedAt||'')} graph={result?.graph}/>
        <div className="investigation-checks">{(result?.checks||[]).map(c=><div className={`investigation-check ${GOOD.has(c.status)?'good':'attention'}`} key={c.scope}><span>{c.scope.toUpperCase()}</span><strong>{c.status}</strong></div>)}</div>
        {result?<div className={`investigation-outcome ${result.outcome}`}><div className="investigation-label">{result.outcome==='verified'?'VERIFIED EVIDENCE':result.outcome==='attention'?'NEEDS ATTENTION':'DELIVERY EVIDENCE NEEDED'}</div><h3>{result.headline}</h3><p>{result.summary}</p><div className="investigation-delivery"><span>Inbound <strong>{result.delivery?.inbound||'unknown'}</strong></span><span>Outbound <strong>{result.delivery?.outbound||'unknown'}</strong></span></div>{result.nextActions?.map(a=><div className="investigation-action" key={a.id}><span>↗</span><div><strong>{a.title}</strong><p>{a.detail}</p></div></div>)}</div>:<div className="investigation-idle"><span>01 · Observe</span><span>02 · Trace</span><span>03 · Verify</span></div>}
      </div>
    </div>
    <div className="investigation-footer"><span>{result?`Checked ${fmtDateTime(result.finishedAt)}`:'Uses your account’s domain and mailbox access.'}</span><span>Rule-based investigation · You control the next action</span></div>
  </section>;
}
