# Build with Qoder

1. Open this repository in Qoder IDE. Review `.qoder/rules/workspace.md` and `README.md`.
2. Ask Qoder to trace `server/app.js`, the routes, `server/services/graph.js`, and `client/src/components/WorkspaceKnowledge.jsx` before proposing a change.
3. Give it a small outcome: “Add a mailbox storage warning using real reported usage; preserve the unavailable state; add a regression for missing usage.”
4. Review the diff, run `npm run verify`, and inspect the generated Chromium screenshots.
5. Configure a test environment separately and verify actual mail receipt, calendar/file access, Neo4j connectivity, and tenant isolation before rollout.

For a task brief downloaded from the application:

```sh
qodercli --attachment qoder-task.md
```

In Qoder IDE, attach the file with `@qoder-task.md`. Ask for a plan first, then authorize the edits you want. Briefs contain user-selected metadata; keep private briefs out of Git. This workflow does not require pasting mail-server or DNS passwords into chat.

Suggested build order: local fixture flow → branded UI → provider adapter → verified domain onboarding → Neo4j projection → calendar/file context → Qoder handoff → deployment checks.

Qoder contributed diagnostics and verification-harness work in the source project. Additional implementation and review used other development tools. This repository documents a reproducible Qoder workflow and does not claim exclusive authorship by Qoder.

Official references: [CLI flags](https://docs.qoder.com/cli/cli-reference), [IDE context](https://docs.qoder.com/user-guide/chat/context).
