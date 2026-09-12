import neo4j from 'neo4j-driver';

export class GraphUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GraphUnavailableError';
    this.code = 'graph_unavailable';
  }
}

const ENTITY_LABELS = ['Domain', 'Mailbox', 'DNSRecord', 'Check', 'SetupAction', 'Workspace', 'Calendar', 'Event', 'Storage', 'File', 'Email', 'Commitment'];

export function nodeId(tenantId, label, localId) {
  return `t:${tenantId}:${label}:${localId}`;
}

// Never project credential-looking fields into the graph.
export function pruneProps(props) {
  const out = {};
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined) continue;
    if (/password|token|secret|credential|key/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

export function createGraphService({ config, logger, driverFactory = null }) {
  let driver = null;
  let driverError = null;
  let availability = { enabled: hasConfig(), available: false, checkedAt: null, lastError: null };
  let queue = [];
  let flushing = false;
  let retryTimer = null;
  let flushPromise = null;
  const projectionStates = new Map();

  function hasConfig() {
    return Boolean(driverFactory || (config.neo4j.uri && config.neo4j.password));
  }

  function getDriver() {
    if (!hasConfig()) return null;
    if (!driver && !driverError) {
      try {
        driver = driverFactory
          ? driverFactory()
          : neo4j.driver(config.neo4j.uri, neo4j.auth.basic(config.neo4j.username, config.neo4j.password), {
            connectionTimeout: 5000,
            maxConnectionPoolSize: 4
          });
      } catch (err) {
        driverError = String(err && err.message);
      }
    }
    return driver;
  }

  async function checkAvailability({ force = false } = {}) {
    if (!hasConfig()) {
      availability = { enabled: false, available: false, checkedAt: new Date().toISOString(), lastError: 'NEO4J_URI/NEO4J_PASSWORD not configured' };
      return availability;
    }
    const fresh = availability.checkedAt && Date.now() - new Date(availability.checkedAt).getTime() < 15000;
    if (!force && fresh) return availability;
    const d = getDriver();
    if (!d) {
      availability = { enabled: true, available: false, checkedAt: new Date().toISOString(), lastError: driverError || 'driver unavailable' };
      return availability;
    }
    try {
      await d.verifyConnectivity();
      availability = { enabled: true, available: true, checkedAt: new Date().toISOString(), lastError: null };
    } catch (err) {
      availability = { enabled: true, available: false, checkedAt: new Date().toISOString(), lastError: String(err && err.message) };
    }
    return availability;
  }

  async function run(cypher, params = {}) {
    const d = getDriver();
    if (!d) throw new GraphUnavailableError('Neo4j is not configured.');
    const session = d.session({ defaultAccessMode: neo4j.session.WRITE, database: undefined });
    try {
      const res = await session.run(cypher, params);
      return res.records;
    } finally {
      await session.close();
    }
  }

  async function executeScoped(cypher, params) {
    if (params.tenantId === undefined || params.tenantId === null || params.tenantId === '') {
      throw new Error('graph query without tenantId is forbidden');
    }
    return run(cypher, params);
  }

  async function executeAtomic(operations) {
    if (!operations.length) return;
    const tenantId = operations[0].params?.tenantId;
    if (tenantId === undefined || tenantId === null || tenantId === '') {
      throw new Error('graph query without tenantId is forbidden');
    }
    const d = getDriver();
    if (!d) throw new GraphUnavailableError('Neo4j is not configured.');
    const session = d.session({ defaultAccessMode: neo4j.session.WRITE, database: undefined });
    try {
      if (typeof session.executeWrite === 'function') {
        await session.executeWrite(async (tx) => {
          for (const operation of operations) await tx.run(operation.cypher, operation.params);
        });
      } else {
        // Test doubles and older drivers may not expose executeWrite. Production
        // neo4j-driver does, so real snapshot writes remain one transaction.
        for (const operation of operations) await session.run(operation.cypher, operation.params);
      }
    } finally {
      await session.close();
    }
  }

  function rowValues(record, key) {
    const v = record.get(key);
    if (v && typeof v === 'object' && v.properties) return { id: v.properties.id, ...v.properties };
    return v;
  }

  function toPlain(v) {
    if (v === null || v === undefined) return v;
    if (neo4j.isInt(v)) return v.toNumber();
    if (Array.isArray(v)) return v.map(toPlain);
    if (typeof v === 'object' && v.properties) {
      const out = {};
      for (const [k, val] of Object.entries(v.properties)) out[k] = toPlain(val);
      return out;
    }
    return v;
  }

  async function projectSnapshot(tenantId, snapshot) {
    const now = new Date().toISOString();
    const operations = [{
      cypher: `MERGE (t:Tenant {id: $tenantId})
       SET t.tenantId = $tenantId, t.updatedAt = $now`,
      params: { tenantId, now }
    }];

    const nodes = [];
    const workspaceRels = [];
    for (const workspace of snapshot.workspace || []) {
      const { mailboxId, domainId, data } = workspace;
      const add = (label, local, props) => {
        const localId = `${mailboxId}:${local}`;
        const key = nodeId(tenantId,label,localId);
        nodes.push({id:key,label,tenantId,localId,props:{...props,domainId,mailboxId,syncedAt:data.syncedAt}});
        return key;
      };
      const link = (from,to,type) => workspaceRels.push({from,to,type});
      const root = add('Workspace','root',{name:'Connected workspace',status:'synced'});
      link(nodeId(tenantId,'Mailbox',mailboxId),root,'HAS_WORKSPACE');
      const storage = add('Storage','files',{name:'Files storage',...data.storage});
      link(root,storage,'USES');
      const resources = new Map();
      const calendars = new Map();
      for (const calendar of data.calendars) {
        const key = add('Calendar',calendar.id,{name:calendar.name});
        calendars.set(calendar.id,key); link(root,key,'USES');
      }
      for (const event of data.events) {
        const key = add('Event',event.id,{name:event.name,start:event.start,end:event.end,timezone:event.timezone,recurring:event.recurring});
        resources.set(event.id,key); link(calendars.get(event.calendarId),key,'CONTAINS');
      }
      for (const file of data.files) {
        const key = add('File',file.id,{name:file.name,sizeBytes:file.sizeBytes,modified:file.modified});
        resources.set(file.id,key); link(storage,key,'CONTAINS');
      }
      const emails = new Map();
      for (const email of data.emails) {
        const key = add('Email',email.id,{name:email.name,sender:email.sender,date:email.date,sourceUrl:email.sourceUrl});
        emails.set(email.id,key); link(nodeId(tenantId,'Mailbox',mailboxId),key,'CONTAINS');
      }
      for (const action of data.actions) {
        const key = add('Commitment',action.id,{name:action.name,evidence:action.evidence,deadlineText:action.deadlineText,status:'suggested',method:'rule_based',confidence:'needs_review'});
        link(emails.get(action.emailId),key,'SUGGESTS');
      }
      for (const mention of data.mentions) {
        if (emails.has(mention.emailId) && resources.has(mention.target)) link(emails.get(mention.emailId),resources.get(mention.target),'POSSIBLY_REFERENCES');
      }
    }
    for (const d of snapshot.domains) {
      nodes.push({
        id: nodeId(tenantId, 'Domain', d.id),
        label: 'Domain',
        tenantId,
        localId: d.id,
        props: { name: d.name, kind: d.kind, status: d.status, updatedAt: now }
      });
    }
    for (const m of snapshot.mailboxes) {
      nodes.push({
        id: nodeId(tenantId, 'Mailbox', m.id),
        label: 'Mailbox',
        tenantId,
        localId: m.id,
        props: { address: m.address, status: m.status, domainId: m.domain_id, updatedAt: now }
      });
    }
    for (const r of snapshot.records) {
      nodes.push({
        id: nodeId(tenantId, 'DNSRecord', r.localId),
        label: 'DNSRecord',
        tenantId,
        localId: r.localId,
        props: { domainId: r.domainId, name: r.name, dnsType: r.type, state: r.state, updatedAt: now }
      });
    }
    for (const c of snapshot.checks) {
      nodes.push({
        id: nodeId(tenantId, 'Check', c.localId),
        label: 'Check',
        tenantId,
        localId: c.localId,
        props: { domainId: c.domainId, scope: c.scope, status: c.status, checkedAt: c.checkedAt }
      });
    }
    for (const a of snapshot.actions) {
      nodes.push({
        id: nodeId(tenantId, 'SetupAction', a.id),
        label: 'SetupAction',
        tenantId,
        localId: a.id,
        props: { domainId: a.domain_id, kind: a.kind, status: a.status, targetCheck: a.target_check || null, updatedAt: now }
      });
    }

    operations.push({
      cypher: `UNWIND $nodes AS n
       MERGE (x:WorkspaceEntity {id: n.id, tenantId: $tenantId})
       SET x.tenantId = n.tenantId, x.localId = n.localId, x.entityLabel = n.label
       SET x += n.props
       FOREACH (_ IN CASE WHEN n.label = 'Domain' THEN [1] ELSE [] END | SET x:Domain)
       FOREACH (_ IN CASE WHEN n.label = 'Mailbox' THEN [1] ELSE [] END | SET x:Mailbox)
       FOREACH (_ IN CASE WHEN n.label = 'DNSRecord' THEN [1] ELSE [] END | SET x:DNSRecord)
       FOREACH (_ IN CASE WHEN n.label = 'Check' THEN [1] ELSE [] END | SET x:Check)
       FOREACH (_ IN CASE WHEN n.label = 'SetupAction' THEN [1] ELSE [] END | SET x:SetupAction)
       ${['Workspace','Calendar','Event','Storage','File','Email','Commitment'].map((label) => `FOREACH (_ IN CASE WHEN n.label = '${label}' THEN [1] ELSE [] END | SET x:${label})`).join('\n')}`,
      params: { tenantId, nodes: nodes.map((n) => ({ ...n, props: pruneProps(n.props) })) }
    });

    const ids = nodes.map((n) => n.id);
    operations.push({
      cypher: `MATCH (x) WHERE x.tenantId = $tenantId AND x.entityLabel IN $labels AND NOT x.id IN $ids
       DETACH DELETE x`,
      params: { tenantId, labels: ENTITY_LABELS, ids }
    });

    const rels = [...workspaceRels];
    for (const d of snapshot.domains) {
      rels.push({ from: nodeId(tenantId, 'Domain', d.id), to: tenantId, type: 'OWNED_BY' });
    }
    for (const r of snapshot.records) {
      rels.push({ from: nodeId(tenantId, 'Domain', r.domainId), to: nodeId(tenantId, 'DNSRecord', r.localId), type: 'DEPENDS_ON' });
    }
    for (const m of snapshot.mailboxes) {
      rels.push({ from: nodeId(tenantId, 'Mailbox', m.id), to: nodeId(tenantId, 'Domain', m.domain_id), type: 'DEPENDS_ON' });
    }
    for (const c of snapshot.checks) {
      const rec = c.recordId ? nodeId(tenantId, 'DNSRecord', c.recordId) : null;
      if (rec) rels.push({ from: nodeId(tenantId, 'Check', c.localId), to: rec, type: 'VALIDATES' });
    }
    for (const a of snapshot.actions) {
      rels.push({ from: nodeId(tenantId, 'Domain', a.domain_id), to: nodeId(tenantId, 'SetupAction', a.id), type: 'HAS_ACTION' });
      const chk = snapshot.checks.find((c) => c.scope === a.target_check && c.domainId === a.domain_id);
      if (chk) rels.push({ from: nodeId(tenantId, 'SetupAction', a.id), to: nodeId(tenantId, 'Check', chk.localId), type: 'RESOLVES' });
    }

    const allowedTypes = new Set(['OWNED_BY', 'DEPENDS_ON', 'VALIDATES', 'HAS_ACTION', 'RESOLVES', 'OWNS', 'HAS_WORKSPACE', 'USES', 'CONTAINS', 'SUGGESTS', 'POSSIBLY_REFERENCES']);
    const cleanRels = rels.filter((r) => allowedTypes.has(r.type));
    operations.push({
      cypher: `MATCH (a {tenantId: $tenantId})-[r {tenantId: $tenantId}]->(b {tenantId: $tenantId}) DELETE r`,
      params: { tenantId }
    });
    for (const type of allowedTypes) {
      const selected = cleanRels.filter((r) => r.type === type);
      if (!selected.length) continue;
      // type comes only from the fixed allowlist above, never from a request.
      operations.push({
        cypher: `UNWIND $rels AS rel
         MATCH (a {id: rel.from, tenantId: $tenantId})
         MATCH (b {id: rel.to, tenantId: $tenantId})
         MERGE (a)-[r:${type}]->(b)
         SET r.tenantId = $tenantId`,
        params: { tenantId, rels: selected }
      });
    }
    await executeAtomic(operations);
  }

  function queueProjection(fn, label, tenantId = null) {
    let resolveProjection;
    let rejectProjection;
    const promise = new Promise((resolve, reject) => {
      resolveProjection = resolve;
      rejectProjection = reject;
    });
    // Fire-and-forget callers still need the rejection observed.
    promise.catch(() => {});
    const item = {
      fn, label, tenantId, attempts: 0, promise,
      resolveProjection, rejectProjection, settled: false
    };
    queue.push(item);
    if (tenantId) {
      const state = projectionStates.get(tenantId) || { pending: null, error: null };
      state.pending = item;
      projectionStates.set(tenantId, state);
    }
    scheduleFlush(0);
    return item;
  }

  function scheduleFlush(delayMs) {
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      flush().catch(() => {});
    }, delayMs);
    if (retryTimer.unref) retryTimer.unref();
  }

  async function flush() {
    if (flushing) return flushPromise;
    flushing = true;
    flushPromise = (async () => {
      const batch = queue;
      queue = [];
      let failed = false;
      try {
        for (const item of batch) {
          try {
            await item.fn();
            if (item.tenantId) {
              const state = projectionStates.get(item.tenantId);
              if (state?.pending === item) {
                state.pending = null;
                state.error = null;
              }
            }
            if (!item.settled) {
              item.settled = true;
              item.resolveProjection();
            }
          } catch (err) {
            failed = true;
            item.attempts += 1;
            if (item.tenantId) {
              const state = projectionStates.get(item.tenantId) || { pending: item, error: null };
              state.error = err;
              projectionStates.set(item.tenantId, state);
            }
            if (!item.settled) {
              item.settled = true;
              item.rejectProjection(err);
            }
            if (item.attempts < 5) queue.push(item);
            logger?.warn('graph projection failed', { label: item.label, attempt: item.attempts, error: String(err && err.message) });
          }
        }
      } finally {
        flushing = false;
        if (queue.length > 0) scheduleFlush(Math.min(60000, 2000 * Math.max(1, queue[0].attempts)));
      }
      return { ok: !failed, remaining: queue.length };
    })();
    try {
      return await flushPromise;
    } finally {
      flushPromise = null;
    }
  }

  async function project(tenantId, snapshot) {
    const item = queueProjection(() => projectSnapshot(tenantId, snapshot), `tenant:${tenantId}`, tenantId);
    if ((await checkAvailability()).available) {
      await flush();
      await item.promise;
    }
    return status();
  }

  function status() {
    const projectionErrors = [...projectionStates.values()].map((state) => state.error).filter(Boolean);
    return {
      enabled: availability.enabled,
      available: availability.available,
      degraded: hasConfig() ? !availability.available || queue.length > 0 || projectionErrors.length > 0 : false,
      queued: queue.length,
      lastError: availability.lastError || (projectionErrors[projectionErrors.length - 1]
        ? String(projectionErrors[projectionErrors.length - 1].message || projectionErrors[projectionErrors.length - 1])
        : null),
      projectionError: projectionErrors.length
        ? String(projectionErrors[projectionErrors.length - 1].message || projectionErrors[projectionErrors.length - 1])
        : null,
      checkedAt: availability.checkedAt
    };
  }

  async function waitForCurrentProjection(tenantId) {
    const state = projectionStates.get(tenantId);
    if (!state) return;
    if (state.pending && !flushing && queue.some((item) => item.tenantId === tenantId)) await flush();
    if (state.pending) {
      try {
        await state.pending.promise;
      } catch (err) {
        throw new GraphUnavailableError(`Graph projection is degraded (${err?.message || 'projection failed'}).`);
      }
    }
    if (state.error) {
      throw new GraphUnavailableError(`Graph projection is degraded (${state.error.message || 'projection failed'}).`);
    }
  }

  async function getDomainGraph(tenantId, domainId) {
    const avail = await checkAvailability({ force: true });
    if (!avail.enabled) throw new GraphUnavailableError('Neo4j is not configured. Graph views require NEO4J_URI and NEO4J_PASSWORD.');
    if (!avail.available) throw new GraphUnavailableError(`Neo4j is unavailable (${avail.lastError || 'connection failed'}). SQL data is unaffected; the graph is a projection.`);
    await waitForCurrentProjection(tenantId);

    const rows = await executeScoped(
      `MATCH (n:WorkspaceEntity {tenantId: $tenantId})
       WHERE n.id = $domainId OR n.domainId = $domainLocal
       OPTIONAL MATCH (n)-[r]->(m:WorkspaceEntity {tenantId: $tenantId})
       WHERE m.id = $domainId OR m.domainId = $domainLocal
       RETURN collect(DISTINCT n) AS nodes,
         collect(DISTINCT CASE WHEN r IS NULL THEN null ELSE {from:n.id,to:m.id,type:type(r)} END) AS edges`,
      { tenantId, domainId: nodeId(tenantId, 'Domain', domainId), domainLocal: domainId }
    );
    const nodes = rows.length ? toPlain(rows[0].get('nodes')).map((n) => {
      const dnsType = n.dnsType || n.recordType || (n.entityLabel === 'DNSRecord' ? n.type : undefined);
      return { ...n, type: n.entityLabel, ...(dnsType ? { dnsType, recordType: dnsType } : {}) };
    }) : [];
    const edges = rows.length ? rows[0].get('edges').filter(Boolean) : [];
    return { nodes, edges, degraded: status().degraded, graphStatus: status() };
  }

  async function blockers(tenantId, domainId) {
    const avail = await checkAvailability();
    if (!avail.enabled || !avail.available) throw new GraphUnavailableError('Graph is unavailable.');
    await waitForCurrentProjection(tenantId);
    const rows = await executeScoped(
      `MATCH (d:Domain {id: $domainId, tenantId: $tenantId})-[:DEPENDS_ON]->(r:DNSRecord {tenantId: $tenantId})
       WHERE r.state IN ['conflict', 'missing', 'mismatch', 'pending', 'failed']
       OPTIONAL MATCH (m:Mailbox {tenantId: $tenantId})-[:DEPENDS_ON]->(d)
       OPTIONAL MATCH (c:Check {tenantId: $tenantId, domainId: $domainLocal})-[:VALIDATES]->(r)
       OPTIONAL MATCH (a:SetupAction {tenantId: $tenantId, domainId: $domainLocal})-[:RESOLVES]->(c)
       RETURN r.id AS recordId, r.name AS name, r.dnsType AS type, r.state AS state, c.scope AS scope,
              collect(DISTINCT m.address) AS mailboxes, collect(DISTINCT a.kind) AS actions`,
      { tenantId, domainId: nodeId(tenantId, 'Domain', domainId), domainLocal: domainId }
    );
    return rows.map((rec) => ({
      recordId: rec.get('recordId'),
      name: rec.get('name'),
      type: rec.get('type'),
      scope: rec.get('scope'),
      state: rec.get('state'),
      dependentMailboxes: toPlain(rec.get('mailboxes')),
      suggestedActions: toPlain(rec.get('actions'))
    }));
  }

  async function impact(tenantId, recordId) {
    const avail = await checkAvailability();
    if (!avail.enabled || !avail.available) throw new GraphUnavailableError('Graph is unavailable.');
    await waitForCurrentProjection(tenantId);
    const rows = await executeScoped(
      `MATCH (m:Mailbox {tenantId: $tenantId})-[:DEPENDS_ON]->(d:Domain {tenantId: $tenantId})-[:DEPENDS_ON]->(r:DNSRecord {id: $recordId, tenantId: $tenantId})
       RETURN m.address AS address, m.status AS status, d.name AS domain`,
      { tenantId, recordId }
    );
    return rows.map((rec) => ({ address: rec.get('address'), status: rec.get('status'), domain: rec.get('domain') }));
  }

  async function close() {
    if (retryTimer) clearTimeout(retryTimer);
    if (driver) {
      const d = driver;
      driver = null;
      await d.close();
    }
  }

  return { checkAvailability, status, project, queueProjection, flush, getDomainGraph, blockers, impact, close };
}
