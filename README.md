# dsh-agensi-mcp

[Agensi](https://www.agensi.io) — the skill marketplace — as native `mcp__agensi__*` tools in
**DeepSeek Harness**, with a **sign-in card in the plugin page**: status, expiry time and a
button, no terminal and no pasted token.

English · [中文说明](README.zh.md)

```
plugin page (client.js)                Host half (index.js)                     MCP row
  status · expiry · [Sign in]  ──►  OAuth 2.1: register → PKCE → loopback  ──►  @deepseek-ai/dsh-mcp-client
                                    │                                          streamable-http
                                    └─► $DSH_HOME/dsh-runtimes/agensi-mcp/config.json ──► Authorization: Bearer …
                                        (tokens, 0600)                                   https://mcp.agensi.io/mcp/auth
```

## What you get

One Streamable HTTP MCP connection to `https://mcp.agensi.io/mcp/auth`. The server advertises
**25 tools**; the ones that matter day to day:

| Purpose | Tools |
| :-- | :-- |
| Find and load a skill | `search_skills`, `get_skill`, `list_categories`, `get_popular`, `get_creator` |
| What the account owns | `my_library`, `my_credits`, `my_skills` |
| Paid tools (quoted, user-approved) | `find_tools`, `skill_tools`, `quote_tool`, `run_tool`, `check_job`, `quote_status` |
| Publishing skills | `submit_skill`, `update_skill`, `edit_changelog`, `upload_skill_media`, `creator_status`, `set_skill_tools` |
| Feedback | `skill_feedback`, `review_skill`, `submit_skill_request` |

Nothing here spends money on its own: paid skills and paid tool calls wait for an explicit
"yes" from the user.

## Install

```powershell
dsh plugin --profile <profile> add dsh-agensi-mcp
```

Then open **Settings → Plugins → Agensi**. The card appears under the plugin's description.
Requirements: a DeepSeek Harness build with the Web UI. No extra runtime, no Python, no SDK —
the plugin has no dependencies.

## Sign in

1. Open the Agensi plugin page.
2. Click **Sign in to Agensi** — a new tab opens on Agensi.
3. Sign in and click **Allow**.
4. That tab shows *Agensi connected / Agensi 已连接*; close it. The card flips to
   **Signed in** within a couple of seconds.

What happens in between, so nothing is a black box:

- the plugin registers a **public OAuth client** through Agensi's dynamic registration
  endpoint (no secret exists, nothing to copy);
- it binds a **loopback listener** on `127.0.0.1:8791` (or 8792/8793 if taken) and sends the
  browser there as the redirect URI, with **PKCE (S256)** and the RFC 8707 `resource`
  indicator;
- the authorization code is exchanged inside the harness process; tokens are written to
  `$DSH_HOME/dsh-runtimes/agensi-mcp/config.json` (mode `0600` on POSIX);
- the MCP row is re-composed so the new bearer token is used immediately.

Other buttons: **Sign in again** (re-authorize without signing out first), **Sign out** (clears
the stored tokens, keeps the client registration), **Cancel** while a browser round-trip is
pending.

## What the card shows

| Field | Meaning |
| :-- | :-- |
| Status dot + label | `Signed in` / `Not signed in` / `Expired` |
| Expires | local time of expiry plus a countdown (`15:42 · 42 min left`) |
| Scopes | what the token was granted (`read install`) |
| Error line | the last sign-in or renewal failure, verbatim |

The card polls the host: every 15 s when idle, every 2 s while a sign-in is waiting for the
browser.

## Token renewal

Agensi access tokens live **1 hour**. The Host half refreshes through the refresh-token grant
five minutes before expiry, rewrites the token file and re-composes the MCP row, so a long
session keeps working without the user doing anything. A failed renewal is logged, recorded
in `status.json`, and retried after ten minutes. If the grant was revoked, the card says so and
**Sign in again** is the fix.

## Languages

The card follows the **harness UI language** (Settings → General → Language), not the OS:
English and Chinese are built in, and a language switch repaints live cards immediately.

- UI copy lives in the `I18N` table in `client.js` (a client half cannot import modules).
- `locale/en.json` and `locale/zh.json` carry the plugin title and description shown in the
  plugin list before activation.
- To add a language: add a dictionary under its key in `I18N`, plus `locale/<lang>.json` with
  `meta.title` / `meta.description`. Keys fall back to English.

## Privacy

- The token exists in exactly one place: `config.json` under `$DSH_HOME/dsh-runtimes/agensi-mcp/`.
  It is never committed, never logged, and never returned by the plugin's routes — `status`
  exposes times and scopes only.
- The plugin talks to `mcp.agensi.io` and nothing else. It sends no telemetry.
- Signing out deletes the tokens from that file.

## Files

Repository:

| Path | Role |
| :-- | :-- |
| `cordis.patch.yml` | Inserts the Host half, then the `@deepseek-ai/dsh-mcp-client` row (bearer header read from the token file) |
| `index.js` | Host half: OAuth flow, renewal, `status`/`login`/`cancel`/`logout` routes |
| `client.js` | Plugin-page card: status, expiry, sign-in/sign-out, i18n |
| `locale/{en,zh}.json` | Plugin title and description |
| `icon.svg` | Plugin icon |

Runtime (created on demand, not part of the repository):

| Path | Meaning |
| :-- | :-- |
| `$DSH_HOME/dsh-runtimes/agensi-mcp/config.json` | Client id, tokens, expiry — mode `0600` on POSIX, profile ACL on Windows |
| `$DSH_HOME/dsh-runtimes/agensi-mcp/status.json` | What the last renewal pass observed |
| `$DSH_HOME/dsh-runtimes/agensi-mcp/plugin.log` | Append-only trail: sign-in, renewal, row re-compose, failures |

## Troubleshooting

| Symptom | Cause | Fix |
| :-- | :-- | :-- |
| Card says *cannot listen on 127.0.0.1:8791–8793* | something else owns those ports | close it, then click Sign in again |
| Card stays *Waiting for the browser…* | the tab was closed before Allow | click the link in the card, or Cancel and retry |
| Card shows *Signed in* but tools fail with 401 | the grant was revoked while the token still looked valid | **Sign in again** |
| No `mcp__agensi__*` tools at all | the MCP row did not connect | toggle the plugin off and on; read `plugin.log` |
| *The plugin host did not answer* | the Host half is disabled or the harness is headless | check `status.json` |

Ports can be inspected with `netstat -ano | findstr :8791` on Windows.

## Development

```powershell
git clone https://github.com/oooplz/dsh-agensi-mcp
cd dsh-agensi-mcp
```

A profile keeps a copy of an installed bundle, so publishing an edit means re-installing:

```
plugin_manager install_bundle  file:<path-to-your-checkout>
```

Toggling the bundle off and on picks up a change in a running harness. `node --check
index.js` and `node --check client.js` catch syntax errors before that.

## Known limits

- The card is served by the harness Web UI; a headless profile can still renew tokens but has
  no page to show.
- The OAuth client registration belongs to the token file. Delete that file and the plugin
  registers a new client on the next sign-in — nothing to recover by hand.
- Buying skills and paid tool calls is always a separate, explicit confirmation.

## License

MIT
