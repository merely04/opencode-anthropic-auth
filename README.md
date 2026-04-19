# OpenCode Anthropic Auth Plugin

An [OpenCode](https://github.com/anomalyco/opencode) plugin that provides Anthropic OAuth authentication, enabling Claude Pro/Max users to use their subscription directly with OpenCode.

> [!IMPORTANT]
> If you are seeing issues, please try to `rm -rf ~/.cache/opencode` and check your `opencode.json` config to make sure you're on the latest version.
>
> Try this FIRST before making an Issue. Thanks!

## Usage

Add the plugin to your OpenCode configuration:

```json
{
  "plugin": ["@ex-machina/opencode-anthropic-auth"]
}
```

> [!TIP]
> It is STRONGLY advised that you pin the plugin to a version. This will keep you from getting automatic updates; however, this will protect you from nefarious updates.
>
> This holds true for ANY OpenCode plugin. If you do not pin them, OpenCode will automatically update them on startup. It's a massive vulnerability waiting to happen.

#### Example of pinned version

```json
{
  "plugin": ["@ex-machina/opencode-anthropic-auth@1.7.3"]
}
```

## Authentication Methods

The plugin provides three authentication options:

- **Claude Pro/Max** - OAuth flow via `claude.ai` for Pro/Max subscribers. Uses your existing subscription at no additional API cost.
- **Create an API Key** - OAuth flow via `console.anthropic.com` that creates an API key on your behalf.
- **Manually enter API Key** - Standard API key entry for users who already have one.

## Configuration

The plugin supports the following environment variables:

| Variable                          | Description                                                                                                                                                                                 |
|-----------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `ANTHROPIC_BASE_URL`              | Override the API endpoint URL (e.g. for proxying). Must be a valid HTTP(S) URL.                                                                                                             |
| `ANTHROPIC_INSECURE`              | Set to `1` or `true` to skip TLS certificate verification. Only effective when `ANTHROPIC_BASE_URL` is also set.                                                                            |

## How It Works

For Claude Pro/Max authentication, the plugin:

1. Initiates a PKCE OAuth flow against Anthropic's authorization endpoint
2. Exchanges the authorization code for access and refresh tokens
3. Automatically refreshes expired tokens
4. Injects the required OAuth headers and beta flags into API requests
5. Sanitizes the system prompt for compatibility (see below)
6. Zeros out model costs (since usage is covered by the subscription)

### System Prompt Sanitization

The Anthropic API for Max subscriptions has specific requirements for the system prompt to identify as Claude Code. The plugin rewrites the system prompt on each request using an **anchor-based** approach that minimizes what gets changed:

1. **Identity swap** — The OpenCode identity line is removed and replaced with the Claude Code identity.
2. **Paragraph removal by anchor** — Any paragraph containing a known URL anchor (e.g. `github.com/anomalyco/opencode`, `opencode.ai/docs`) is removed entirely. This is resilient to upstream rewording — as long as the anchor URL appears somewhere in the paragraph, the removal works regardless of surrounding text changes.
3. **Inline text replacements** — Short branded strings inside paragraphs we want to keep are replaced (e.g. "OpenCode" → "the assistant" in the professional objectivity section).

Everything else in the system prompt is preserved: tone/style guidance, task management instructions, tool usage policy, environment info, skills, user/project instructions, and file paths containing "opencode". The sanitized system prompt is structured as three blocks in `system[]`: the billing header, the Claude Code identity line, and the remaining system content.

## Multi-Account Rotation

### Overview

The plugin supports a pool of Claude Max accounts. When one account approaches its rate limit (5-hour or 7-day window), the plugin automatically switches to the least-utilized account for the next request. This keeps you working without manual intervention when one account's quota runs low.

### Setup

1. Log in normally using **Claude Pro/Max** to set up your first account.
2. Open the auth menu and select **Add Account to Pool** to add additional accounts. The first time you do this, your current credentials are automatically imported as the first entry.
3. Repeat for each additional account.

This creates `~/.config/opencode/anthropic-accounts.json`, which stores all account credentials and rotation state.

### How It Works

- Every API response is inspected for Anthropic rate-limit headers.
- When utilization exceeds the configured threshold (default: 80%), the plugin proactively switches to the least-utilized account before the next request.
- On a `429` response, the plugin immediately switches accounts and retries.
- The first account in `accounts[]` is treated as the primary account. Reorder the array in `anthropic-accounts.json` to change which account the plugin prefers to return to.
- The strategy is **sticky** — the plugin stays on one account until limits are hit, which preserves the prompt cache.
- A background refresh runs every 45 minutes to keep inactive accounts' tokens alive, so they are ready for an immediate switch when needed.

### Configuration

`~/.config/opencode/anthropic-accounts.json`:

```json
{
  "version": 1,
  "activeAccountId": "uuid-of-active-account",
  "thresholds": {
    "fiveHour": 0.80,
    "sevenDay": 0.80
  },
  "proactiveSwitch": true,
  "maxRetries": 1,
  "accounts": [
    {
      "id": "uuid",
      "label": "team-account-1",
      "refresh": "...",
      "access": "...",
      "expires": 1234567890000,
      "addedAt": "2026-04-17T12:00:00.000Z"
    }
  ]
}
```

| Option | Description | Default |
|---|---|---|
| `thresholds.fiveHour` | Utilization threshold for the 5-hour window (0.0–1.0) | `0.80` |
| `thresholds.sevenDay` | Utilization threshold for the 7-day window (0.0–1.0) | `0.80` |
| `proactiveSwitch` | Switch accounts proactively based on utilization headers. Set to `false` to only switch on actual `429` errors. | `true` |
| `maxRetries` | Maximum number of account switches to attempt on a `429` | `1` |
| `primaryRecoveryIntervalMs` | How often to check if the primary (first) account has recovered, in ms. Set to `0` to disable. | `3600000` (60 min) |

### Managing Accounts

- **Add an account**: Select **Add Account to Pool** from the auth menu.
- **Remove an account**: Select **Remove Account from Pool** from the auth menu.

### Security

> [!WARNING]
> Account credentials (including refresh tokens) are stored in plaintext in `~/.config/opencode/anthropic-accounts.json`. This is consistent with how OpenCode stores credentials in its own state directory. Ensure appropriate file permissions on this file.

### Backward Compatibility

- Without a config file, the plugin behaves identically to before.
- A config file with a single account also uses the original code path.
- Multi-account rotation only activates with 2 or more accounts in the pool.

## Development

### Local Testing

Use `bun run dev` to test plugin changes locally without publishing to npm:

```bash
bun run dev
```

This does three things:

1. Builds the plugin
2. Symlinks the build output into `.opencode/plugins/` so OpenCode loads it as a local plugin
3. Starts `tsc --watch` for automatic rebuilds on source changes

After starting the dev script, restart OpenCode in this project directory to pick up the local build. Any edits to `src/` will trigger a rebuild — restart OpenCode again to load the new version.

Ctrl+C stops the watcher and cleans up the symlink. If the process was killed without cleanup (e.g. `kill -9`), you can manually remove the symlink:

```bash
bun run dev:clean
```

> [!NOTE]
> If you have the npm version of this plugin in your global OpenCode config, both will load. The local version takes precedence for auth handling.

### Publishing

This project uses [changesets](https://github.com/changesets/changesets) for versioning and publishing. See the [changeset README](.changeset/README.md) for more details.

```bash
bun change          # create a changeset describing your changes
```

When changesets are merged to `main`, CI will automatically open a release PR. Merging that PR publishes to npm.

## License

MIT
