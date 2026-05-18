#!/usr/bin/env python3
"""One-time setup + recurring watch renewal for Gmail Pub/Sub push notifications.

Usage:
  # First-time setup (creates topic + subscription + starts watch):
  python3 gmail-pubsub-setup.py --setup

  # Renew watch (run via cron every 6 days):
  python3 gmail-pubsub-setup.py --renew

  # Check status:
  python3 gmail-pubsub-setup.py --status

Requires:
  - gcloud CLI authenticated with project access
  - Existing OAuth credentials for Gmail accounts (via camoHero auth)
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

CAMOHERO_ROOT = Path("/home/claude-user/projects/camoHero")
sys.path.insert(0, str(CAMOHERO_ROOT))
from data.auth import get_gmail_service  # noqa: E402
from data.accounts import load_accounts  # noqa: E402

GCP_PROJECT = "narrative-hero"
TOPIC_NAME = "gmail-llmterminal-push"
TOPIC_FULL = f"projects/{GCP_PROJECT}/topics/{TOPIC_NAME}"
SUBSCRIPTION_NAME = "gmail-llmterminal-push-sub"
WEBHOOK_URL = "https://terminal.camofiles.app/webhooks/gmail"
STATE_FILE = Path("/home/claude-user/.llm-terminal/gmail-watch-state.json")
ACCOUNTS_YAML = CAMOHERO_ROOT / "accounts.yaml"

# Gmail grants publish access to this service account for any topic used with watch()
GMAIL_PUBLISH_SA = "gmail-api-push@system.gserviceaccount.com"


def run_gcloud(args: list[str], check: bool = True) -> subprocess.CompletedProcess:
    cmd = ["gcloud", "--project", GCP_PROJECT, "--format", "json"] + args
    result = subprocess.run(cmd, capture_output=True, text=True)
    if check and result.returncode != 0:
        print(f"gcloud error: {result.stderr}", file=sys.stderr)
        raise SystemExit(1)
    return result


def setup_topic_and_subscription():
    """Create Pub/Sub topic and push subscription (idempotent)."""
    print(f"[setup] Creating topic: {TOPIC_FULL}")
    r = run_gcloud(["pubsub", "topics", "describe", TOPIC_NAME], check=False)
    if r.returncode != 0:
        run_gcloud(["pubsub", "topics", "create", TOPIC_NAME])
        print("[setup] Topic created.")
    else:
        print("[setup] Topic already exists.")

    # Grant Gmail's service account permission to publish to this topic
    print(f"[setup] Granting publish permission to {GMAIL_PUBLISH_SA}")
    run_gcloud([
        "pubsub", "topics", "add-iam-policy-binding", TOPIC_NAME,
        "--member", f"serviceAccount:{GMAIL_PUBLISH_SA}",
        "--role", "roles/pubsub.publisher",
    ])

    # Create push subscription
    print(f"[setup] Creating push subscription: {SUBSCRIPTION_NAME} -> {WEBHOOK_URL}")
    r = run_gcloud(["pubsub", "subscriptions", "describe", SUBSCRIPTION_NAME], check=False)
    if r.returncode != 0:
        run_gcloud([
            "pubsub", "subscriptions", "create", SUBSCRIPTION_NAME,
            "--topic", TOPIC_NAME,
            "--push-endpoint", WEBHOOK_URL,
            "--ack-deadline", "30",
            "--message-retention-duration", "600s",
        ])
        print("[setup] Subscription created.")
    else:
        print("[setup] Subscription already exists.")
        # Update push endpoint in case it changed
        run_gcloud([
            "pubsub", "subscriptions", "update", SUBSCRIPTION_NAME,
            "--push-endpoint", WEBHOOK_URL,
        ])

    print("[setup] Pub/Sub infrastructure ready.")


def renew_watch():
    """Call users.watch() for all tracked Gmail accounts."""
    accounts = load_accounts(ACCOUNTS_YAML)
    state = {}
    if STATE_FILE.exists():
        try:
            state = json.loads(STATE_FILE.read_text())
        except Exception:
            state = {}

    for slug, acct in accounts.items():
        if acct.auth_method != "oauth":
            continue
        try:
            service = get_gmail_service(acct)
        except Exception as e:
            print(f"[watch] Failed to auth {slug}: {e}", file=sys.stderr)
            continue
        if service is None:
            continue

        try:
            result = service.users().watch(userId="me", body={
                "topicName": TOPIC_FULL,
                "labelIds": ["INBOX"],
            }).execute()
            expiration = int(result.get("expiration", 0))
            history_id = result.get("historyId")
            state[slug] = {
                "expiration": expiration,
                "historyId": history_id,
                "renewed_at": int(__import__("time").time() * 1000),
            }
            print(f"[watch] {slug} ({acct.email}): watch active, expires {expiration}, historyId={history_id}")
        except Exception as e:
            print(f"[watch] {slug}: watch() failed: {e}", file=sys.stderr)

    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2))
    print(f"[watch] State saved to {STATE_FILE}")


def show_status():
    """Show current watch state."""
    if not STATE_FILE.exists():
        print("No watch state found. Run --setup first.")
        return
    state = json.loads(STATE_FILE.read_text())
    import time
    now_ms = int(time.time() * 1000)
    for slug, info in state.items():
        exp = info.get("expiration", 0)
        remaining_h = max(0, (exp - now_ms) / 3600000)
        status = "ACTIVE" if exp > now_ms else "EXPIRED"
        print(f"  {slug}: {status} (expires in {remaining_h:.1f}h, historyId={info.get('historyId')})")


def main():
    parser = argparse.ArgumentParser(description="Gmail Pub/Sub setup and watch renewal")
    parser.add_argument("--setup", action="store_true", help="Create Pub/Sub topic + subscription + start watch")
    parser.add_argument("--renew", action="store_true", help="Renew users.watch() for all accounts")
    parser.add_argument("--status", action="store_true", help="Show current watch state")
    args = parser.parse_args()

    if not any([args.setup, args.renew, args.status]):
        parser.print_help()
        return

    if args.setup:
        setup_topic_and_subscription()
        renew_watch()
    elif args.renew:
        renew_watch()
    elif args.status:
        show_status()


if __name__ == "__main__":
    main()
