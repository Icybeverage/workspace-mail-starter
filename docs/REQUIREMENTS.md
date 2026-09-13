# Software and services

## Local demo

| Install | Purpose |
| --- | --- |
| [Node.js](https://nodejs.org/en/download/) 22.12+ with npm | Runs the server and builds the client |
| [Git](https://git-scm.com/downloads/) | Clones the repository and tracks changes |
| A modern browser | Opens the workspace |

Run `npm ci` to install the JavaScript dependencies pinned in `package-lock.json`, including React, Express, Vite, the Neo4j driver, and the mail/DAV libraries. SQLite is embedded through `better-sqlite3`; it does not need a separate database server.

If the SQLite native module needs to compile on your platform, install Python and the platform build tools listed in the [node-gyp installation guide](https://github.com/nodejs/node-gyp#installation): Xcode Command Line Tools on macOS, a C/C++ toolchain and Make on Linux, or Visual Studio C++ build tools on Windows.

The [local demo](../README.md#try-it-locally) uses simulated providers. It does not need a mail server, Docker, Neo4j, or a paid service account. The repository commands use a POSIX shell; Windows users should use WSL for this workflow.

## Development and verification

| Install | When needed |
| --- | --- |
| [Qoder IDE or CLI](https://qoder.com/en/download) | Developing with Qoder or working from exported task briefs; sign in to your own Qoder account |
| [Playwright Chromium](https://playwright.dev/docs/browsers) | Running the browser verification harness |

After `npm ci`, install the browser with:

```sh
npx playwright install chromium
```

On supported Linux systems, install its system libraries as well with `npx playwright install --with-deps chromium`. See the [Qoder workflow](BUILD_WITH_QODER.md) and [contribution guide](../CONTRIBUTING.md) for the remaining steps.

## Live deployment

| Software or service | Role and setup |
| --- | --- |
| Compatible mail server | Supplies mailbox administration, SMTP delivery, and IMAP. The bundled adapter targets the [Mail-in-a-Box API](https://mailinabox.email/guide.html); alternatives need the same [API contract](MAIL_PROVIDER.md) or an adapter change. Follow the provider’s dedicated-server requirements. |
| Webmail, such as [Roundcube](https://roundcube.net/) | Supplies the inbox at `/mail/` |
| [Nextcloud](https://nextcloud.com/install/) with Calendar and Files | Supplies the `/cloud/` portals and DAV resources. Match the paths and mailbox authentication described in [Mail server integration](MAIL_PROVIDER.md). |
| HTTPS reverse proxy, such as [nginx](https://nginx.org/en/docs/) | Routes `/launch/` to the Node server and handles TLS. Reuse an existing proxy if available. |
| Domain registrar and DNS hosting | Lets you verify ownership and publish mail records; the mail host also needs suitable SMTP connectivity and reverse DNS |

An integrated mail-server distribution may already provide webmail, calendar/file services, and a reverse proxy. Check what it supplies before installing duplicates. This repository does not install or configure those services; use the [deployment guide](DEPLOYMENT.md) to connect them.

## Optional integrations

- **Neo4j:** required for relationship views and graph queries. Use [Aura](https://neo4j.com/docs/aura/getting-started/create-instance/) or the included local Compose configuration. Local Compose requires [Docker Engine and Compose](https://docs.docker.com/compose/install/) (Docker Desktop includes both). Follow [Neo4j setup](NEO4J.md); the Compose file starts only the database.
- **Cloudflare:** an account managing your domain and an API token are needed for automated DNS changes. Manual DNS setup remains available.
- **SendGrid:** an account and API key enable the supported sender-authentication integration. Outbound SMTP relay configuration belongs on the mail server.
- **OpenAI-compatible model endpoint:** enables model-written setup explanations through `LLM_*` settings. Without it, the assistant uses rules.

Configure optional services in [`.env.example`](../.env.example). Service accounts, hosting, domains, and any usage charges are separate from this repository.
