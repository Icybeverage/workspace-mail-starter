# Email-to-Qoder task briefs

Select an email or suggested action in **Workspace**, then choose **Prepare for Qoder**. Review the preview and copy it or download `qoder-task.md`.

The browser builds the brief from the selected item and its graph connections. It includes the title, source email subject/date, and related meeting or file names with dates and sizes. Message bodies, sender fields, source URLs, credentials, and internal IDs are excluded. Names can still contain sensitive text, so review them before sharing.

Attach the file in Qoder IDE with `@qoder-task.md`, or run:

```sh
qodercli --attachment qoder-task.md
```

Copying or downloading does not send anything to Qoder. The brief asks for a plan first and requires a separate instruction before sending mail, changing DNS, or deploying.

The exporter is [`client/src/qoderBrief.js`](../client/src/qoderBrief.js). It follows existing graph edges, limits the number of related items and text length, and escapes Markdown fences in the JSON context. Regression coverage is in [`tests/qoder-brief.test.js`](../tests/qoder-brief.test.js).
