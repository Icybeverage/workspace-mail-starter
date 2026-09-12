# Deploy your own workspace

1. Provision a compatible mail server and calendar/files portals. Confirm the contract in MAIL_PROVIDER.md.
2. Install Node.js 22.12+ or newer supported LTS. Run `npm ci` and `npm run build`.
3. Copy `.env.example` to `.env`, restrict file permissions, and set your own `HOSTED_DOMAIN`, `MAIL_SERVER_*`, `APP_ORIGIN`, and `BASE_PATH`. The reserved example domains cannot deliver email.
4. Generate a unique 32-byte vault key locally with `openssl rand -hex 32`, then store it as `VAULT_KEY`. Keep it stable and backed up: changing it makes previously encrypted DNS tokens unreadable. Do not commit or paste it into chat.
5. Configure Neo4j using NEO4J.md. Optional relay sender-authentication and language-model settings are described in `.env.example`.
6. Run `npm start` behind an HTTPS reverse proxy. Match the proxy prefix to `BASE_PATH`, use a dedicated service account, and persist `DATA_DIR`. Bind to loopback unless deployment networking requires otherwise.
7. Back up SQLite and the vault key securely, and test restoration. Monitor mail queues, disk usage, DNS status, authentication, rate limits and projection errors.
8. Verify tenant isolation and authorized end-to-end mail, calendar/file and graph operations in a staging deployment before public signup.

`npm run verify` is isolated fixture verification. For optional read-only live checks, explicitly pin your host separately:

```sh
LIVE_ALLOWED_HOST=mail.your-domain.example node scripts/harness/run.js --live https://mail.your-domain.example/launch/
```

The harness restricts methods, paths and origin. Do not weaken these restrictions to make a check pass. Keep reports private because authenticated deployment metadata may be sensitive.

The supplied Compose file starts only Neo4j. It does not install SMTP, IMAP, webmail, calendar, file storage, TLS, or a reverse proxy. Container startup must be validated on your own Docker host.
