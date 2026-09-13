# Workspace Mail

Self-service business email on infrastructure you control.

Workspace Mail handles account signup, mailbox provisioning, custom-domain setup, and storage usage. It connects email, calendar, and file context through Neo4j, and exports task briefs you can take into Qoder.

The app connects to an existing mail server and calendar/file services. Those services supply the inbox, delivery, and storage; this repo contains the onboarding and operations workspace.

## Try it locally

1. Install Node.js 22.12+ with npm and Git from the [software requirements guide](docs/REQUIREMENTS.md).
2. In a terminal, download the project and start the demo:

```sh
git clone https://github.com/Icybeverage/workspace-mail-starter.git
cd workspace-mail-starter
npm ci
npm run build
npm run demo
```

3. Open the URL printed in the terminal and create a demo account. Explore mailbox creation and domain setup using sample details.
4. Press `Ctrl+C` in the terminal when finished. This removes the temporary demo database.

Mail and DNS are simulated, no email is sent, and Neo4j is unavailable in this mode. To use real services, follow the deployment steps below.

## What’s included

- Signup and mailbox creation, with reserved addresses and provisioning limits.
- Domain ownership verification, DNS planning, and setup diagnostics.
- Mailbox usage and links to your mail, calendar, and file portals.
- Neo4j dependency graphs for domains and mailboxes, plus email/task/meeting/file context.
- A browser-generated task brief for manual handoff to Qoder.

## Set up your deployment

Follow the [deployment guide](docs/DEPLOYMENT.md) in order:

1. Prepare your mail server, inbox, calendar, and file services.
2. Create `.env` and enter your domain and provider settings.
3. Connect Neo4j if you want relationship views.
4. Build the app and serve it behind HTTPS.
5. Create a test mailbox and verify delivery, calendar, and file access.

For changes in Qoder, use the [development guide](docs/BUILD_WITH_QODER.md).

## Customize the brand

```sh
VITE_BRAND_NAME='Your Business Mail' npm run build
```

This sets the wordmark and task-brief title. The logo is in [`Bits.jsx`](client/src/components/Bits.jsx), the page title in [`client/index.html`](client/index.html), and the theme in [`styles.css`](client/src/styles.css).

## Work on the code

| Location | Responsibility |
| --- | --- |
| `client/src/` | React pages, graph views, task-brief export |
| `server/routes/` | HTTP endpoints and access checks |
| `server/services/` | Mail, DNS, graph, and workspace integrations |
| `server/lib/` | Configuration, sessions, database, encryption |
| `scripts/harness/` | Test runner and Chromium checks |
| `tests/` | Unit and integration tests with fake providers |

The [Qoder guide](docs/BUILD_WITH_QODER.md) covers the development workflow. [Task briefs](docs/QODER_HANDOFF.md) explains the email-to-Qoder handoff.

```sh
npx playwright install chromium
npm run verify
```

The harness runs tests, builds the app, and checks the UI at desktop and mobile widths. Reports go to `review/harness/`. See [CONTRIBUTING.md](CONTRIBUTING.md) for change and verification guidelines.

## License

[MIT](LICENSE). Third-party service and dependency notices are in [NOTICE](NOTICE).
