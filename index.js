// Keep the Agensi credential fresh, so `mcp__agensi__*` tools never die of old age.
//
// Agensi issues 1-hour bearer tokens (`expires_in: 3600`) and a refresh token. The MCP
// row in `cordis.patch.yml` reads its `Authorization` header from
// `$DSH_HOME/dsh-runtimes/agensi-mcp/config.json` at compose time, so a refreshed token
// only reaches the wire after that row is composed again. This Host half does exactly
// that, and nothing else:
//
//   refresh_token grant  ──►  config.json  ──►  pluginManager.reload(['agensi-mcp'])
//
// Design notes:
//
// * Nothing here can fail loud. The plugin must never break harness startup: every step
//   is wrapped, a failure is written to `status.json` / `plugin.log` and retried later.
// * Reloading the MCP row is the same live reconcile the Plugin Manager's toggle
//   performs — no harness restart, and unchanged tool names stay unchanged.
// * The refresh happens a few minutes *before* expiry, so a call in flight is not the
//   one that discovers the token went stale.
// * `pluginManager.reload` can only be trusted when the service is there; when it is
//   not, the refreshed token still lands in `config.json` and applies at the next
//   compose (a plugin toggle or a restart).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ISSUER = 'https://mcp.agensi.io';
const TOKEN_ENDPOINT = ISSUER + '/oauth/token';
const RESOURCE = ISSUER + '/mcp/auth';

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const RUNTIME_DIR = path.join(DSH_HOME, 'dsh-runtimes', 'agensi-mcp');
const CONFIG_FILE = path.join(RUNTIME_DIR, 'config.json');
const STATUS_FILE = path.join(RUNTIME_DIR, 'status.json');
const LOG_FILE = path.join(RUNTIME_DIR, 'plugin.log');

/** Loader entry id of the MCP row whose `headers` carry the token. */
const MCP_ENTRY_ID = 'agensi-mcp';
/** Refresh this long before the token expires. */
const SKEW_MS = 5 * 60_000;
/** How often the expiry is reconsidered. */
const TICK_MS = 60_000;
/** First check shortly after activation: a token may already be stale at startup. */
const FIRST_DELAY_MS = 5_000;
/** A failed refresh (revoked grant, network error) is retried no sooner than this. */
const RETRY_MS = 10 * 60_000;

export function apply(ctx) {
  let busy = false;
  let retryAfter = 0;

  const tick = async () => {
    if (busy || Date.now() < retryAfter) return;
    busy = true;
    try {
      const config = readJson(CONFIG_FILE);
      if (!config.accessToken) {
        // Nothing to renew: the sign-in has not happened in this DSH_HOME.
        writeStatus({ ok: false, reason: 'no-credential' });
        return;
      }
      const expiresAt = toMs(config.expiresAt);
      if (expiresAt - Date.now() > SKEW_MS) {
        writeStatus({
          ok: true,
          credential: 'oauth',
          expiresAt: expiresAt || null,
          clientId: config.clientId || null,
        });
        return;
      }
      const renewed = await refresh(config);
      if (!renewed) {
        retryAfter = Date.now() + RETRY_MS;
        return;
      }
      writeFile(renewed);
      log('access token refreshed; expires in ' + Math.round(((renewed.expiresAt || 0) - Date.now()) / 1000) + 's');
      const reload = await reloadRow(ctx);
      writeStatus({
        ok: true,
        credential: 'oauth',
        expiresAt: renewed.expiresAt || null,
        refreshedAt: new Date().toISOString(),
        reload,
      });
    } catch (error) {
      log('refresh tick failed: ' + describe(error));
    } finally {
      busy = false;
    }
  };

  const immediate = setTimeout(() => void tick(), FIRST_DELAY_MS);
  const timer = setInterval(() => void tick(), TICK_MS);
  for (const handle of [immediate, timer]) {
    if (typeof handle.unref === 'function') handle.unref();
  }
  ctx?.effect?.(() => () => {
    clearTimeout(immediate);
    clearInterval(timer);
  });
}

/**
 * Exchange the stored refresh token for a new access token.
 *
 * @param {object} config - current `config.json` contents.
 * @returns {Promise<object|null>} the rewritten config, or null when the grant failed.
 */
async function refresh(config) {
  const refreshToken = config.refreshToken;
  if (!refreshToken) {
    log('no refresh token stored — sign in again with tools/oauth_login.py start');
    writeStatus({ ok: false, reason: 'no-refresh-token' });
    return null;
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: String(config.clientId || ''),
    resource: RESOURCE,
  });
  let response;
  try {
    response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: body.toString(),
    });
  } catch (error) {
    log('token endpoint unreachable: ' + describe(error));
    writeStatus({ ok: false, reason: 'unreachable' });
    return null;
  }
  const text = await response.text();
  let payload = {};
  try {
    payload = JSON.parse(text);
  } catch {
    payload = {};
  }
  if (!response.ok || !payload.access_token) {
    // An invalid_grant means the authorization was revoked: only a new sign-in helps,
    // and retrying every minute would just fill the log.
    log('refresh rejected: HTTP ' + response.status + ' ' + (payload.error || text.slice(0, 160)));
    writeStatus({
      ok: false,
      reason: payload.error || 'refresh-rejected',
      status: response.status,
      hint: 'sign in again: python tools/oauth_login.py start',
    });
    return null;
  }
  return {
    ...config,
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token || refreshToken,
    scope: payload.scope || config.scope,
    // Milliseconds since epoch, the unit this half compares against Date.now().
    expiresAt: Date.now() + Number(payload.expires_in || 3600) * 1000,
    refreshedAt: Date.now(),
  };
}

/**
 * `expiresAt` as milliseconds since epoch. The OAuth helper writes milliseconds; an
 * `expiresAt` written by an older helper (seconds) is recognised by magnitude rather
 * than trusted blindly, so a stale file cannot cause a refresh loop.
 *
 * @param {unknown} value - stored `expiresAt`.
 * @returns {number} milliseconds since epoch, or 0 when unreadable.
 */
function toMs(value) {
  const time = Number(value || 0);
  if (!Number.isFinite(time) || time <= 0) return 0;
  return time < 1e12 ? time * 1000 : time;
}

/**
 * Compose the MCP row again so the new token reaches its `headers`.
 * Same live path as the Plugin Manager toggle; a missing service is not an error.
 */
async function reloadRow(ctx) {
  const manager = safeGet(ctx, 'pluginManager');
  if (!manager || typeof manager.reload !== 'function') {
    return { reloaded: false, reason: 'plugin manager unavailable' };
  }
  try {
    const result = await manager.reload([MCP_ENTRY_ID]);
    if (result && result.restartReason) {
      return { reloaded: false, reason: result.restartReason };
    }
    log('re-composed MCP entry ' + MCP_ENTRY_ID + ' with the refreshed token');
    return { reloaded: true };
  } catch (error) {
    return { reloaded: false, reason: describe(error) };
  }
}

function writeFile(config) {
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    const temporary = CONFIG_FILE + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(config, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, CONFIG_FILE);
  } catch (error) {
    log('cannot write config.json: ' + describe(error));
  }
}

function writeStatus(status) {
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    fs.writeFileSync(STATUS_FILE, JSON.stringify({ ...status, checkedAt: new Date().toISOString() }, null, 2) + '\n');
  } catch {
    // Diagnostics only.
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function safeGet(ctx, name) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get(name) : undefined;
  } catch {
    return undefined;
  }
}

function describe(error) {
  return error?.cause?.code || error?.message || String(error);
}

function log(message) {
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, '[' + new Date().toISOString() + '] ' + message + '\n');
  } catch {
    // Diagnostics only.
  }
}
