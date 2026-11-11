# dsh-agensi-mcp

Agensi — the skill marketplace at [agensi.io](https://www.agensi.io) — as native
`mcp__agensi__*` tools inside DeepSeek Harness. One remote MCP endpoint, spoken to
directly by the harness's own MCP client over Streamable HTTP; this bundle supplies the
row and the one thing the harness cannot do by itself: an OAuth 2.1 sign-in.

```
tools/oauth_login.py         OAuth 2.1 (DCR + PKCE + localhost callback)  ──►  $DSH_HOME/dsh-runtimes/agensi-mcp/config.json  (0600 on POSIX)
                                                                                        │  read at compose time
                                                                                        ▼
cordis.patch.yml   ──  @deepseek-ai/dsh-mcp-client (streamable-http, bearer header)  ──►  https://mcp.agensi.io/mcp/auth
                    ▲
index.js (Host half)  refresh_token grant a few minutes before expiry ──► pluginManager.reload(['agensi-mcp'])
```

Two rows, in this order: `dsh-agensi-mcp` (the Host half, `index.js`) and `agensi-mcp`
(the MCP connection).

## Why a sign-in step exists at all

`https://mcp.agensi.io/mcp/auth` answers an unauthenticated request with

```
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer resource_metadata="https://mcp.agensi.io/.well-known/oauth-protected-resource/mcp/auth", scope="read install"
```

The harness MCP client accepts a `url` and static `headers`; it has no interactive
authorization step and no token store. So the authorization-code flow runs once, out of
band, and leaves a bearer token in a private file that the row reads. Nothing in this
repository, and nothing in the conversation, ever holds the token.

There is deliberately **no anonymous mode** and **no API-key field**: the endpoint only
issues tokens through the OAuth grant described above.

## Sign in

The client is a public client (`token_endpoint_auth_method: none`), so registration is
open and needs no secret — `start` registers one itself if `config.json` holds no client
id yet:

```powershell
python tools/oauth_login.py start
```

`start` prints `AUTHORIZE_URL=…`. Open it, sign in to Agensi, click **Allow**; the browser
lands on `http://127.0.0.1:8791/callback`, the helper writes `config.json` and prints
`SIGNED_IN=1`. The client id is stored with the tokens and reused on later runs; set
`AGENSI_CLIENT_ID` to register against a specific id instead, or run
`python tools/oauth_login.py register` to only do the registration.

Then install this bundle and confirm the tools:

```powershell
dsh plugin --profile <profile> add dsh-agensi-mcp@latest
# or, inside a session, from a local checkout:
#   plugin_manager install_bundle  file:C:/path/to/dsh-agensi-mcp
```

```
mcp__agensi__search_skills   (or whichever tool names tools/list returns)
```

## Renew

Access tokens live **1 hour** (`expires_in: 3600`). The Host half (`index.js`) checks once
a minute and, five minutes before expiry, runs the `refresh_token` grant, rewrites
`config.json` and re-composes the `agensi-mcp` row — so the tools keep working across a
long session with no user action. `status.json` records the outcome (`expiresAt`,
`refreshedAt`, `reload`).

Manual paths, when the Host half cannot help (it is disabled, or the harness is not
running):

```powershell
python tools/oauth_login.py refresh   # refresh_token grant, rewrites config.json
python tools/check.py                 # initialize + tools/list, refreshes on 401 once
```

After a manual refresh, toggle this bundle off and on in the Plugin Manager
(`plugin_manager` `set_bundle`) so the new token reaches the row's `headers`. If the grant
was revoked, `refresh` reports an invalid grant: run `start` again for a fresh sign-in.

## Files

| Path | Role |
| :-- | :-- |
| `cordis.patch.yml` | Inserts the Host half, then the `@deepseek-ai/dsh-mcp-client` row (`serverName: agensi`, `streamable-http`, bearer header from `config.json`) |
| `index.js` | Host half: renews the token before expiry and re-composes the MCP row |
| `tools/oauth_login.py` | OAuth 2.1 helper: `start` / `url` / `refresh` |
| `tools/check.py` | Handshake check (`initialize` + `tools/list`) that prints tool names and changes no MCP data; it may renew the stored token once, on a 401 |
| `locale/{en,zh}.json` | Plugin title and description |
| `$DSH_HOME/dsh-runtimes/agensi-mcp/config.json` | Runtime token store, mode `0600` on POSIX (on Windows the file inherits the user profile ACL) — not part of the repository |
| `$DSH_HOME/dsh-runtimes/agensi-mcp/status.json` | What the Host half last observed |
| `$DSH_HOME/dsh-runtimes/agensi-mcp/plugin.log` | Append-only trail: sign-in, each renewal, each row re-compose (a renewal logs two lines) |

## Install and develop

```powershell
# users: from the registry (the harness holds back very fresh releases, so pin if needed)
dsh plugin --profile <profile> add dsh-agensi-mcp@0.1.0

# developers: install a local checkout; the profile keeps a copy, so re-install after edits
plugin_manager install_bundle  file:C:/project/dsh-plugins/dsh-agensi-mcp
# pick up an edit: remove + install again, or overwrite the installed copy (rm first),
# then toggle the bundle off and on
```

Requirements: nothing beyond what the harness already ships — the Host half runs inside it,
the MCP connection borrows its MCP client, and the bundle has no runtime dependencies —
plus Python 3.9+ for the one-time sign-in helper.

`expiresAt` in `config.json` is **milliseconds** since epoch, the unit `index.js`
compares against `Date.now()`. An `expiresAt` in seconds is recognised by magnitude
(`toMs`), so an older file cannot cause a refresh loop.

## Known limits

- The harness cannot show a "Sign in" button for this row; sign-in is the helper command
  above. A harness-side OAuth connector would need `authProvider` support in
  `@deepseek-ai/dsh-mcp-client`, which it does not have today.
- The client id lives in `config.json` alongside the tokens; delete that file and it is
  gone. Registration is open, so `start` simply registers a new client.
- Buying or paying for a skill is never automatic: `get_skill` is only called after an
  explicit "yes" from the user.
