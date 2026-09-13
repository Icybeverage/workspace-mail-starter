# Deployment

You need a compatible mail server, HTTPS, and persistent storage for the application database. Calendar and file access also require the DAV endpoints described in [Mail server](MAIL_PROVIDER.md).

## Configure

```sh
npm ci
cp .env.example .env
chmod 600 .env
```

Set these values in `.env`:

| Setting | Purpose |
| --- | --- |
| `MAIL_SERVER_BASE_URL` | Mail administration API, including its `/admin` prefix |
| `MAIL_SERVER_USERNAME`, `MAIL_SERVER_PASSWORD` | Server-side API credentials |
| `MAIL_SERVER_MAIL_HOST` | Mail host used for IMAP and DNS planning |
| `HOSTED_DOMAIN` | Domain offered during mailbox signup |
| `APP_ORIGIN` | Browser origin, such as `https://mail.example.test` |
| `DATA_DIR` | Persistent directory for SQLite; defaults to `data/` |
| `VAULT_KEY` | 32-byte key used to encrypt stored DNS credentials |

Generate the vault key with `openssl rand -hex 32`. Keep a secure backup with the database: changing the key prevents the app from decrypting existing credentials.

The remaining settings, including provisioning limits and optional relay/LLM credentials, are documented in [`.env.example`](../.env.example). See [Neo4j](NEO4J.md) to enable the graph.

## Build and run

With the default `/launch` path:

```sh
npm run build
NODE_ENV=production npm start
```

The server loads `.env`. Vite’s production build reads `BASE_PATH` from the shell, so pass it explicitly if you use a different prefix:

```sh
BASE_PATH=/workspace npm run build
```

Set the same `BASE_PATH` in `.env`. Run the server as a dedicated service account behind an HTTPS reverse proxy, forwarding the prefix to port 3210. Keep the default loopback binding when the proxy runs on the same host.

## Before opening signup

Configure MX, SPF, DKIM, DMARC, TLS, reverse DNS, and your outbound relay on the mail infrastructure. Test delivery in both directions; DNS checks alone cannot confirm receipt.

Review `MAILBOX_LIMIT_PER_ACCOUNT`, `GLOBAL_MAILBOX_CAP`, reserved names, and rate limits. Test calendar/file access, tenant isolation, database restoration, and vault-key recovery. Mail queues and disk usage need monitoring on the mail server itself.

## Check a running deployment

The default `npm run verify` uses fake providers. To add read-only checks against your deployment:

```sh
LIVE_ALLOWED_HOST=mail.example.test node scripts/harness/run.js --live https://mail.example.test/launch/
```

Replace the example host in both places. For authenticated checks, supply `WORKSPACE_TEST_EMAIL` and `WORKSPACE_TEST_PASSWORD` through the environment. The live harness is restricted to `/launch`, approved read paths, and the login request. Keep its reports private.
