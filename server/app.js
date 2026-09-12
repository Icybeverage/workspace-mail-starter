import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { loadConfig, mailserverConfigured, llmConfigured, ROOT_DIR } from './lib/env.js';
import { initDb, ensureHostedDomain } from './db.js';
import { createLogger } from './lib/log.js';
import { RateLimiter, ok, fail, sameOriginGuard } from './lib/http.js';
import { createDnsInspector } from './services/dns.js';
import { createMailServerClient } from './services/mailserver.js';
import { createCloudflareClient } from './services/cloudflare.js';
import { createRelayService } from './services/relay.js';
import { createGraphService } from './services/graph.js';
import { createSnapshotBuilder } from './services/snapshot.js';
import { createMailboxService } from './services/mailboxes.js';
import { createDomainService } from './services/domains.js';
import { createAgentService } from './services/agent.js';
import { authRoutes } from './routes/auth.js';
import { domainRoutes } from './routes/domains.js';
import { mailboxRoutes } from './routes/mailboxes.js';
import { workspaceRoutes } from './routes/workspace.js';
import { activityRoutes } from './routes/activity.js';
import { agentRoutes } from './routes/agent.js';

const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8')).version;

export function createApp(options = {}) {
  const config = options.config || loadConfig();
  const logger = options.logger || createLogger({ name: 'workspace' });
  const db = options.db || initDb(config.dbPath);
  ensureHostedDomain(db, config.hostedDomain);

  const limiter = new RateLimiter();
  const fetchImpl = options.fetchImpl || fetch;
  const dnsInspector = options.dnsInspector || createDnsInspector({ resolver: options.resolver });
  const mailserver = createMailServerClient({ config, logger, fetchImpl });
  const cloudflare = createCloudflareClient({ config, logger, fetchImpl });
  const relay = createRelayService({ db, config, logger, fetchImpl });
  const graph = options.graph || createGraphService({ config, logger });
  const snapshotBuilder = createSnapshotBuilder({ db });

  const mailboxService = createMailboxService({ db, config, mailserver, graph, logger, snapshotBuilder });
  const domainService = createDomainService({ db, config, mailserver, dnsInspector, cloudflare, relay, graph, logger, snapshotBuilder });
  const agentService = createAgentService({ db, config, domainService, graph, logger, fetchImpl });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');

  app.use(express.json({ limit: '128kb' }));
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
    });
    next();
  });

  const root = express.Router();

  root.get('/health', async (req, res) => {
    let sqliteOk = true;
    try {
      db.prepare('SELECT 1 AS ok').get();
    } catch {
      sqliteOk = false;
    }
    const graphStatus = await graph.checkAvailability();
    return ok(res, {
      status: sqliteOk ? 'ok' : 'degraded',
      service: 'workspace-launch',
      version: VERSION,
      uptimeSec: Math.round(process.uptime()),
      time: new Date().toISOString(),
      basePath: config.basePath || '/',
      dependencies: {
        sqlite: { ok: sqliteOk },
        neo4j: { configured: graphStatus.enabled, available: graphStatus.available, degraded: graphStatus.enabled && !graphStatus.available },
        mailServer: { configured: mailserverConfigured(config) },
        cloudflare: { vaultConfigured: Boolean(config.vaultKey), note: config.vaultKeyError || null },
        outgoingRelay: { configured: relay.isConfigured(), provider: relay.isConfigured() ? config.relay.provider : null },
        llm: { configured: llmConfigured(config) }
      }
    });
  });

  root.use((req,res,next)=>{ if(req.path.startsWith('/api/')) res.set('Cache-Control','no-store'); next(); });
  root.use(sameOriginGuard(config));

  root.get('/api/meta', (req, res) => ok(res, {
    appName: 'Workspace Launch',
    hostedDomain: config.hostedDomain,
    limits: {
      mailboxesPerAccount: config.mailboxLimitPerAccount,
      globalMailboxCap: config.globalMailboxCap
    },
    capabilities: {
      mailServerConfigured: mailserverConfigured(config),
      cloudflareAutomation: Boolean(config.vaultKey),
      outgoingRelay: relay.isConfigured() ? config.relay.provider : null,
      llmAssistant: llmConfigured(config)
    },
    honesty: {
      emailRecovery: 'Email-based password recovery is not implemented. There is no reset flow yet.',
      delivery: 'Delivery status (inbound/outbound) stays "unknown" until an actual test message round-trips.',
      quota: 'New mailboxes have a 512 MB storage quota.'
    },
    reservedLocalParts: mailserverConfigured(config) ? undefined : 'hosted-domain reserved names apply on signup'
  }));

  root.use('/api/auth', authRoutes({ db, config, limiter }));
  root.use('/api/domains', domainRoutes({ db, config, limiter, domainService, relay, graph }));
  root.use('/api/mailboxes', mailboxRoutes({ db, config, limiter, mailboxService }));
  root.use('/api/workspace', workspaceRoutes({ db, config, limiter, mailboxService, mailserver, graph, snapshotBuilder, fetchImpl, workspaceReader: options.workspaceReader }));
  root.use('/api/activity', activityRoutes({ db }));
  root.use('/api/agent', agentRoutes({ db, config, limiter, agentService }));

  const clientDist = path.join(ROOT_DIR, 'client', 'dist');
  root.use(express.static(clientDist, { index: false, fallthrough: true, maxAge: '1h' }));
  root.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.path.startsWith('/api/') || req.path === '/health' || req.path === '/api') return next();
    const acceptsHtml = String(req.headers.accept || '').includes('text/html');
    const indexPath = path.join(clientDist, 'index.html');
    if (acceptsHtml && fs.existsSync(indexPath)) {
      return res.sendFile(indexPath);
    }
    if (acceptsHtml) {
      return res.status(503).type('html').send('<!doctype html><title>Workspace Launch</title><p>The frontend has not been built yet. Run <code>npm run build</code>.</p>');
    }
    return next();
  });
  root.use((req, res) => fail(res, 404, 'not_found', 'Not found.'));

  app.use(config.basePath || '/', root);
  if (config.basePath) {
    app.get('/', (req, res) => res.redirect(config.basePath));
  }

  app.use((err, req, res, next) => {
    if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large')) {
      return fail(res, 400, 'bad_request', 'Request body could not be parsed.');
    }
    const ref = Math.random().toString(16).slice(2, 10);
    logger.error('unhandled error', { ref, path: req.path, method: req.method, error: String(err && err.message) });
    if (res.headersSent) return next(err);
    return fail(res, 500, 'internal_error', `Something went wrong on the server. Reference: ${ref}`);
  });

  // Rebuild projections from durable state on restart; no credentials enter snapshots.
  if(config.neo4j.uri && config.neo4j.password) {
    for(const user of db.prepare('SELECT id FROM users').all()) {
      graph.project(user.id,snapshotBuilder(user.id)).catch(()=>{});
    }
  }

  const services = { mailserver, cloudflare, relay, graph, mailboxService, domainService, agentService, snapshotBuilder, limiter };

  async function close() {
    await graph.close();
    db.close();
  }

  return { app, db, config, logger, services, close };
}
