# Gmail Webhook (Pub/Sub Push Notifications)

Replaces the old 5-minute polling timer. Gmail pushes notifications to our
webhook endpoint via Google Cloud Pub/Sub whenever new mail arrives.

## Prerequisites

- `gcloud` CLI installed and authenticated (`gcloud auth login`)
- GCP project `narrative-hero` with Pub/Sub API enabled
- OAuth credentials for Gmail accounts (managed by camoHero)
- llmTerminal server running at `https://terminal.camofiles.app`

## One-Time Setup

Run from the repo root:

```bash
cd web/scripts
python3 gmail-pubsub-setup.py --setup
```

This does three things:

1. **Creates Pub/Sub topic** `gmail-llmterminal-push` in project `narrative-hero`
2. **Grants publish permission** to `gmail-api-push@system.gserviceaccount.com`
   (Gmail's service account that delivers push notifications)
3. **Creates push subscription** `gmail-llmterminal-push-sub` pointing at
   `https://terminal.camofiles.app/webhooks/gmail`
4. **Calls `users.watch()`** on all OAuth accounts in `camoHero/accounts.yaml`
   to start delivering notifications

### If gcloud project isn't set

```bash
gcloud config set project narrative-hero
```

### If Pub/Sub API isn't enabled

```bash
gcloud services enable pubsub.googleapis.com --project narrative-hero
```

## Auto-Renewal

Gmail watches expire after **7 days**. The server handles renewal automatically:

- On startup (after 10s delay): calls `gmail-pubsub-setup.py --renew`
- Every 6 days: calls `gmail-pubsub-setup.py --renew`

So as long as `llm-terminal` is running, watches stay active. No cron needed.

To renew manually:

```bash
python3 web/scripts/gmail-pubsub-setup.py --renew
```

## Checking Status

```bash
python3 web/scripts/gmail-pubsub-setup.py --status
```

Output shows each account's watch state:

```
  crankwheel: ACTIVE (expires in 167.1h, historyId=531100)
```

## How It Works

1. New email arrives in a watched inbox
2. Gmail publishes to Pub/Sub topic `gmail-llmterminal-push`
3. Pub/Sub delivers POST to `https://terminal.camofiles.app/webhooks/gmail`
4. Server decodes the notification, spawns `gmail-reply-poller.py`
5. Poller checks all sessions with a `gmailThreadId` for new replies
6. If a reply is found, the session is reactivated and gets an `email_reply` message

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `7683` | Server port (poller uses this to call back to the server) |
| `LLMT_BASE_URL` | `http://127.0.0.1:$PORT` | Set automatically by server when spawning poller |

## Verifying It Works

1. **Check the webhook is reachable:**
   ```bash
   curl -s -o /dev/null -w '%{http_code}' -X POST \
     https://terminal.camofiles.app/webhooks/gmail \
     -H 'Content-Type: application/json' \
     -d '{"message":{"data":"e30="}}'
   # Should return 200
   ```

2. **Check watch state is active:**
   ```bash
   python3 web/scripts/gmail-pubsub-setup.py --status
   ```

3. **Check Pub/Sub subscription exists:**
   ```bash
   gcloud pubsub subscriptions describe gmail-llmterminal-push-sub \
     --project narrative-hero --format='value(pushConfig.pushEndpoint)'
   # Should print: https://terminal.camofiles.app/webhooks/gmail
   ```

4. **Send a test email** to a watched account and check server logs:
   ```bash
   journalctl -u llm-terminal -f --no-pager | grep gmail
   ```

## Troubleshooting

- **Watch expired**: Restart the server (auto-renews on startup) or run `--renew`
- **Notifications not arriving**: Verify subscription endpoint with gcloud command above
- **Poller errors**: Check `journalctl -u llm-terminal` for `[gmail-webhook]` lines
- **Auth failures**: Re-run OAuth flow in camoHero for the affected account
