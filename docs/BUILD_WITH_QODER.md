# Develop with Qoder

1. Install Qoder using the [software requirements guide](REQUIREMENTS.md) and sign in.
2. Open the `workspace-mail-starter` folder in Qoder IDE.
3. Run the [local demo](../README.md#try-it-locally) in its terminal to inspect the app before editing. Project rules are in [`.qoder/rules/workspace.md`](../.qoder/rules/workspace.md).
4. Stop the demo with `Ctrl+C` before starting the verification harness. Rebuild and restart the demo to inspect later changes.

For development with real providers, complete [configuration](DEPLOYMENT.md#2-configure-the-app), then run `APP_ORIGIN=http://localhost:5173 npm run dev`. Open `http://localhost:5173/launch/`; the API runs on port 3210. This mode uses your configured services.

## Start with a small change

Give Qoder a behavior to implement, the relevant files, and a way to check the result. For example:

> Add a mailbox storage warning when reported usage exceeds 80% of quota. Start with the Workspace page and mailbox service. Keep the existing unavailable state when usage is missing. Add a regression for both cases.

Review the proposed changes, then run:

```sh
npm run verify
```

Open the generated report in `review/harness/` to check both the results and screenshots. Changes to a provider adapter also need testing against that provider in a staging environment.

## Where to start

| Change | Files to read |
| --- | --- |
| Mailbox provisioning | `server/services/mailboxes.js`, `server/services/mailserver.js` |
| Domain setup | `server/services/domains.js`, `server/services/dns.js` |
| Graph queries | `server/services/graph.js` |
| Email/calendar/file context | `server/services/workspace-knowledge.js` |
| Workspace UI | `client/src/components/WorkspaceKnowledge.jsx` |
| Verification harness | `scripts/harness/run.js` |

## Work from an email

Use the [email-to-Qoder guide](QODER_HANDOFF.md) to export workspace context and attach it in the IDE or CLI.
