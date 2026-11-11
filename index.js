// Agensi as an MCP server for DeepSeek Harness — sign-in, token lifecycle and diagnostics.
//
// Agensi (https://mcp.agensi.io/mcp/auth) is a remote MCP endpoint protected by OAuth 2.1.
// Its discovery documents say everything a connector needs:
//
//   protected resource metadata    /.well-known/oauth-protected-resource/mcp/auth
//   authorization server metadata  /.well-known/oauth-authorization-server
//     registration_endpoint  /oauth/register   (dynamic client registration, public client)
//     code_challenge_methods S256               (PKCE required)
//     grant_types            authorization_code + refresh_token
//     scopes                 read, install
//
// The harness MCP client speaks a URL plus static `headers` only — no `authProvider`, no
// token store, no interactive step. So *this* half owns the authorization: it runs the
// authorization-code flow (registration, PKCE, a loopback callback), keeps the result in
// `$DSH_HOME/dsh-runtimes/agensi-mcp/config.json`, and hands the access token to the MCP
// row through the Loader `!!js` header expression in `cordis.patch.yml`.
//
// Two consequences shape the design:
//
// 1. A refreshed or newly obtained token only reaches the wire after the MCP row is
//    *composed* again, so every credential change is followed by
//    `pluginManager.reload(['agensi-mcp'])` — the same live reconcile the Plugin Manager's
//    own toggle performs.
// 2. The plugin page has to show what is going on without a terminal: the routes below are
//    what the card in `client.js` reads (`status`) and calls (`login`, `cancel`, `logout`).
//
// Nothing here may break harness startup: every step is wrapped, a failure is recorded in
// `status.json` / `plugin.log` and retried, and no route ever returns a token.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const ISSUER = 'https://mcp.agensi.io';
const AUTHORIZE_ENDPOINT = ISSUER + '/oauth/authorize';
const TOKEN_ENDPOINT = ISSUER + '/oauth/token';
const REGISTER_ENDPOINT = ISSUER + '/oauth/register';
const RESOURCE = ISSUER + '/mcp/auth';
const SCOPE = 'read install';
const REDIRECT_PORTS = [8791, 8792, 8793];

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const RUNTIME_DIR = path.join(DSH_HOME, 'dsh-runtimes', 'agensi-mcp');
const CONFIG_FILE = path.join(RUNTIME_DIR, 'config.json');
const STATUS_FILE = path.join(RUNTIME_DIR, 'status.json');
const LOG_FILE = path.join(RUNTIME_DIR, 'plugin.log');

/** Loader entry id of the MCP row whose `headers` carry the token. */
const MCP_ENTRY_ID = 'agensi-mcp';
const ROUTE_PREFIX = '/api/dsh-agensi-mcp';
/** Refresh this long before the token expires. */
const SKEW_MS = 5 * 60_000;
/** How often the expiry is reconsidered. */
const TICK_MS = 60_000;
/** First check shortly after activation: a token may already be stale at startup. */
const FIRST_DELAY_MS = 5_000;
/** A failed refresh (revoked grant, network error) is retried no sooner than this. */
const RETRY_MS = 10 * 60_000;
/** An abandoned authorization stops listening after this. */
const LOGIN_TIMEOUT_MS = 10 * 60_000;

/** In-flight authorization, if any. Never persisted: a restart abandons it. */
let pending = null;
/** Last failure worth showing in the card, cleared by the next success. */
let lastError = null;
let retryAfter = 0;
let busy = false;

export async function apply(ctx) {
  pluginCtx = ctx;
  registerRoutes(ctx);

  const immediate = setTimeout(() => void tick(ctx), FIRST_DELAY_MS);
  const timer = setInterval(() => void tick(ctx), TICK_MS);
  for (const handle of [immediate, timer]) {
    if (typeof handle.unref === 'function') handle.unref();
  }
  ctx?.effect?.(() => () => {
    clearTimeout(immediate);
    clearInterval(timer);
    abandonLogin('plugin unloading');
  });
}

// ── routes ────────────────────────────────────────────────────────────────────────────

/**
 * Publish the four endpoints the plugin card uses. `webServer` is optional: a headless
 * profile has no page to serve, and the token lifecycle keeps working there.
 *
 * @param {import('cordis').Context} ctx - plugin context.
 */
function registerRoutes(ctx) {
  ctx?.inject?.(['webServer'], (web) => {
    const server = web && web.webServer;
    if (!server || typeof server.register !== 'function') return;
    const routes = [
      ['GET', '/status', (res) => sendJson(res, 200, publicStatus())],
      ['POST', '/login', (res) => loginRoute(res)],
      ['POST', '/cancel', (res) => {
        abandonLogin('cancelled from the plugin page');
        sendJson(res, 200, publicStatus());
      }],
      ['POST', '/logout', (res) => logoutRoute(res)],
    ];
    for (const [method, suffix, handler] of routes) {
      try {
        const dispose = server.register({
          kind: 'exact',
          path: ROUTE_PREFIX + suffix,
          handler: (req, res) => {
            if (String(req.method || '').toUpperCase() !== method) {
              sendJson(res, 405, { ok: false, error: 'method not allowed' });
              return undefined;
            }
            // The harness closes its own routes behind a session token; these are published
            // on the same port for the card, so they must at least refuse a request that a
            // page on another site could have forged. A browser sends `Origin` on every
            // cross-origin POST; a same-origin one matches this host.
            if (!sameOrigin(req)) {
              log('rejected cross-origin ' + method + ' ' + suffix);
              sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' });
              return undefined;
            }
            try {
              return handler(res);
            } catch (error) {
              lastError = describe(error);
              log('route ' + suffix + ' failed: ' + lastError);
              return sendJson(res, 500, { ok: false, error: lastError });
            }
          },
        });
        if (typeof dispose === 'function') {
          ctx?.effect?.(() => dispose);
        }
      } catch (error) {
        log('cannot publish route ' + suffix + ': ' + describe(error));
      }
    }
  });
}

/**
 * Answer the card's only question: is a usable credential in place, until when, and is a
 * sign-in waiting for the browser? Values are derived per request — the refresh tick
 * rewrites the file underneath.
 *
 * @returns {object} public state; never contains a token.
 */
function publicStatus() {
  const config = readJson(CONFIG_FILE);
  const expiresAt = toMs(config.expiresAt);
  const signedIn = Boolean(config.accessToken) && (expiresAt === 0 || expiresAt > Date.now());
  return {
    ok: true,
    signedIn,
    configured: Boolean(config.clientId),
    registeredRedirect: config.redirectUri || null,
    expiresAt: expiresAt || null,
    expiresInSeconds: expiresAt ? Math.max(0, Math.round((expiresAt - Date.now()) / 1000)) : null,
    scope: config.scope || null,
    obtainedAt: toMs(config.obtainedAt) || null,
    refreshedAt: toMs(config.refreshedAt) || null,
    hasRefreshToken: Boolean(config.refreshToken),
    login: pending
      ? { active: true, startedAt: pending.startedAt, authorizeUrl: pending.authorizeUrl }
      : { active: false },
    error: lastError,
  };
}

/**
 * Start (or join) an authorization: bind the loopback callback, make sure a client is
 * registered for exactly that redirect URI, then hand the card a URL to open.
 *
 * @param {import('node:http').ServerResponse} res - response to answer.
 * @returns {Promise<void>} resolves after the HTTP answer is written.
 */
async function loginRoute(res) {
  if (pending) {
    sendJson(res, 200, { ...publicStatus(), authorizeUrl: pending.authorizeUrl, resumed: true });
    return;
  }
  const config = readJson(CONFIG_FILE);
  const loopback = await openLoopback();
  if (!loopback) {
    lastError = 'cannot listen on 127.0.0.1:' + REDIRECT_PORTS.join('/');
    sendJson(res, 500, { ok: false, error: lastError, ...publicStatus() });
    return;
  }
  const { server, redirectUri } = loopback;
  let clientId = config.clientId;
  if (!clientId || config.redirectUri !== redirectUri) {
    clientId = await registerClient(redirectUri);
    if (!clientId) {
      closeServer(server);
      sendJson(res, 502, { ok: false, error: lastError || 'client registration failed', ...publicStatus() });
      return;
    }
    writeConfig({ ...config, clientId, redirectUri, resource: RESOURCE });
  }
  const verifier = base64url(crypto.randomBytes(48));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  const state = base64url(crypto.randomBytes(24));
  const url = new URL(AUTHORIZE_ENDPOINT);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('resource', RESOURCE);

  pending = {
    server,
    clientId,
    redirectUri,
    verifier,
    state,
    authorizeUrl: url.toString(),
    startedAt: Date.now(),
    timer: setTimeout(() => abandonLogin('authorization timed out'), LOGIN_TIMEOUT_MS),
  };
  if (typeof pending.timer.unref === 'function') pending.timer.unref();
  log('authorization started on ' + redirectUri);
  sendJson(res, 200, { ...publicStatus(), authorizeUrl: pending.authorizeUrl });
}

/**
 * Drop the stored credential (keeping the client registration) so the row stops sending a
 * header that no longer works.
 *
 * @param {import('node:http').ServerResponse} res - response to answer.
 * @returns {Promise<void>} resolves after the HTTP answer is written.
 */
async function logoutRoute(res) {
  abandonLogin('signed out from the plugin page');
  const config = readJson(CONFIG_FILE);
  writeConfig({ clientId: config.clientId, redirectUri: config.redirectUri, resource: RESOURCE });
  lastError = null;
  log('credential cleared from the plugin page');
  await reloadRow(pluginCtx);
  sendJson(res, 200, publicStatus());
}

/** The context captured at activation, so a route can reload the MCP row. */
let pluginCtx = null;

// ── OAuth ─────────────────────────────────────────────────────────────────────────────

/**
 * Open the loopback listener the browser will be sent back to, on the first free port.
 *
 * @returns {Promise<{server: http.Server, redirectUri: string}|null>} listener, or null.
 */
async function openLoopback() {
  for (const port of REDIRECT_PORTS) {
    const server = http.createServer((req, res) => {
      void handleCallback(req, res);
    });
    try {
      await listen(server, port);
      return { server, redirectUri: 'http://127.0.0.1:' + port + '/callback' };
    } catch {
      closeServer(server);
    }
  }
  return null;
}

/**
 * Dynamic client registration for a public client (`token_endpoint_auth_method: none`),
 * so no secret exists and a fresh install needs no manual step.
 *
 * @param {string} redirectUri - exact loopback URI the browser comes back to.
 * @returns {Promise<string>} the issued client id, or '' on failure.
 */
async function registerClient(redirectUri) {
  try {
    const response = await fetch(REGISTER_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_name: 'DeepSeek Harness (Agensi connector)',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: SCOPE,
      }),
    });
    const text = await response.text();
    const payload = safeJson(text);
    if (!response.ok || !payload.client_id) {
      lastError = 'registration failed: HTTP ' + response.status;
      log(lastError + ' ' + text.slice(0, 200));
      return '';
    }
    log('registered OAuth client for ' + redirectUri);
    return String(payload.client_id);
  } catch (error) {
    lastError = 'registration unreachable: ' + describe(error);
    log(lastError);
    return '';
  }
}

/**
 * The browser's landing page: validate `state`, exchange the code, store the tokens,
 * re-compose the MCP row and show a page the user can close.
 *
 * Wrapped so a throw here becomes a page instead of an unhandled rejection inside the
 * harness process.
 *
 * @param {http.IncomingMessage} req - callback request.
 * @param {http.ServerResponse} res - response to write.
 */
async function handleCallback(req, res) {
  try {
    await completeCallback(req, res);
  } catch (error) {
    lastError = describe(error);
    log('callback failed: ' + lastError);
    respondHtml(res, 500, page('Sign-in failed', '登录失败', false, lastError));
  }
}

/**
 * @param {http.IncomingMessage} req - callback request.
 * @param {http.ServerResponse} res - response to write.
 * @returns {Promise<void>} resolves when the browser has its answer.
 */
async function completeCallback(req, res) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (url.pathname !== '/callback') {
    respondHtml(res, 404, page('Not found', '未知路径', false));
    return;
  }
  const params = url.searchParams;
  const error = params.get('error');
  const code = params.get('code');
  const returned = params.get('state');

  if (error) {
    failLogin('authorization denied: ' + error, res);
    return;
  }
  if (!pending) {
    respondHtml(res, 409, page('No sign-in in progress', '没有进行中的登录', false));
    return;
  }
  if (!code) {
    failLogin('callback had no code', res);
    return;
  }
  if (returned !== pending.state) {
    failLogin('state mismatch (CSRF check failed)', res);
    return;
  }

  const { clientId, redirectUri, verifier, server } = pending;
  const tokens = await exchangeCode(code, clientId, redirectUri, verifier);
  if (!tokens) {
    respondHtml(res, 502, page('Sign-in failed', '登录失败', false, lastError || ''));
    clearPending(server);
    return;
  }
  writeConfig({
    clientId,
    redirectUri,
    resource: RESOURCE,
    scope: tokens.scope || SCOPE,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + Number(tokens.expires_in || 3600) * 1000,
    obtainedAt: Date.now(),
  });
  lastError = null;
  retryAfter = 0;
  log('sign-in complete; token stored (expires_in=' + (tokens.expires_in || 3600) + 's)');
  clearPending(server);
  await reloadRow(pluginCtx);
  respondHtml(res, 200, page(
    'Agensi connected',
    'Agensi 已连接',
    true,
    'You can close this tab and return to DeepSeek Harness. / 可以关闭此标签页并返回 DeepSeek Harness。',
  ));
}

/**
 * Trade an authorization code for tokens.
 *
 * @param {string} code - authorization code from the callback.
 * @param {string} clientId - registered public client id.
 * @param {string} redirectUri - the exact redirect URI used in the authorize request.
 * @param {string} verifier - PKCE code verifier.
 * @returns {Promise<object|null>} token payload, or null on failure.
 */
async function exchangeCode(code, clientId, redirectUri, verifier) {
  return postToken({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
    resource: RESOURCE,
  }, 'code exchange');
}

/**
 * POST the token endpoint and return a payload with an access token, or null.
 *
 * @param {Record<string, string>} fields - form fields.
 * @param {string} label - what this attempt is, for the log.
 * @returns {Promise<object|null>} token payload or null.
 */
async function postToken(fields, label) {
  try {
    const response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams(fields).toString(),
    });
    const text = await response.text();
    const payload = safeJson(text);
    if (!response.ok || !payload.access_token) {
      lastError = label + ' rejected: HTTP ' + response.status + ' ' + (payload.error || '');
      log(lastError + ' ' + text.slice(0, 200));
      return null;
    }
    return payload;
  } catch (error) {
    lastError = label + ' unreachable: ' + describe(error);
    log(lastError);
    return null;
  }
}

// ── token lifecycle ───────────────────────────────────────────────────────────────────

/**
 * Keep the credential usable: refresh shortly before expiry, then re-compose the row so
 * the new token reaches its headers.
 *
 * @param {import('cordis').Context} ctx - plugin context.
 * @returns {Promise<void>} resolves when this pass finishes.
 */
async function tick(ctx) {
  if (busy || Date.now() < retryAfter) return;
  busy = true;
  try {
    const config = readJson(CONFIG_FILE);
    if (!config.accessToken) {
      writeStatus({ ok: false, reason: 'no-credential' });
      return;
    }
    const expiresAt = toMs(config.expiresAt);
    if (expiresAt - Date.now() > SKEW_MS) {
      writeStatus({ ok: true, credential: 'oauth', expiresAt: expiresAt || null });
      return;
    }
    if (!config.refreshToken) {
      writeStatus({ ok: false, reason: 'no-refresh-token' });
      lastError = 'refresh token missing; sign in again';
      return;
    }
    const tokens = await postToken({
      grant_type: 'refresh_token',
      refresh_token: config.refreshToken,
      client_id: String(config.clientId || ''),
      resource: RESOURCE,
    }, 'token refresh');
    if (!tokens) {
      retryAfter = Date.now() + RETRY_MS;
      writeStatus({ ok: false, reason: 'refresh-rejected', hint: 'sign in again' });
      return;
    }
    writeConfig({
      ...config,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || config.refreshToken,
      scope: tokens.scope || config.scope,
      expiresAt: Date.now() + Number(tokens.expires_in || 3600) * 1000,
      refreshedAt: Date.now(),
    });
    const reload = await reloadRow(ctx);
    log('token refreshed; re-composed ' + MCP_ENTRY_ID);
    writeStatus({
      ok: true,
      credential: 'oauth',
      expiresAt: toMs(readJson(CONFIG_FILE).expiresAt),
      refreshedAt: new Date().toISOString(),
      reload,
    });
  } catch (error) {
    log('refresh tick failed: ' + describe(error));
  } finally {
    busy = false;
  }
}

/**
 * Compose the MCP row again so the current token reaches its `headers`.
 *
 * @param {import('cordis').Context|null} ctx - plugin context.
 * @returns {Promise<{reloaded: boolean, reason?: string}>} outcome.
 */
async function reloadRow(ctx) {
  const manager = safeGet(ctx, 'pluginManager');
  if (!manager || typeof manager.reload !== 'function') {
    return { reloaded: false, reason: 'plugin manager unavailable' };
  }
  try {
    const result = await manager.reload([MCP_ENTRY_ID]);
    if (result && result.restartReason) return { reloaded: false, reason: result.restartReason };
    return { reloaded: true };
  } catch (error) {
    return { reloaded: false, reason: describe(error) };
  }
}

// ── login bookkeeping ────────────────────────────────────────────────────────────────

/**
 * Drop the in-flight authorization and stop its listener.
 *
 * @param {string} why - reason written to the log.
 */
function abandonLogin(why) {
  if (!pending) return;
  log('authorization abandoned: ' + why);
  clearPending(pending.server);
}

/**
 * Clear the in-flight authorization, keeping the answer for a caller that still writes one.
 *
 * @param {http.Server|null} server - listener to close.
 */
function clearPending(server) {
  if (pending && pending.timer) clearTimeout(pending.timer);
  pending = null;
  closeServer(server);
}

/**
 * Record a failure from inside the callback and answer the browser.
 *
 * @param {string} message - failure description.
 * @param {http.ServerResponse} res - browser response.
 */
function failLogin(message, res) {
  lastError = message;
  log('authorization failed: ' + message);
  const server = pending ? pending.server : null;
  clearPending(server);
  respondHtml(res, 400, page('Sign-in failed', '登录失败', false, message));
}

// ── plumbing ─────────────────────────────────────────────────────────────────────────

/**
 * Persist the credential file atomically with the narrowest mode the platform allows.
 *
 * @param {object} config - full file contents.
 */
function writeConfig(config) {
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    const temporary = CONFIG_FILE + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(config, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, CONFIG_FILE);
  } catch (error) {
    log('cannot write config.json: ' + describe(error));
  }
}

/**
 * Record what the lifecycle last observed, for support questions.
 *
 * @param {object} status - fields to write.
 */
function writeStatus(status) {
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    fs.writeFileSync(
      STATUS_FILE,
      JSON.stringify({ ...status, checkedAt: new Date().toISOString() }, null, 2) + '\n',
    );
  } catch {
    // Diagnostics only.
  }
}

/**
 * `expiresAt` as milliseconds since epoch. A value written in seconds by an older build
 * is recognised by magnitude, so a stale file cannot cause a refresh loop.
 *
 * @param {unknown} value - stored `expiresAt`.
 * @returns {number} milliseconds since epoch, or 0 when unreadable.
 */
function toMs(value) {
  const time = Number(value || 0);
  if (!Number.isFinite(time) || time <= 0) return 0;
  return time < 1e12 ? time * 1000 : time;
}

function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
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

/**
 * Bind one loopback port.
 *
 * @param {http.Server} server - server to start.
 * @param {number} port - preferred port.
 * @returns {Promise<number>} the bound port.
 */
function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

function closeServer(server) {
  try {
    server?.close?.(() => undefined);
    server?.closeAllConnections?.();
  } catch {
    // Already closed.
  }
}

/**
 * Whether a request may change state. The plugin's routes live on the harness port and are
 * reachable by anything that can reach loopback, so a `POST` from a page on another origin
 * is refused: `Origin` is present on every cross-origin browser request and matches this
 * host for a same-origin one. A request with no `Origin` at all is a local client (curl, a
 * test) and is allowed — it cannot carry a browser's cookies anywhere.
 *
 * @param {import('node:http').IncomingMessage} req - incoming request.
 * @returns {boolean} true when the request may mutate state.
 */
function sameOrigin(req) {
  const origin = String(req.headers.origin || '');
  if (!origin) return true;
  const host = String(req.headers.host || '');
  try {
    const parsed = new URL(origin);
    return parsed.host === host;
  } catch {
    return false;
  }
}

/**
 * Write one JSON answer.
 *
 * @param {import('node:http').ServerResponse} res - response to write.
 * @param {number} status - HTTP status.
 * @param {object} payload - JSON body.
 */
function sendJson(res, status, payload) {
  if (!res) return;
  try {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.writeHead(status);
    res.end(JSON.stringify(payload));
  } catch {
    // The browser went away.
  }
}

/**
 * Minimal bilingual landing page — the browser tab the user closes after Allow.
 *
 * @param {string} en - English heading.
 * @param {string} zh - Chinese heading.
 * @param {boolean} ok - whether this is a success.
 * @param {string} [detail] - optional extra line.
 * @returns {string} HTML document.
 */
function page(en, zh, ok, detail) {
  const colour = ok ? '#1f7a4d' : '#b3261e';
  return [
    '<!doctype html><meta charset="utf-8"><title>Agensi</title>',
    '<div style="font:16px/1.6 system-ui,sans-serif;padding:48px;max-width:34em">',
    '<h2 style="margin:0 0 8px;color:' + colour + '">' + escapeHtml(en) + ' / ' + escapeHtml(zh) + '</h2>',
    detail ? '<p style="margin:0;opacity:.75">' + escapeHtml(detail) + '</p>' : '',
    '</div>',
  ].join('');
}

function respondHtml(res, status, body) {
  try {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.writeHead(status);
    res.end(body);
  } catch {
    // The browser went away.
  }
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}
