# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.0]: https://github.com/oooplz/dsh-agensi-mcp/releases/tag/v0.1.0
