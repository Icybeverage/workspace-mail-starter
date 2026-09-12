import crypto from 'node:crypto';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

const arr = (v) => v == null ? [] : Array.isArray(v) ? v : [v];
const str = (v) => typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
const short = (v, n = 240) => str(v).slice(0, n);
const id = (value) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 24);
const parser = new XMLParser({ removeNSPrefix: true, ignoreAttributes: false, parseTagValue: false, processEntities: true });
export function safeDavUrl(resource, origin, roots) {
  const url = new URL(resource,origin);
  const decoded = decodeURIComponent(url.pathname);
  if (url.origin !== origin || url.username || url.password || url.search || url.hash || /[\\\0]|%[0-9a-f]{2}/i.test(decoded)
    || path.posix.normalize(decoded) !== decoded || !roots.some((root) => decoded.startsWith(decodeURIComponent(root)))) {
    throw new Error('DAV resource outside account');
  }
  return url.href;
}
export function davRows(xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Unsupported DAV document');
  return arr(parser.parse(xml)?.multistatus?.response).map((r) => ({
    href: str(r.href),
    props: Object.assign({}, ...arr(r.propstat).filter((p) => /\s200\s/.test(str(p.status))).map((p) => p.prop || {}))
  }));
}

export function analyzeMessage(text, resources = []) {
  // Suggestions only: quoted replies and signatures are excluded. Never run
  // instructions from mail or send its contents to an external model.
  const body = String(text || '').slice(0, 24000).split(/\n(?:On .+wrote:|--\s*$)/m)[0]
    .split('\n').filter((line) => !line.trim().startsWith('>')).join('\n');
  const actions = body.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) =>
    /\b(please|could you|can you|need to|must|i will|i'll|we will|we'll|due|deadline)\b/i.test(s)
    && !/\b(no (?:reply|action)|do not|don't|not required|password|secret|token|api key)\b/i.test(s)).slice(0, 8)
    .map((sentence) => ({ name: short(sentence, 220), evidence: short(sentence, 400),
      deadlineText: short(sentence.match(/\b(?:by|due|before|deadline(?: is)?)\s+([^.!?\n]{1,80})/i)?.[0] || '', 100),
      status: 'suggested', method: 'rule_based', confidence: 'needs_review' }));
  const mentions = resources.filter((r) => r.name?.length >= 5 && body.toLowerCase().includes(r.name.toLowerCase()))
    .map((r) => ({ target: r.id, basis: 'exact_title_mention', confidence: 'needs_review' }));
  return { actions, mentions };
}

function icalEvents(raw) {
  const unfolded = String(raw || '').replace(/\r?\n[ \t]/g, '');
  return [...unfolded.matchAll(/BEGIN:VEVENT\r?\n([\s\S]*?)END:VEVENT/g)].map((match) => {
    const fields = {};
    for (const line of match[1].split(/\r?\n/)) {
      const at = line.indexOf(':');
      if (at < 0) continue;
      const left = line.slice(0, at);
      const key = left.split(';')[0];
      if (['UID','SUMMARY','DTSTART','DTEND','RECURRENCE-ID','RRULE'].includes(key)) fields[key] = line.slice(at + 1);
      if (key === 'DTSTART') fields.timezone = left.match(/TZID=([^;]+)/)?.[1] || (line.endsWith('Z') ? 'UTC' : 'floating/date');
    }
    return fields;
  });
}

export async function readWorkspaceSources({ config, address, password, fetchImpl = fetch, imapFactory = (opts) => new ImapFlow(opts), includeEmail = false }) {
  const origin = new URL(config.mailserver.baseUrl).origin;
  if (!origin.startsWith('https://')) throw new Error('Workspace requires HTTPS');
  const user = encodeURIComponent(address);
  const calendarRoot = `/cloud/remote.php/dav/calendars/${user}/`;
  const filesRoot = `/cloud/remote.php/dav/files/${user}/`;
  const authorization = 'Basic ' + Buffer.from(`${address}:${password}`).toString('base64');
  async function dav(path, method, body) {
    const url = safeDavUrl(path,origin,[calendarRoot,filesRoot]);
    const response = await fetchImpl(url, { method, headers: { Authorization: authorization, Depth: '1', 'Content-Type': 'application/xml' }, body, redirect: 'error', signal: AbortSignal.timeout(12000) });
    if (response.status !== 207) throw new Error(`Workspace source returned HTTP ${response.status}`);
    let xml = '';
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) { xml += decoder.decode(); break; }
        xml += decoder.decode(value,{stream:true});
        if (Buffer.byteLength(xml) > 2_000_000) throw new Error('Workspace listing exceeds sync limit');
      }
    } finally { await reader.cancel().catch(() => {}); }
    return davRows(xml);
  }
  const propfind = (props) => `<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop>${props}</d:prop></d:propfind>`;
  const [calRows, fileRows] = await Promise.all([
    dav(calendarRoot,'PROPFIND',propfind('<d:displayname/><d:resourcetype/>')),
    dav(filesRoot,'PROPFIND',propfind('<d:displayname/><d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:quota-used-bytes/><d:quota-available-bytes/>'))
  ]);
  const result = { calendars: [], events: [], files: [], emails: [], actions: [], mentions: [], syncedAt: new Date().toISOString(), emailAnalyzed: includeEmail };
  const selected = calRows.filter((r) => r.props.resourcetype && Object.hasOwn(r.props.resourcetype,'calendar')).slice(0,3);
  const date = (ms) => new Date(ms).toISOString().replace(/[-:]/g,'').replace(/\.\d+Z$/,'Z');
  result.windowStart = date(Date.now() - 7 * 86400000); result.windowEnd = date(Date.now() + 30 * 86400000);
  for (const row of selected) {
    const calendarId = id(row.href);
    result.calendars.push({ id: calendarId, name: short(row.props.displayname) || 'Calendar' });
    const query = `<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-data><c:comp name="VCALENDAR"><c:comp name="VEVENT"><c:prop name="UID"/><c:prop name="SUMMARY"/><c:prop name="DTSTART"/><c:prop name="DTEND"/><c:prop name="RECURRENCE-ID"/><c:prop name="RRULE"/></c:comp></c:comp></c:calendar-data></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${result.windowStart}" end="${result.windowEnd}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
    const rows = await dav(row.href,'REPORT',query);
    for (const event of rows.flatMap((r) => icalEvents(r.props['calendar-data'])).slice(0,50)) {
      result.events.push({ id:id(calendarId+event.UID+(event['RECURRENCE-ID'] || '')),calendarId,name:short(event.SUMMARY) || 'Untitled event',start:short(event.DTSTART),end:short(event.DTEND),timezone:short(event.timezone),recurring:Boolean(event.RRULE) });
    }
  }
  const rootRow = fileRows.find((r) => decodeURIComponent(new URL(r.href,origin).pathname).replace(/\/$/,'') === decodeURIComponent(filesRoot).replace(/\/$/,''));
  const bytes = (v) => /^\d+$/.test(str(v)) && Number.isSafeInteger(Number(v)) ? Number(v) : null;
  result.storage = { usedBytes:bytes(rootRow?.props['quota-used-bytes']),availableBytes:bytes(rootRow?.props['quota-available-bytes']) };
  result.files = fileRows.filter((r) => r !== rootRow && !Object.hasOwn(r.props.resourcetype || {},'collection')).slice(0,200).map((r) => ({id:id(r.href),name:short(r.props.displayname) || short(decodeURIComponent(new URL(r.href,origin).pathname.split('/').pop())),sizeBytes:bytes(r.props.getcontentlength),modified:short(r.props.getlastmodified)}));
  result.limits = { calendars:3,eventsPerCalendar:50,files:200,fileScope:'root folder only',emails:20,maxEmailBytes:262144,calendarWindow:'past 7 and next 30 days; recurring series are not expanded' };
  if (includeEmail) {
    const client = imapFactory({ host:config.mailserver.mailHost,port:993,secure:true,auth:{user:address,pass:password},logger:false,connectionTimeout:10000,greetingTimeout:10000,socketTimeout:15000,disableAutoIdle:true });
    client.on?.('error', () => {});
    const deadline = setTimeout(() => client.close(),60000);
    try {
      await client.connect();
      const box = await client.mailboxOpen('INBOX',{readOnly:true});
      result.skippedLargeEmails = 0;
      if (box.exists) {
        const messages = [];
        for await (const msg of client.fetch(`${Math.max(1,box.exists - 19)}:*`,{uid:true,size:true})) messages.push(msg);
        for (const meta of messages) {
          if (meta.size > 262144) { result.skippedLargeEmails++; continue; }
          const msg = await client.fetchOne(meta.uid,{source:true},{uid:true});
          const mail = await simpleParser(msg.source,{skipHtmlToText:false,skipTextToHtml:true,maxHtmlLengthToParse:262144});
          const emailId = id(`${box.uidValidity}:${meta.uid}`);
          result.emails.push({id:emailId,name:short(mail.subject) || '(no subject)',sender:short(mail.from?.value?.[0]?.address),date:mail.date?.toISOString() || '',sourceUrl:`/mail/?_task=mail&_mbox=INBOX&_uid=${meta.uid}&_action=show`});
          const analysis = analyzeMessage(mail.text || '', [...result.events,...result.files]);
          for (const [index, action] of analysis.actions.entries()) result.actions.push({id:id(emailId+index),emailId,...action});
          for (const mention of analysis.mentions) result.mentions.push({emailId,...mention});
        }
      }
    } finally { clearTimeout(deadline); await client.logout().catch(() => client.close()); }
  }
  return result;
}
