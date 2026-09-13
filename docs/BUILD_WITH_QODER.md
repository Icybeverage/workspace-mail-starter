# Develop with Qoder

Open the repository in Qoder IDE and run the [local demo](../README.md#try-it-locally). Project context is in [`.qoder/rules/workspace.md`](../.qoder/rules/workspace.md).

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

Qoder contributed the diagnostics and verification harness in the original project. These entry points let you continue that work in your own deployment.

## Work from an email

Download a reviewed [task brief](QODER_HANDOFF.md), then attach it in Qoder IDE with `@qoder-task.md`, or use the CLI:

```sh
qodercli --attachment qoder-task.md
```

Keep mailbox content and private briefs out of Git. The brief asks Qoder for a plan before making changes.

References: [Qoder CLI](https://docs.qoder.com/cli/cli-reference), [IDE file context](https://docs.qoder.com/user-guide/chat/context).
