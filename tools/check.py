"""Handshake check for the stored Agensi credential.

    python tools/check.py

Speaks the MCP handshake itself (`initialize`, `notifications/initialized`,
`tools/list`) so a broken token or route is visible without going through the model, and
prints the tool names the server offers. It makes no data-changing MCP calls; the only
thing it can write is the token store, and only when the endpoint answers 401 and the
refresh grant succeeds. The token itself is never printed.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from oauth_login import CONFIG, RESOURCE, read_json, refresh  # noqa: E402


def call(url: str, token: str, payload: dict, session: str | None = None):
    headers = {
        "content-type": "application/json",
        "accept": "application/json, text/event-stream",
        "authorization": "Bearer " + token,
    }
    if session:
        headers["mcp-session-id"] = session
    request = urllib.request.Request(
        url, data=json.dumps(payload).encode(), headers=headers, method="POST"
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.status, dict(response.headers), response.read().decode()
    except urllib.error.HTTPError as error:
        return error.code, dict(error.headers), error.read().decode()


def access_token() -> str:
    return read_json(CONFIG).get("accessToken") or ""


def call_authorized(payload: dict, session: str | None = None, label: str = "request"):
    """POST one JSON-RPC message; on 401 renew the token once and try again."""
    token = access_token()
    if not token:
        print("FAIL: config.json holds no access token — sign in with tools/oauth_login.py start")
        raise SystemExit(2)
    status, headers, body = call(RESOURCE, token, payload, session)
    if status != 401:
        return status, headers, body
    print("%s answered 401 — refreshing the access token and retrying" % label)
    if refresh() != 0:
        print("FAIL: refresh did not help; sign in again with tools/oauth_login.py start")
        raise SystemExit(3)
    return call(RESOURCE, access_token(), payload, session)


def parse(body: str) -> dict:
    """Accept both a plain JSON body and an SSE stream carrying one JSON message."""
    body = body.strip()
    if not body:
        return {}
    if body.startswith("{"):
        try:
            return json.loads(body)
        except json.JSONDecodeError:
            return {}
    for line in body.splitlines():
        if line.startswith("data:"):
            chunk = line[5:].strip()
            if chunk.startswith("{"):
                try:
                    return json.loads(chunk)
                except json.JSONDecodeError:
                    continue
    return {}


def main() -> int:
    status, headers, body = call_authorized(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "dsh-agensi-mcp-check", "version": "0.1.0"},
            },
        },
        label="initialize",
    )
    if status != 200:
        print("FAIL: initialize answered HTTP %s: %s" % (status, body[:400]))
        return 4

    session = headers.get("Mcp-Session-Id") or headers.get("mcp-session-id")
    info = parse(body).get("result", {})
    print(
        "initialize ok: server=%s protocol=%s"
        % (info.get("serverInfo", {}).get("name"), info.get("protocolVersion"))
    )

    if session:
        # The notification carries no id and expects 202/204.
        call(RESOURCE, access_token(), {"jsonrpc": "2.0", "method": "notifications/initialized"}, session)

    status, _headers, body = call_authorized(
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}, session, label="tools/list"
    )
    if status != 200:
        print("FAIL: tools/list answered HTTP %s: %s" % (status, body[:400]))
        return 5
    tools = parse(body).get("result", {}).get("tools", [])
    print("tools (%d):" % len(tools))
    for tool in tools:
        description = (tool.get("description") or "").strip().splitlines()
        first = description[0][:110] if description else ""
        print("  - %s%s" % (tool.get("name"), ": " + first if first else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
