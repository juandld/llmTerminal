I've got four unrelated services throwing errors and I haven't looked at any of them yet:

1. `billing-worker` — logs show `ECONNREFUSED` connecting to Redis every ~30s.
2. `notify-service` — a cron job that emails digests stopped running three days ago, no error logged anywhere.
3. `search-indexer` — CPU pegged at 100% since this morning, no recent deploys.
4. `auth-gateway` — users report random 401s on valid sessions, intermittent, ~2% of requests.

These are four completely separate services with no shared codebase or
dependency between them. For each one, give me your best hypothesis for the
root cause and what you'd check first to confirm it.
