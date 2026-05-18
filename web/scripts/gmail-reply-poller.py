#!/usr/bin/env python3
"""Poll Gmail for replies on threads tracked by llmTerminal sessions.

For each session in ~/.llm-terminal/sessions.json that has a gmailThreadId,
fetch the thread and look for any message that:
  - arrived after session.gmailLastSeenMs (or session.lastActive if missing)
  - was NOT sent by the session's gmailAccount (self)

If found, POST to llmTerminal's /api/sessions/<id>/reactivate so the session
moves out of the "done" pile and back into the user's attention.

Driven by gmail-reply-poller.timer (systemd) every 5 minutes.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from email.utils import parseaddr
from pathlib import Path

# camoHero auth/account helpers
CAMOHERO_ROOT = Path("/home/claude-user/projects/camoHero")
sys.path.insert(0, str(CAMOHERO_ROOT))
from data.auth import get_gmail_service  # noqa: E402
from data.accounts import load_accounts  # noqa: E402

SESSIONS_PATH = Path("/home/claude-user/.llm-terminal/sessions.json")
LLMT_BASE_URL = os.environ.get("LLMT_BASE_URL", "http://127.0.0.1:7683")
DEFAULT_ACCOUNT = "camofiles"


def _post_reactivate(session_id: str, payload: dict) -> bool:
    url = f"{LLMT_BASE_URL}/api/sessions/{session_id}/reactivate"
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return 200 <= resp.status < 300
    except urllib.error.URLError as e:
        print(f"[reactivate] {session_id}: POST failed: {e}", file=sys.stderr)
        return False


def _header(headers: list[dict], name: str) -> str:
    name_l = name.lower()
    for h in headers:
        if h.get("name", "").lower() == name_l:
            return h.get("value", "")
    return ""


def _check_thread(service, session: dict, self_email: str) -> dict | None:
    thread_id = session["gmailThreadId"]
    try:
        thr = service.users().threads().get(userId="me", id=thread_id, format="metadata",
                                            metadataHeaders=["From", "Subject", "Date"]).execute()
    except Exception as e:
        print(f"[poll] {session['id'][:8]} thread {thread_id}: {e}", file=sys.stderr)
        return None
    last_seen = int(session.get("gmailLastSeenMs") or session.get("lastActive") or 0)
    newest_reply = None
    for m in thr.get("messages", []):
        internal_ms = int(m.get("internalDate", 0))
        if internal_ms <= last_seen:
            continue
        headers = m.get("payload", {}).get("headers", [])
        from_hdr = _header(headers, "From")
        from_addr = parseaddr(from_hdr)[1].lower()
        if not from_addr or from_addr == self_email.lower():
            continue
        subj = _header(headers, "Subject")
        if newest_reply is None or internal_ms > newest_reply["ts"]:
            newest_reply = {
                "ts": internal_ms,
                "fromEmail": from_addr,
                "subject": subj,
                "snippet": m.get("snippet", "") or "",
                "messageId": m.get("id"),
            }
    return newest_reply


def main() -> int:
    if not SESSIONS_PATH.exists():
        return 0
    sessions = json.loads(SESSIONS_PATH.read_text())
    tracked = [s for s in sessions if s.get("gmailThreadId")]
    if not tracked:
        return 0
    accounts = load_accounts(CAMOHERO_ROOT / "accounts.yaml")
    by_account: dict[str, list[dict]] = {}
    for s in tracked:
        slug = s.get("gmailAccount") or DEFAULT_ACCOUNT
        by_account.setdefault(slug, []).append(s)

    reactivated = 0
    for slug, group in by_account.items():
        if slug not in accounts:
            print(f"[poll] unknown account {slug!r}; skipping {len(group)} session(s)", file=sys.stderr)
            continue
        acct = accounts[slug]
        try:
            service = get_gmail_service(acct)
        except Exception as e:
            print(f"[poll] auth failed for {slug}: {e}", file=sys.stderr)
            continue
        self_email = acct.email
        for s in group:
            reply = _check_thread(service, s, self_email)
            if not reply:
                continue
            payload = {
                "fromEmail": reply["fromEmail"],
                "subject": reply["subject"],
                "snippet": reply["snippet"],
                "messageId": reply["messageId"],
                "ts": reply["ts"],
            }
            if _post_reactivate(s["id"], payload):
                reactivated += 1
                print(f"[poll] reactivated {s['id'][:8]} ({s.get('title','')!r}) — reply from {reply['fromEmail']}")
    if reactivated:
        print(f"[poll] done — reactivated {reactivated} session(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
