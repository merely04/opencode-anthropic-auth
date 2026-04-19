import type { Plugin } from '@opencode-ai/plugin'
import {
  addAccount,
  createAccountRefresher,
  createInitialConfig,
  createMutex,
  getActiveAccount,
  isAuthError,
  loadConfig,
  refreshWithThrottle,
  removeAccount,
  saveConfig,
  switchActiveAccount,
} from './accounts.ts'
import { authorize, exchange } from './auth.ts'
import { CLIENT_ID, TOKEN_URL } from './constants.ts'
import { parseRateLimitHeaders } from './ratelimit.ts'
import { createRotationManager } from './rotation.ts'
import {
  createStrippedStream,
  isInsecure,
  mergeHeaders,
  rewriteRequestBody,
  rewriteUrl,
  setOAuthHeaders,
} from './transform.ts'
import type { AccountCredentials } from './types.ts'

export const AnthropicAuthPlugin: Plugin = async ({ client }) => {
  let capturedGetAuth:
    | (() => Promise<{
        type: string
        access?: string
        refresh?: string
        expires?: number
      }>)
    | null = null
  const backgroundTimers: {
    timeout: ReturnType<typeof setTimeout> | null
    interval: ReturnType<typeof setInterval> | null
  } = {
    timeout: null,
    interval: null,
  }

  return {
    auth: {
      provider: 'anthropic',
      async loader(
        getAuth: () => Promise<{
          type: string
          access?: string
          refresh?: string
          expires?: number
        }>,
        provider: { models: Record<string, { cost: unknown }> },
      ) {
        capturedGetAuth = getAuth
        if (backgroundTimers.timeout) {
          clearTimeout(backgroundTimers.timeout)
          backgroundTimers.timeout = null
        }
        if (backgroundTimers.interval) {
          clearInterval(backgroundTimers.interval)
          backgroundTimers.interval = null
        }

        const auth = await getAuth()
        if (auth.type === 'oauth') {
          // zero out cost for max plan
          for (const model of Object.values(provider.models)) {
            model.cost = {
              input: 0,
              output: 0,
              cache: {
                read: 0,
                write: 0,
              },
            }
          }

          const loadedConfig = await loadConfig()
          if (loadedConfig.status === 'invalid') {
            throw new Error(
              `Invalid anthropic multi-account config: ${loadedConfig.error}`,
            )
          }

          if (
            loadedConfig.status === 'ok' &&
            loadedConfig.config.accounts.length >= 2
          ) {
            const config = loadedConfig.config
            const mutex = createMutex()
            const refresher = createAccountRefresher({
              onTokensRefreshed: async (accountId, tokens) => {
                const release = await mutex.acquire()
                try {
                  const account = config.accounts.find(
                    (item) => item.id === accountId,
                  )
                  if (account) {
                    account.refresh = tokens.refresh
                    account.access = tokens.access
                    account.expires = tokens.expires
                  }

                  await saveConfig(config)

                  if (config.activeAccountId === accountId) {
                    // biome-ignore lint/suspicious/noExplicitAny: SDK types don't expose auth.set
                    await (client as any).auth.set({
                      path: { id: 'anthropic' },
                      body: {
                        type: 'oauth',
                        refresh: tokens.refresh,
                        access: tokens.access,
                        expires: tokens.expires,
                      },
                    })
                  }
                } finally {
                  release()
                }
              },
            })

            const rotation = createRotationManager({ config })

            const setClientAuth = async (account: AccountCredentials) => {
              // biome-ignore lint/suspicious/noExplicitAny: SDK types don't expose auth.set
              await (client as any).auth.set({
                path: { id: 'anthropic' },
                body: {
                  type: 'oauth',
                  refresh: account.refresh,
                  access: account.access,
                  expires: account.expires,
                },
              })
            }

            const switchToAccount = async (
              accountId: string,
            ): Promise<AccountCredentials | null> => {
              const release = await mutex.acquire()
              try {
                Object.assign(config, switchActiveAccount(config, accountId))
                await saveConfig(config)

                const nextActive = getActiveAccount(config)
                if (nextActive) {
                  await setClientAuth(nextActive)
                }

                return nextActive
              } finally {
                release()
              }
            }

            const findNextAvailableAccountId = (
              currentAccountId: string,
            ): string | null => {
              const currentIndex = config.accounts.findIndex(
                (account) => account.id === currentAccountId,
              )
              if (currentIndex === -1) {
                return null
              }

              for (let offset = 1; offset < config.accounts.length; offset++) {
                const account =
                  config.accounts[
                    (currentIndex + offset) % config.accounts.length
                  ]
                if (account && !rotation.isDisabled(account.id)) {
                  return account.id
                }
              }

              return null
            }

            const ensureActiveAccountAccess = async (
              account: AccountCredentials,
            ): Promise<AccountCredentials> => {
              let active = account

              while (!active.access || active.expires < Date.now()) {
                if (rotation.isDisabled(active.id)) {
                  const nextAccountId = findNextAvailableAccountId(active.id)
                  if (nextAccountId) {
                    const nextActive = await switchToAccount(nextAccountId)
                    if (nextActive) {
                      active = nextActive
                      continue
                    }
                  }
                }

                try {
                  await refresher.refresh(active)
                  rotation.recordSuccess(active.id)
                  const refreshed =
                    config.accounts.find(
                      (account) => account.id === active.id,
                    ) ?? active
                  return refreshed
                } catch (error) {
                  if (isAuthError(error)) {
                    rotation.recordFailure(active.id)
                  } else {
                    throw error
                  }

                  if (!rotation.isDisabled(active.id)) {
                    throw error
                  }

                  const nextAccountId = findNextAvailableAccountId(active.id)
                  if (!nextAccountId) {
                    throw error
                  }

                  const nextActive = await switchToAccount(nextAccountId)
                  if (!nextActive) {
                    throw error
                  }

                  active = nextActive
                }
              }

              return active
            }

            // Background refresh keeps inactive accounts' tokens alive.
            // Access tokens expire after ~1 hour; refresh tokens can be
            // invalidated after prolonged inactivity.  Running every 45
            // minutes ensures every account always has a valid token
            // ready for an immediate switch.
            const REFRESH_MARGIN_MS = 10 * 60 * 1000
            const REFRESH_INTERVAL_MS = 45 * 60 * 1000
            const REFRESH_CONCURRENCY = 3

            const refreshAllAccounts = async () => {
              const accountsToRefresh = config.accounts.filter((account) => {
                if (rotation.isDisabled(account.id)) {
                  return false
                }

                return (
                  !account.access ||
                  account.expires <= Date.now() + REFRESH_MARGIN_MS
                )
              })

              const results = await refreshWithThrottle(
                accountsToRefresh,
                (account) => refresher.refresh(account),
                REFRESH_CONCURRENCY,
              )

              for (const result of results) {
                if (result.success) {
                  rotation.recordSuccess(result.accountId)
                  continue
                }

                if (isAuthError(result.error)) {
                  rotation.recordFailure(result.accountId)
                }
              }
            }

            // Kick off an initial background refresh shortly after startup
            // so inactive accounts are ready before the first rate-limit event.
            backgroundTimers.timeout = setTimeout(refreshAllAccounts, 5_000)
            backgroundTimers.interval = setInterval(
              refreshAllAccounts,
              REFRESH_INTERVAL_MS,
            )

            return {
              apiKey: '',
              async fetch(input: string | URL | Request, init?: RequestInit) {
                let retries = 0

                while (true) {
                  let active = getActiveAccount(config)
                  if (!active) return fetch(input, init)

                  active = await ensureActiveAccountAccess(active)

                  const requestHeaders = mergeHeaders(input, init)
                  setOAuthHeaders(requestHeaders, active.access)

                  let body = init?.body
                  if (body && typeof body === 'string') {
                    body = rewriteRequestBody(body)
                  }

                  const rewritten = rewriteUrl(input)

                  const response = await fetch(rewritten.input, {
                    ...init,
                    body,
                    headers: requestHeaders,
                    ...(isInsecure() && { tls: { rejectUnauthorized: false } }),
                  })

                  const rateInfo = parseRateLimitHeaders(response)
                  if (rateInfo) {
                    rotation.updateRateState(active.id, rateInfo)
                  }

                  const decision = rotation.decide(
                    active.id,
                    response.status,
                    retries,
                  )

                  if (decision.action !== 'switch') {
                    return createStrippedStream(response)
                  }

                  const newActive = await switchToAccount(
                    decision.targetAccountId,
                  )
                  if (!decision.retry || !newActive) {
                    return createStrippedStream(response)
                  }

                  retries += 1
                  await response.body?.cancel()
                }
              },
            }
          }

          // Shared inflight refresh promise — prevents concurrent token refreshes
          // from racing against each other (and causing 401 cascades with token rotation)
          let refreshPromise: Promise<string> | null = null

          return {
            apiKey: '',
            async fetch(input: string | URL | Request, init?: RequestInit) {
              const auth = await getAuth()
              if (auth.type !== 'oauth') return fetch(input, init)
              if (!auth.access || !auth.expires || auth.expires < Date.now()) {
                if (!refreshPromise) {
                  refreshPromise = (async () => {
                    const maxRetries = 2
                    const baseDelayMs = 500

                    for (let attempt = 0; attempt <= maxRetries; attempt++) {
                      try {
                        if (attempt > 0) {
                          const delay = baseDelayMs * 2 ** (attempt - 1)
                          await new Promise((resolve) =>
                            setTimeout(resolve, delay),
                          )
                        }

                        // Re-read auth to get the latest refresh token.
                        // The outer `auth` snapshot may be stale if tokens
                        // were rotated since the fetch() call was made.
                        const freshAuth = await getAuth()

                        const response = await fetch(TOKEN_URL, {
                          method: 'POST',
                          headers: {
                            'Content-Type': 'application/json',
                            Accept: 'application/json, text/plain, */*',
                            'User-Agent': 'axios/1.13.6',
                          },
                          body: JSON.stringify({
                            grant_type: 'refresh_token',
                            refresh_token: freshAuth.refresh,
                            client_id: CLIENT_ID,
                          }),
                        })

                        if (!response.ok) {
                          if (response.status >= 500 && attempt < maxRetries) {
                            await response.body?.cancel()
                            continue
                          }

                          await response.body?.cancel()
                          throw new Error(
                            `Token refresh failed: ${response.status}`,
                          )
                        }

                        const json = (await response.json()) as {
                          refresh_token: string
                          access_token: string
                          expires_in: number
                        }

                        // biome-ignore lint/suspicious/noExplicitAny: SDK types don't expose auth.set
                        await (client as any).auth.set({
                          path: {
                            id: 'anthropic',
                          },
                          body: {
                            type: 'oauth',
                            refresh: json.refresh_token,
                            access: json.access_token,
                            expires: Date.now() + json.expires_in * 1000,
                          },
                        })

                        return json.access_token
                      } catch (error) {
                        const isNetworkError =
                          error instanceof Error &&
                          (error.message.includes('fetch failed') ||
                            ('code' in error &&
                              (error.code === 'ECONNRESET' ||
                                error.code === 'ECONNREFUSED' ||
                                error.code === 'ETIMEDOUT' ||
                                error.code === 'UND_ERR_CONNECT_TIMEOUT')))

                        if (attempt < maxRetries && isNetworkError) {
                          continue
                        }

                        throw error
                      }
                    }
                    // Unreachable — each iteration either returns or throws.
                    // Kept as a TypeScript exhaustiveness guard.
                    throw new Error('Token refresh exhausted all retries')
                  })().finally(() => {
                    refreshPromise = null
                  })
                }
                auth.access = await refreshPromise
              }

              const requestHeaders = mergeHeaders(input, init)
              // biome-ignore lint/style/noNonNullAssertion: access is guaranteed set above
              setOAuthHeaders(requestHeaders, auth.access!)

              let body = init?.body
              if (body && typeof body === 'string') {
                body = rewriteRequestBody(body)
              }

              const rewritten = rewriteUrl(input)

              const response = await fetch(rewritten.input, {
                ...init,
                body,
                headers: requestHeaders,
                ...(isInsecure() && { tls: { rejectUnauthorized: false } }),
              })

              return createStrippedStream(response)
            },
          }
        }

        return {}
      },
      methods: [
        {
          label: 'Claude Pro/Max',
          type: 'oauth',
          authorize: async () => {
            const result = await authorize('max')
            return {
              url: result.url,
              instructions: 'Paste the authorization code here:',
              method: 'code',
              callback: async (code: string) => {
                return exchange(
                  code,
                  result.verifier,
                  result.redirectUri,
                  result.state,
                )
              },
            }
          },
        },
        {
          label: 'Create an API Key',
          type: 'oauth',
          authorize: async () => {
            const result = await authorize('console')
            return {
              url: result.url,
              instructions: 'Paste the authorization code here:',
              method: 'code',
              callback: async (code: string) => {
                const credentials = await exchange(
                  code,
                  result.verifier,
                  result.redirectUri,
                  result.state,
                )
                if (credentials.type === 'failed') return credentials
                const apiKey = await fetch(
                  `https://api.anthropic.com/api/oauth/claude_cli/create_api_key`,
                  {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      authorization: `Bearer ${credentials.access}`,
                    },
                  },
                ).then((r) => r.json() as Promise<{ raw_key: string }>)
                return { type: 'success' as const, key: apiKey.raw_key }
              },
            }
          },
        },
        {
          provider: 'anthropic',
          label: 'Manually enter API Key',
          type: 'api',
        },
        {
          label: 'Add Account to Pool',
          type: 'oauth',
          authorize: async () => {
            const loadedConfig = await loadConfig()
            if (loadedConfig.status === 'invalid') {
              throw new Error(
                `Invalid anthropic multi-account config: ${loadedConfig.error}`,
              )
            }

            let config =
              loadedConfig.status === 'ok' ? loadedConfig.config : null
            if (!config && capturedGetAuth) {
              const currentAuth = await capturedGetAuth()
              if (
                currentAuth.type === 'oauth' &&
                currentAuth.refresh &&
                currentAuth.access &&
                currentAuth.expires
              ) {
                config = createInitialConfig({
                  refresh: currentAuth.refresh,
                  access: currentAuth.access,
                  expires: currentAuth.expires,
                })
                await saveConfig(config)
              }
            }

            const result = await authorize('max')
            return {
              url: result.url,
              instructions: 'Paste the authorization code here:',
              method: 'code',
              callback: async (code: string) => {
                const creds = await exchange(
                  code,
                  result.verifier,
                  result.redirectUri,
                  result.state,
                )
                if (creds.type === 'failed') return creds

                const final = config
                  ? (() => {
                      const { config: updated, accountId } = addAccount(
                        config,
                        {
                          refresh: creds.refresh,
                          access: creds.access,
                          expires: creds.expires,
                        },
                      )
                      return switchActiveAccount(updated, accountId)
                    })()
                  : createInitialConfig({
                      refresh: creds.refresh,
                      access: creds.access,
                      expires: creds.expires,
                    })
                await saveConfig(final)

                return creds
              },
            }
          },
        },
        {
          label: 'Remove Account from Pool',
          type: 'oauth',
          authorize: async () => {
            const loadedConfig = await loadConfig()
            if (loadedConfig.status === 'invalid') {
              throw new Error(
                `Invalid anthropic multi-account config: ${loadedConfig.error}`,
              )
            }

            const config =
              loadedConfig.status === 'ok' ? loadedConfig.config : null
            if (!config || config.accounts.length <= 1) {
              return {
                url: '',
                instructions:
                  'No accounts to remove (need at least 2 accounts in pool).',
                method: 'code' as const,
                callback: async () => ({ type: 'failed' as const }),
              }
            }

            const accountList = config.accounts
              .map(
                (account, index) =>
                  `${index + 1}. ${account.label || account.id}${account.id === config.activeAccountId ? ' (active)' : ''}`,
              )
              .join('\n')

            return {
              url: '',
              instructions: `Enter the number of the account to remove:\n${accountList}`,
              method: 'code' as const,
              callback: async (input: string) => {
                const index = Number.parseInt(input.trim(), 10) - 1
                const account = config.accounts[index]
                if (!account) return { type: 'failed' as const }

                const updated = removeAccount(config, account.id)
                if (!updated) return { type: 'failed' as const }

                await saveConfig(updated)

                const active = getActiveAccount(updated)
                if (active) {
                  return {
                    type: 'success' as const,
                    refresh: active.refresh,
                    access: active.access,
                    expires: active.expires,
                  }
                }

                return { type: 'failed' as const }
              },
            }
          },
        },
      ],
    },
    // biome-ignore lint/suspicious/noExplicitAny: Plugin type doesn't include undocumented auth/hooks
  } as any
}
