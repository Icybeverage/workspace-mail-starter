# Workspace Mail

A white-label starting point for self-hosted business email onboarding and operations. Connect a mail server, let users register and provision an address within operator limits, onboard verified custom domains, and connect email, calendar, and file context through Neo4j.

The application includes a dark React workspace, mailbox storage usage, domain diagnostics, a read-only operations investigation, readable relationship graphs, and a reviewed Markdown handoff to Qoder. It supports operating email for your own organization or providing a managed service to customers.

## Run the local demo

Requires Node.js 22.12+ or a newer supported LTS and npm.

```sh
npm ci
npm run build
npm run demo
```

Open the local URL printed by the command and create a demo account. This mode uses an isolated temporary database and simulated mail/DNS providers. It does not send email, connect to a real calendar, or persist data after shutdown. Neo4j is intentionally unavailable in fixture mode, and the UI says so.

## Verify the project

```sh
npx playwright install chromium
npm run verify
npm run privacy:check
```

The harness runs unit tests, builds the app, starts the fixture server, and checks the real UI in standalone Chromium at desktop and mobile widths. Reports are written under ignored `review/harness/`. These checks do not prove real email delivery or a live Neo4j deployment.

## Connect your infrastructure

Read [the deployment guide](docs/DEPLOYMENT.md), [mail provider contract](docs/MAIL_PROVIDER.md), and [Neo4j guide](docs/NEO4J.md). This repository is the onboarding and operations application. A separately operated SMTP/IMAP server and compatible calendar/file portals provide the underlying services. Neo4j stores relationships, not mailboxes.

Copy `.env.example` to `.env` and fill in values locally. The app runs without optional Neo4j and language-model credentials, with explicitly unavailable or rule-based states. Do not deploy with example domains or test credentials.

## Build with Qoder

Open this folder in Qoder IDE, read [the build workflow](docs/BUILD_WITH_QODER.md), and run the verification harness after each meaningful change. The included project rules describe architecture, privacy boundaries, and verification. [Email-to-Qoder handoff](docs/QODER_HANDOFF.md) exports a brief for review and manual attachment; it is not an automatic agent API.

## White-label

```sh
VITE_BRAND_NAME='Your Business Mail' npm run build
```

The wordmark and task-brief brand follow this build setting. Replace the pixel-cloud SVG in `client/src/components/Bits.jsx`, edit the document title in `client/index.html`, and tune color/spacing tokens in `client/src/styles.css`. Set your hosted domain and provider endpoints through environment configuration.

## Release boundaries

This is a source starter, not a turnkey managed email service. You operate delivery, abuse prevention, backups, TLS, monitoring, retention, billing, and customer support. Provisioning caps and reserved names are included. Review the deployment checklist before opening public signup.

No deployment credentials, private endpoints, user mailbox content, browser sessions, original Git history, or production media are included. See [NOTICE](NOTICE) for source provenance and third-party licensing.
