# Deploy Workspace Mail

Run commands from the repository root in a POSIX shell. If you have not downloaded the project, start with the [README](../README.md#try-it-locally).

## 1. Prepare the services

Install or provision the components in [Software and services](REQUIREMENTS.md). Before configuring this app, have these ready:

- A mail-server administration URL and administrator credentials matching the [provider contract](MAIL_PROVIDER.md).
- A domain you control, with access to its DNS records.
- Webmail at `/mail/` and calendar/files at `/cloud/`, on the same public host as the workspace.
- An HTTPS reverse proxy and a persistent directory writable by the application service account.

Confirm that the provider’s own inbox works first. This app connects to those services; running it does not install a mail server.

## 2. Configure the app

For a new checkout:

```sh
npm ci
cp .env.example .env
chmod 600 .env
```

If `.env` already exists, edit it instead of copying over it. Replace the example values with your own:

| Setting | Enter |
| --- | --- |
| `MAIL_SERVER_BASE_URL` | Administration URL, including `/admin` |
| `MAIL_SERVER_USERNAME`, `MAIL_SERVER_PASSWORD` | Mail-server administrator credentials |
| `MAIL_SERVER_MAIL_HOST` | Hostname used for IMAP and the mail exchanger |
| `HOSTED_DOMAIN` | Domain offered when users create a mailbox |
| `APP_ORIGIN` | Public HTTPS origin, such as `https://mail.example.test`, without `/launch/` |
| `BASE_PATH` | Keep `/launch` for the standard setup |
| `DATA_DIR` | Persistent database directory; defaults to `data/` in this checkout |

For automated Cloudflare DNS changes, generate a vault key:

```sh
openssl rand -hex 32
```

Paste the output into `VAULT_KEY` in `.env`. Back up this key with the database; replacing it makes previously encrypted credentials unreadable.

Review mailbox limits and reserved names in [`.env.example`](../.env.example). Configure optional relay or model settings only if you use those services.

## 3. Connect Neo4j

Follow [Neo4j setup](NEO4J.md) to use a local database or Aura, then put its URI, username, and password in `.env`. Skip this step if you do not need graph features; the UI will report the graph as unavailable.

## 4. Build and start

Build with your chosen wordmark:

```sh
BASE_PATH=/launch VITE_BRAND_NAME='Your Business Mail' npm run build
NODE_ENV=production npm start
```

The API listens on `127.0.0.1:3210` by default. Configure your HTTPS reverse proxy to forward `/launch/` to that address **without stripping the prefix**. Then open `https://YOUR_HOST/launch/`.

Once the foreground startup works, run the same start command under your host’s service manager with `NODE_ENV=production`, the repository as its working directory, and a dedicated service account. Keep the default loopback binding when the proxy is on the same machine.

For a different URL prefix, use the same `BASE_PATH` in `.env`, the build command, and the reverse proxy. Production builds read `BASE_PATH` and `VITE_BRAND_NAME` from the shell; editing `.env` alone does not update the built client.

## 5. Verify a test mailbox

1. Create an application account and a mailbox on your hosted domain. The application login and mailbox password are separate credentials.
2. Open the inbox and sign in with the full mailbox address and its password.
3. Confirm MX, SPF, DKIM, DMARC, TLS, reverse DNS, and any relay settings on the mail server. Send a test email to an external address you control, reply, and confirm both messages arrive.
4. Open Calendar, save an event, and reopen it. Upload a small file in Files, download it, and check storage usage in the workspace.
5. If Neo4j is enabled, sync workspace resources and inspect the relationship view.
6. For custom domains, add a domain, verify ownership, apply its DNS plan, and repeat the delivery check after creating its first mailbox.

Before opening signup to others, verify account isolation and restore a database backup in staging. Monitor mail queues and disk usage on the mail server. Passing DNS checks does not confirm message delivery.

## 6. Run the harness

Install Chromium and run the fixture checks:

```sh
npx playwright install chromium
npm run verify
```

For additional checks against your running deployment:

```sh
LIVE_ALLOWED_HOST=mail.example.test node scripts/harness/run.js --live https://mail.example.test/launch/
```

Replace both example hosts with your public hostname. Supply `WORKSPACE_TEST_EMAIL` and `WORKSPACE_TEST_PASSWORD` through the environment for authenticated checks, using the test application account. The live harness supports `/launch` and restricts requests to approved read paths and login.

Review the results and screenshots in `review/harness/`. Keep live reports private. Fixture checks use simulated providers; they do not replace the delivery test above.
