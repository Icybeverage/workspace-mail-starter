# Qoder handoff (manual)

Workspace Mail can prepare a **Markdown task brief** from a selected workspace graph node (Email or Suggested action). The brief is generated entirely in the browser from your saved workspace snapshot and graph projection. Nothing is sent to Qoder automatically.

## What the brief contains

Allowlisted metadata only:

- Selected item title and type
- Source email subject and received date (no sender)
- Related calendar event and file names with dates/sizes, when linked by graph edges (`SUGGESTS`, `POSSIBLY_REFERENCES`)
- Relation labels

Excluded fields: message bodies, excerpts, senders, source URLs, internal IDs, credentials, and other node properties. Recognizable web links and email addresses in names are redacted, but names may still contain sensitive text. Review the preview before sharing.

## Prepare a brief in the app

1. Open **Workspace** and sync your workspace graph.
2. Select an **Email** or **Suggested action** node in the graph.
3. Click **Prepare for Qoder** in the detail panel.
4. Review the inline preview. Confirm names look correct before sharing.
5. Use **Copy brief** or **Download brief** (`qoder-task.md`).

There is no native Qoder API or deep-link integration. You choose when and how to share the file.

## Hand off to Qoder CLI

After downloading `qoder-task.md`:

```bash
qodercli --attachment qoder-task.md
```

Or start a session and attach the file when prompted. The brief instructs Qoder to:

1. Produce an implementation plan first.
2. Avoid sending mail, changing DNS, or deploying without your explicit instruction.

## Hand off in the Qoder IDE

1. Save the downloaded `qoder-task.md` into your project (or keep it nearby).
2. In the Qoder IDE chat, reference the file with `@qoder-task.md` (or the path you chose).
3. Ask Qoder to read the brief and draft an implementation plan before making changes.

## Scope and safety

- **Manual only:** copying or downloading is the entire handoff. Workspace does not call Qoder or any external agent service.
- **Untrusted reference data:** email subjects and resource names may contain arbitrary text. The brief escapes Markdown fence breakouts in machine-readable JSON, but you should still review content before sharing.
- **Workspace scope:** related resources are discovered only through actual graph edges from the source email node, with bounded counts and length limits (`client/src/qoderBrief.js`).
