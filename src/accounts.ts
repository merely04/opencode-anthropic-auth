import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { CLIENT_ID, TOKEN_URL } from './constants.ts'
import type { AccountCredentials, AccountsConfig } from './types.ts'

type RefreshedTokens = {
  refresh: string
  access: string
  expires: number
}

type TokenResponse = {
  refresh_token: string
  access_token: string
  expires_in: number
}

export type LoadConfigResult =
  | { status: 'ok'; config: AccountsConfig }
  | { status: 'not_found' }
  | { status: 'invalid'; error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isAccountCredentials(value: unknown): value is AccountCredentials {
  if (!isRecord(value)) return false

  return (
    typeof value.id === 'string' &&
    (typeof value.label === 'undefined' || typeof value.label === 'string') &&
    typeof value.refresh === 'string' &&
    typeof value.access === 'string' &&
    isFiniteNumber(value.expires) &&
    typeof value.addedAt === 'string'
  )
}

function isAccountsConfig(value: unknown): value is AccountsConfig {
  if (!isRecord(value)) return false
  if (value.version !== 1 || typeof value.activeAccountId !== 'string') {
    return false
  }

  if (!Array.isArray(value.accounts) || value.accounts.length === 0) {
    return false
  }

  if (!value.accounts.every(isAccountCredentials)) {
    return false
  }

  if (!value.accounts.some((account) => account.id === value.activeAccountId)) {
    return false
  }

  if (typeof value.primaryAccountId !== 'undefined') {
    if (typeof value.primaryAccountId !== 'string') return false
    if (
      !value.accounts.some((account) => account.id === value.primaryAccountId)
    ) {
      return false
    }
  }

  if (typeof value.proactiveSwitch !== 'undefined') {
    if (typeof value.proactiveSwitch !== 'boolean') return false
  }

  if (typeof value.maxRetries !== 'undefined') {
    if (!isFiniteNumber(value.maxRetries)) return false
  }

  if (typeof value.maxConsecutiveFailures !== 'undefined') {
    if (!isFiniteNumber(value.maxConsecutiveFailures)) return false
  }

  if (typeof value.circuitBreakerResetMs !== 'undefined') {
    if (!isFiniteNumber(value.circuitBreakerResetMs)) return false
  }

  if (typeof value.primaryRecoveryIntervalMs !== 'undefined') {
    if (!isFiniteNumber(value.primaryRecoveryIntervalMs)) return false
  }

  if (typeof value.thresholds !== 'undefined') {
    if (!isRecord(value.thresholds)) return false
    if (
      typeof value.thresholds.fiveHour !== 'undefined' &&
      !isFiniteNumber(value.thresholds.fiveHour)
    ) {
      return false
    }
    if (
      typeof value.thresholds.sevenDay !== 'undefined' &&
      !isFiniteNumber(value.thresholds.sevenDay)
    ) {
      return false
    }
  }

  return true
}

function createAccountCredentials(credentials: {
  label?: string
  refresh: string
  access: string
  expires: number
}): AccountCredentials {
  return {
    id: crypto.randomUUID(),
    label: credentials.label,
    refresh: credentials.refresh,
    access: credentials.access,
    expires: credentials.expires,
    addedAt: new Date().toISOString(),
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

export function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.message.includes('fetch failed')) return true
  if (!('code' in error)) return false

  return (
    error.code === 'ECONNRESET' ||
    error.code === 'ECONNREFUSED' ||
    error.code === 'ETIMEDOUT' ||
    error.code === 'UND_ERR_CONNECT_TIMEOUT'
  )
}

/** Simple async mutex for serializing state transitions. */
export function createMutex(): {
  acquire(): Promise<() => void>
} {
  let current = Promise.resolve()

  return {
    async acquire() {
      let release: (() => void) | undefined
      const next = new Promise<void>((resolve) => {
        release = resolve
      })
      const previous = current
      current = next
      await previous
      if (!release) {
        throw new Error('Mutex release was not initialized')
      }
      return release
    },
  }
}

export function isAuthError(error: unknown): boolean {
  if (!(error instanceof Error)) return true
  if (error.message.includes('ENOSPC')) return false
  if (error.message.includes('EPERM')) return false
  if (error.message.includes('EROFS')) return false
  if (error.message.includes('Token refresh failed')) return true
  if (isNetworkError(error)) return true
  return true
}

async function refreshAccountTokens(opts: {
  account: AccountCredentials
  clientId: string
  tokenUrl: string
  onTokensRefreshed: (
    accountId: string,
    tokens: RefreshedTokens,
  ) => Promise<void>
}): Promise<string> {
  const maxRetries = 2

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        await delay(500 * 2 ** (attempt - 1))
      }

      const response = await fetch(opts.tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/plain, */*',
          'User-Agent': 'axios/1.13.6',
        },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: opts.account.refresh,
          client_id: opts.clientId,
        }),
      })

      if (!response.ok) {
        if (response.status >= 500 && attempt < maxRetries) {
          await response.body?.cancel()
          continue
        }

        await response.body?.cancel()
        throw new Error(`Token refresh failed: ${response.status}`)
      }

      const json = (await response.json()) as TokenResponse
      const tokens = {
        refresh: json.refresh_token,
        access: json.access_token,
        expires: Date.now() + json.expires_in * 1000,
      }

      await opts.onTokensRefreshed(opts.account.id, tokens)
      return tokens.access
    } catch (error) {
      if (attempt < maxRetries && isNetworkError(error)) {
        continue
      }

      throw error
    }
  }

  throw new Error('Token refresh exhausted all retries')
}

/** Resolve the multi-account config file path. */
export function configPath(): string {
  const configHome =
    process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config')
  return join(configHome, 'opencode', 'anthropic-accounts.json')
}

/** Load multi-account config from disk. */
export async function loadConfig(): Promise<LoadConfigResult> {
  try {
    const raw = await readFile(configPath(), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!isAccountsConfig(parsed)) {
      return { status: 'invalid', error: 'Config file is malformed' }
    }
    return { status: 'ok', config: parsed }
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return { status: 'not_found' }
    }

    return {
      status: 'invalid',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Save multi-account config using a write-then-rename flow. */
export async function saveConfig(config: AccountsConfig): Promise<void> {
  const path = configPath()
  const directory = dirname(path)
  const tempPath = `${path}.tmp.${crypto.randomUUID()}`

  await mkdir(directory, { recursive: true })

  try {
    await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    await rename(tempPath, path)
  } catch (error) {
    await unlink(tempPath).catch(() => undefined)
    throw error
  }
}

/** Add an account to an existing config. */
export function addAccount(
  config: AccountsConfig,
  credentials: {
    label?: string
    refresh: string
    access: string
    expires: number
  },
): { config: AccountsConfig; accountId: string } {
  const account = createAccountCredentials(credentials)

  return {
    config: {
      ...config,
      activeAccountId:
        config.accounts.length === 0 ? account.id : config.activeAccountId,
      primaryAccountId: config.primaryAccountId,
      accounts: [...config.accounts, account],
    },
    accountId: account.id,
  }
}

/** Remove an account from the config. */
export function removeAccount(
  config: AccountsConfig,
  accountId: string,
): AccountsConfig | null {
  const accounts = config.accounts.filter((account) => account.id !== accountId)
  if (accounts.length === config.accounts.length) return config
  if (accounts.length === 0) return null
  const nextActiveAccountId = accounts[0]?.id
  if (!nextActiveAccountId) return null
  const nextPrimaryAccountId =
    config.primaryAccountId === accountId
      ? accounts[0]?.id
      : config.primaryAccountId

  return {
    ...config,
    activeAccountId:
      config.activeAccountId === accountId
        ? nextActiveAccountId
        : config.activeAccountId,
    primaryAccountId: nextPrimaryAccountId,
    accounts,
  }
}

/** Return the currently active account credentials. */
export function getActiveAccount(
  config: AccountsConfig,
): AccountCredentials | null {
  return (
    config.accounts.find((account) => account.id === config.activeAccountId) ||
    null
  )
}

/** Switch the active account if the target exists. */
export function switchActiveAccount(
  config: AccountsConfig,
  accountId: string,
): AccountsConfig {
  if (!config.accounts.some((account) => account.id === accountId)) {
    return config
  }

  return {
    ...config,
    activeAccountId: accountId,
  }
}

/** Create a multi-account config from existing single-account auth. */
export function createInitialConfig(auth: {
  refresh: string
  access: string
  expires: number
}): AccountsConfig {
  const account = createAccountCredentials(auth)

  return {
    version: 1,
    activeAccountId: account.id,
    primaryAccountId: account.id,
    accounts: [account],
  }
}

/**
 * Refresh multiple accounts with concurrency limit.
 * Returns array of results (success or error per account).
 */
export async function refreshWithThrottle(
  accounts: AccountCredentials[],
  refreshFn: (account: AccountCredentials) => Promise<string>,
  concurrency: number,
): Promise<Array<{ accountId: string; success: boolean; error?: Error }>> {
  const results: Array<{ accountId: string; success: boolean; error?: Error }> =
    []
  const batchSize = Math.max(1, Math.floor(concurrency))

  for (let index = 0; index < accounts.length; index += batchSize) {
    const batch = accounts.slice(index, index + batchSize)
    const settled = await Promise.allSettled(
      batch.map((account) => refreshFn(account)),
    )

    settled.forEach((result, batchIndex) => {
      const account = batch[batchIndex]
      if (!account) return

      if (result.status === 'fulfilled') {
        results.push({ accountId: account.id, success: true })
        return
      }

      results.push({
        accountId: account.id,
        success: false,
        error:
          result.reason instanceof Error
            ? result.reason
            : new Error(String(result.reason)),
      })
    })
  }

  return results
}

/** Create a per-account token refresher with inflight deduplication. */
export function createAccountRefresher(opts: {
  clientId?: string
  tokenUrl?: string
  onTokensRefreshed: (
    accountId: string,
    tokens: RefreshedTokens,
  ) => Promise<void>
}): {
  refresh(account: AccountCredentials): Promise<string>
} {
  const inflight = new Map<string, Promise<string>>()
  const clientId = opts.clientId ?? CLIENT_ID
  const tokenUrl = opts.tokenUrl ?? TOKEN_URL

  return {
    refresh(account: AccountCredentials): Promise<string> {
      const existing = inflight.get(account.id)
      if (existing) return existing

      const refreshPromise = refreshAccountTokens({
        account,
        clientId,
        tokenUrl,
        onTokensRefreshed: opts.onTokensRefreshed,
      }).finally(() => {
        inflight.delete(account.id)
      })

      inflight.set(account.id, refreshPromise)
      return refreshPromise
    },
  }
}
