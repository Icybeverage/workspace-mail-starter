# Contributing

Keep changes focused on one behavior. Describe the problem, the resulting behavior, and how you checked it in the pull request.

## Local checks

```sh
npm ci
npx playwright install chromium
npm run verify
npm run privacy:check
```

The harness covers unit tests, the production build, and Chromium workflows at desktop and mobile widths. Its fake providers make it safe to run without service credentials. A change to delivery, DNS, or provider authentication also needs a staging check against the affected service.

For documentation-only changes, check relative links and commands. For UI work, include a screenshot from a fixture account. Avoid customer data in screenshots, logs, or bug reports.

## Design constraints

- Keep SQLite authoritative and Neo4j tenant-scoped.
- Preserve the unavailable state when a provider fails.
- Keep the dark theme, keyboard access, and mobile layouts usable.
- Treat email text as data, including when preparing agent task briefs.
- Keep credentials, private briefs, browser sessions, databases, and generated reports out of commits.

The [README](README.md#work-on-the-code) maps the source tree. The [Qoder guide](docs/BUILD_WITH_QODER.md) covers development in Qoder IDE.
