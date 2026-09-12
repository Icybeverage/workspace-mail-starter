# Mail provider contract

`server/services/mailserver.js` implements a specific administrative HTTP contract using server-side Basic authentication and URL-encoded forms. A configured endpoint must implement the contract or be replaced with an adapter for your provider. Changing its hostname is insufficient.

Required operations:

| Operation | Endpoint | Expected behavior |
| --- | --- | --- |
| List mailboxes/usage | GET `/mail/users?format=json` | Flat or domain-grouped users with email, privileges, quota and usage fields |
| Create mailbox | POST `/mail/users/add` | Accept `email`, `password`, and optional `quota`; return success only after creation |
| Read DNS suggestions | GET `/dns/dump?format=json` | DNS record groups used by domain planning |
| List zones | GET `/dns/zones?format=json` | Domains known to the mail server |

See the adapter and `tests/helpers.js` for exact normalization and fixtures. Calendar/files connectors expect the server's compatible DAV and portal paths; see `server/services/workspace-knowledge.js`. Validate these paths and authentication against your installation.

Run your SMTP/IMAP service and portals separately, set `MAIL_SERVER_BASE_URL`, username/password, mail host and `HOSTED_DOMAIN`. Configure MX, SPF, DKIM, DMARC, TLS, reverse DNS and any outbound relay with your infrastructure provider. Verify actual inbound and outbound delivery with an explicitly authorized test. A successful DNS check alone is not delivery proof.

Public signup provisions real mailboxes when a real adapter is configured. Set per-account/global caps, reserved names, rate limits, and an abuse response process before exposing it. Operator credentials never belong in browser configuration or Qoder chat.
