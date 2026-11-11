"""Agensi MCP OAuth 2.1 sign-in helper (dynamic client registration + PKCE + localhost callback).

Usage:
    python oauth_login.py start    # register a client if needed, build the authorize URL,
                                  # listen for the callback, store the tokens
    python oauth_login.py url      # print the authorize URL for an existing pending state
    python oauth_login.py register # only do the dynamic client registration, print the id
    python oauth_login.py refresh  # refresh the stored access token (refresh_token grant)

Nothing here asks a human for a token: the access token is only ever produced by the
OAuth authorization-code exchange after the user signs in and clicks Allow. A stored
client id is reused; only a fresh DSH_HOME registers a new client.
"""

from __future__ import annotations

import base64
import hashlib
import html
import json
import os
import secrets
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

ISSUER = "https://mcp.agensi.io"
AUTHORIZE = ISSUER + "/oauth/authorize"
TOKEN = ISSUER + "/oauth/token"
REGISTER = ISSUER + "/oauth/register"
RESOURCE = ISSUER + "/mcp/auth"
SCOPE = "read install"
REDIRECT = "http://127.0.0.1:8791/callback"

HOME = os.environ.get("DSH_HOME") or os.path.join(os.path.expanduser("~"), ".dsh")
RUN_DIR = os.path.join(HOME, "dsh-runtimes", "agensi-mcp")
CONFIG = os.path.join(RUN_DIR, "config.json")
STATE = os.path.join(RUN_DIR, "oauth-state.json")
LOG = os.path.join(RUN_DIR, "plugin.log")


def log(message: str) -> None:
    os.makedirs(RUN_DIR, exist_ok=True)
    line = "%s %s\n" % (time.strftime("%Y-%m-%dT%H:%M:%S%z"), message)
    with open(LOG, "a", encoding="utf-8") as handle:
        handle.write(line)
    sys.stdout.write(line)
    sys.stdout.flush()


def post_form(url: str, fields: dict) -> tuple[int, dict]:
    body = urllib.parse.urlencode(fields).encode()
    request = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
        },
        method="POST",
    )
    return _send(request)


def post_json(url: str, payload: dict) -> tuple[int, dict]:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    return _send(request)


def _send(request: urllib.request.Request) -> tuple[int, dict]:
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            return response.status, json.loads(response.read().decode() or "{}")
    except urllib.error.HTTPError as error:
        raw = error.read().decode() or "{}"
        try:
            return error.code, json.loads(raw)
        except json.JSONDecodeError:
            return error.code, {"raw": raw}


def read_json(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return {}


def write_private(path: str, payload: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temporary = path + ".tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
    os.replace(temporary, path)
    try:
        os.chmod(path, 0o600)
    except OSError:
        # Windows ignores the mode; the file inherits the user profile ACL.
        pass


def register_client() -> tuple[str, dict]:
    """Dynamic client registration. Agensi issues public clients (`auth_method: none`),
    so there is no secret to keep and no human step: this is what makes a fresh install
    a single command."""
    status, payload = post_json(
        REGISTER,
        {
            "client_name": "DeepSeek Harness (Agensi connector)",
            "redirect_uris": [REDIRECT],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
            "scope": SCOPE,
        },
    )
    client_id = payload.get("client_id") or ""
    if status not in (200, 201) or not client_id:
        log("client registration failed: HTTP %s %s" % (status, payload))
        return "", {}
    log("registered OAuth client " + client_id)
    return client_id, payload


def resolve_client_id() -> str:
    """AGENSI_CLIENT_ID → the id already stored in config.json → a fresh registration."""
    explicit = os.environ.get("AGENSI_CLIENT_ID", "").strip()
    if explicit:
        return explicit
    stored = read_json(CONFIG).get("clientId")
    if isinstance(stored, str) and stored:
        log("reusing the registered client id from config.json")
        return stored
    client_id, _payload = register_client()
    return client_id


def build_authorize_url(state: dict) -> str:
    query = urllib.parse.urlencode(
        {
            "response_type": "code",
            "client_id": state["clientId"],
            "redirect_uri": state["redirectUri"],
            "scope": SCOPE,
            "state": state["state"],
            "code_challenge": state["codeChallenge"],
            "code_challenge_method": "S256",
            "resource": RESOURCE,
        }
    )
    return AUTHORIZE + "?" + query


def start() -> int:
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(48)).decode().rstrip("=")
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
        .decode()
        .rstrip("=")
    )
    client_id = resolve_client_id()
    if not client_id:
        log("no client id: registration failed and none is stored"); return 2

    state = {
        "clientId": client_id,
        "redirectUri": REDIRECT,
        "codeVerifier": verifier,
        "codeChallenge": challenge,
        "state": secrets.token_urlsafe(24),
        "resource": RESOURCE,
        "createdAt": int(time.time() * 1000),
    }
    write_private(STATE, state)
    url = build_authorize_url(state)
    log("authorize url ready")
    print("AUTHORIZE_URL=" + url, flush=True)

    result: dict = {}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):  # silence request logging
            return

        def do_GET(self):
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path != "/callback":
                self.send_response(404); self.end_headers(); return
            params = urllib.parse.parse_qs(parsed.query)
            code = (params.get("code") or [None])[0]
            returned = (params.get("state") or [None])[0]
            error = (params.get("error") or [None])[0]

            if error:
                result["error"] = error + ": " + (params.get("error_description") or [""])[0]
            elif not code:
                result["error"] = "callback had no code"
            elif returned != state["state"]:
                result["error"] = "state mismatch (CSRF check failed)"
            else:
                result["code"] = code

            ok = "error" not in result
            page = (
                "<!doctype html><meta charset='utf-8'><title>Agensi</title>"
                "<div style='font:16px/1.6 system-ui;padding:48px;max-width:34em'>"
                + (
                    "<h2>Agensi connected</h2><p>You can close this tab and return to DeepSeek Harness.</p>"
                    if ok
                    else "<h2>Sign-in failed</h2><p>" + html.escape(result["error"]) + "</p>"
                )
                + "</div>"
            ).encode()
            self.send_response(200 if ok else 400)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(page)))
            self.end_headers()
            self.wfile.write(page)
            threading.Thread(target=self.server.shutdown, daemon=True).start()

    port = int(urllib.parse.urlparse(REDIRECT).port or 8791)
    server = HTTPServer(("127.0.0.1", port), Handler)
    log("waiting for the sign-in callback on 127.0.0.1:%d" % port)
    server.serve_forever()

    if "error" in result:
        log("callback failed: " + result["error"]); return 3

    status, tokens = post_form(
        TOKEN,
        {
            "grant_type": "authorization_code",
            "code": result["code"],
            "redirect_uri": REDIRECT,
            "client_id": client_id,
            "code_verifier": verifier,
            "resource": RESOURCE,
        },
    )
    if status != 200 or "access_token" not in tokens:
        log("token exchange failed: HTTP %s %s" % (status, tokens)); return 4

    config = {
        "clientId": client_id,
        "redirectUri": REDIRECT,
        "resource": RESOURCE,
        "scope": tokens.get("scope", SCOPE),
        "accessToken": tokens["access_token"],
        "refreshToken": tokens.get("refresh_token"),
        # Milliseconds since epoch: the Host half (index.js) compares against Date.now().
        "expiresAt": int(time.time() * 1000) + int(tokens.get("expires_in") or 3600) * 1000,
        "obtainedAt": int(time.time() * 1000),
    }
    write_private(CONFIG, config)
    try:
        os.remove(STATE)
    except OSError:
        pass
    log("sign-in complete; token stored (expires_in=%ss)" % tokens.get("expires_in"))
    print("SIGNED_IN=1", flush=True)
    return 0


def refresh() -> int:
    config = read_json(CONFIG)
    token = config.get("refreshToken")
    if not token:
        log("no refresh token stored"); return 2
    status, tokens = post_form(
        TOKEN,
        {
            "grant_type": "refresh_token",
            "refresh_token": token,
            "client_id": config.get("clientId", ""),
            "resource": RESOURCE,
        },
    )
    if status != 200 or "access_token" not in tokens:
        log("refresh failed: HTTP %s %s" % (status, tokens)); return 4
    config["accessToken"] = tokens["access_token"]
    config["refreshToken"] = tokens.get("refresh_token") or token
    config["expiresAt"] = int(time.time() * 1000) + int(tokens.get("expires_in") or 3600) * 1000
    write_private(CONFIG, config)
    log("access token refreshed (expires_in=%ss)" % tokens.get("expires_in"))
    return 0


def register_only() -> int:
    client_id, _payload = register_client()
    if not client_id:
        return 2
    config = read_json(CONFIG)
    config.update({"clientId": client_id, "redirectUri": REDIRECT, "resource": RESOURCE})
    write_private(CONFIG, config)
    print("CLIENT_ID=" + client_id)
    return 0


def main() -> int:
    command = sys.argv[1] if len(sys.argv) > 1 else "start"
    if command == "start":
        return start()
    if command == "url":
        pending = read_json(STATE)
        if not pending:
            log("no pending authorization"); return 2
        print(build_authorize_url(pending))
        return 0
    if command == "register":
        return register_only()
    if command == "refresh":
        return refresh()
    print(__doc__)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
