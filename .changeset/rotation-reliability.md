---
'@ex-machina/opencode-anthropic-auth': patch
---

Harden multi-account rotation reliability:

- **Rotation recovery**: non-primary accounts with `rejected` rate-limit status are no longer permanently excluded from the pool — they become eligible again after `rejectedRecoveryIntervalMs` (default 60 min, matches `primaryRecoveryIntervalMs`). Set to 0 to preserve legacy permanent-exclusion behavior.
- **Circuit-breaker fan-out**: a single failed refresh attempt can no longer trip the circuit breaker multiple times when several concurrent requests share an inflight refresh. `onAttemptSuccess` / `onAttemptFailure` now fire exactly once per underlying attempt.
- **Token persistence**: local persistence failures (e.g. disk full, EACCES) during a successful remote token refresh are logged and isolated — they no longer surface as auth failures or force re-auth for the current request.
- **Streaming rewrite**: tool-name prefix stripping now works across arbitrary network chunk boundaries (previously `mcp_` could leak when a match split between chunks). Consumer cancellation is now propagated to the upstream reader, stopping wasted downloads.
- **Config mutex**: `Add Account to Pool` and `Remove Account from Pool` flows now share a mutex with the loader so concurrent token refresh can't be clobbered by a stale-snapshot write.
- **Request body rewrite**: `fetch(new Request(url, { body }))` calls now get the same system-prompt sanitization and tool-prefix injection as `fetch(url, { body })` calls.
- **Create an API Key**: the flow now returns `failed` on non-ok HTTP responses or missing `raw_key` instead of silently reporting `success` with an undefined key.
