# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] - 2026-11-11

### Fixed

- The card's routes (`status`, `login`, `cancel`, `logout`) are published on the harness
  port, where anything that can reach loopback can call them — more permissive than the
  harness's own routes, which sit behind a session token. A `POST` whose `Origin` header
  belongs to another site is now refused with `403` and logged; same-origin card requests
  and local tools without an `Origin` keep working. This closes a forged-log-out / forged
  sign-in annoyance, not a credential leak: the routes never return a token, and `GET
  /status` exposes only times and scopes.

## [0.2.0] - 2026-11-11

Sign-in, status and expiry move into the plugin page. The OAuth flow now runs inside the
harness process, so a fresh install needs no terminal and no Python.

### Added

- **Sign-in card on the plugin page** (`client.js`): status dot and label (signed in / not
  signed in / expired), expiry as local time plus a countdown, granted scopes, the last
  error verbatim, and the buttons **Sign in**, **Sign in again**, **Sign out** and
  **Cancel** while the browser round-trip is pending. It polls every 15 s when idle and
  every 2 s while a sign-in waits for the browser.
- **OAuth 2.1 in the Host half** (`index.js`): dynamic client registration for a public
  client, PKCE (S256), the RFC 8707 `resource` indicator, a loopback listener on
  `127.0.0.1:8791` (8792/8793 when taken), the code exchange, and a bilingual landing page.
  Four routes feed the card: `GET /api/dsh-agensi-mcp/status`, `POST …/login`,
  `POST …/cancel`, `POST …/logout`. None of them returns a token.
- **i18n**: card copy lives in an `I18N` table (English, Chinese) and follows the harness
  **locale service**, not the OS language; a language switch repaints live cards. Locale
  files carry the plugin title and description for the pre-activation list.
- Chinese README alongside the English one.

### Changed

- Renewal keeps its own cadence (five minutes before expiry, retry after ten) and now also
  re-composes the MCP row after a sign-in or a sign-out, so a button press takes effect
  without a restart.
- The READMEs were rewritten: what the card shows, what happens during the handshake, the
  privacy model, a troubleshooting table, and no machine-specific paths.

### Removed

- `tools/oauth_login.py` and `tools/check.py`. 0.1.0 needed them (and Python) to sign in
  from a shell; the flow is now part of the plugin. Diagnostics moved to
  `status.json` / `plugin.log` and the card's error line.

## [0.1.0] - 2026-11-11

First release. Agensi works as native `mcp__agensi__*` tools in DeepSeek Harness.

### Added

- Bundle patch that inserts one `@deepseek-ai/dsh-mcp-client` row for
  `https://mcp.agensi.io/mcp/auth` over Streamable HTTP (`serverName: agensi`), so the
  server's toolkit appears as `mcp__agensi__*` tools — 25 of them on the first run:
  `search_skills`, `get_skill`, `my_library`, `my_credits`, `quote_tool`, `run_tool`,
  `find_tools`, `skill_tools`, the creator tools, and the rest.
- `tools/oauth_login.py`: the OAuth 2.1 sign-in the harness cannot perform itself —
  dynamic client registration against `/oauth/register`, PKCE (S256), the `resource`
  indicator from RFC 8707, a localhost callback on `127.0.0.1:8791`, and the
  authorization-code exchange. It also supports `url` (reprint the pending authorize
  link) and `refresh` (refresh-token grant). No token is ever typed, pasted or logged.
- `index.js` (Host half): renews the access token a few minutes before it expires with
  the refresh-token grant, rewrites `config.json`, and asks the plugin manager to
  re-compose the MCP row, so a 1-hour credential does not break a long session. Every
  step is defensive: a failure is written to `status.json` / `plugin.log` and retried,
  never raised into harness startup.
- `tools/check.py`: handshake check (`initialize` + `tools/list`) that prints the server's
  tool names and changes no MCP data; it renews the stored token once if either step
  answers 401.
- The credential lives in `$DSH_HOME/dsh-runtimes/agensi-mcp/config.json` (mode 0600) and
  reaches the row through a Loader `!!js` expression, so no secret is ever committed and
  the patch file stays shareable.

### Design notes

- The harness MCP client supports a URL plus static `headers` only — there is no
  `authProvider`, no token store, no interactive authorization step. That is why the
  sign-in runs outside it and the result is handed over as a bearer header.
- There is no anonymous mode and no API-key field: the endpoint only issues tokens
  through the OAuth grant above, and the bundle does not invite a credential in text.
- `failOnStartupError: false` and bounded reconnect keep the harness healthy while the
  token is missing or expired; the row reports its own transport error instead of
  aborting startup.

### Known limits

- The harness has no "Sign in" button for this row; signing in is a helper command.
  An in-panel flow needs `authProvider` support in `@deepseek-ai/dsh-mcp-client`.
- The client id is stored in `config.json`; deleting that file loses it. Registration is
  open, so the helper registers a new client instead of needing a manual step.
- Paid skills and paid tool calls are never bought automatically — the agent must ask
  the user first, and `get_skill` / `run_tool` need an explicit yes.

[0.2.1]: https://github.com/oooplz/dsh-agensi-mcp/releases/tag/v0.2.1
[0.2.0]: https://github.com/oooplz/dsh-agensi-mcp/releases/tag/v0.2.0
[0.1.0]: https://github.com/oooplz/dsh-agensi-mcp/releases/tag/v0.1.0
