# Mail server integration

The adapter in [`server/services/mailserver.js`](../server/services/mailserver.js) uses Basic authentication over HTTPS and URL-encoded forms. Configure it with `MAIL_SERVER_*` in [`.env.example`](../.env.example).

Your provider must implement this contract, or you will need to replace the adapter.

| Operation | Endpoint | Response / behavior |
| --- | --- | --- |
| List mailboxes | GET `/mail/users?format=json` | Flat users or domain groups, including email and quota/usage fields |
| Create mailbox | POST `/mail/users/add` | Accept `email`, `password`, `privileges`, and `quota` |
| Read DNS suggestions | GET `/dns/dump?format=json` | DNS record groups for domain planning |
| List zones | GET `/dns/zones?format=json` | Domains known to the server |

New mailboxes request a `512M` quota and no administrator privileges. The adapter expects the first mailbox on a domain to trigger DKIM/DNS generation. Malformed user-list responses are treated as unavailable, so provisioning cannot mistake a failed lookup for an unused address.

[`tests/helpers.js`](../tests/helpers.js) provides provider fixtures. Normalization and failure cases are covered in the mailbox and diagnostics tests.

## Calendar and files

[`workspace-knowledge.js`](../server/services/workspace-knowledge.js) reads:

- IMAP over TLS on port 993, using the mailbox credentials.
- Calendars at `/cloud/remote.php/dav/calendars/{user}/`.
- Files at `/cloud/remote.php/dav/files/{user}/`.

DAV requests use the same origin as the configured mail administration URL. A provider with different paths or authentication needs a connector change. SMTP delivery and the webmail/calendar/file interfaces run separately from this application.
