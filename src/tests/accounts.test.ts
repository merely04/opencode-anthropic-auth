import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  addAccount,
  configPath,
  createAccountRefresher,
  createInitialConfig,
  getActiveAccount,
  loadConfig,
  refreshWithThrottle,
  removeAccount,
  saveConfig,
  switchActiveAccount,
} from '../accounts'
import type { AccountsConfig } from '../types'

function createConfig(): AccountsConfig {
  return {
    version: 1,
    activeAccountId: 'account-1',
    thresholds: {
      fiveHour: 0.8,
      sevenDay: 0.8,
    },
    proactiveSwitch: true,
    maxRetries: 1,
    accounts: [
      {
        id: 'account-1',
        label: 'Primary',
        refresh: 'refresh-1',
        access: 'access-1',
        expires: 1_700_000_000_000,
        addedAt: '2024-01-01T00:00:00.000Z',
      },
      {
        id: 'account-2',
        label: 'Secondary',
        refresh: 'refresh-2',
        access: 'access-2',
        expires: 1_700_000_100_000,
        addedAt: '2024-01-02T00:00:00.000Z',
      },
    ],
  }
}

function createAccounts(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `account-${index + 1}`,
    label: `Account ${index + 1}`,
    refresh: `refresh-${index + 1}`,
    access: `access-${index + 1}`,
    expires: 1_700_000_000_000 + index,
    addedAt: `2024-01-0${index + 1}T00:00:00.000Z`,
  }))
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

describe('accounts config helpers', () => {
  const originalConfigHome = process.env.XDG_CONFIG_HOME
  const originalFetch = globalThis.fetch
  const originalSetTimeout = globalThis.setTimeout
  let tempConfigHome = ''

  beforeEach(async () => {
    mock.restore()
    tempConfigHome = await mkdtemp(join(tmpdir(), 'opencode-anthropic-auth-'))
    process.env.XDG_CONFIG_HOME = tempConfigHome
    globalThis.fetch = originalFetch
    globalThis.setTimeout = originalSetTimeout
  })

  afterEach(async () => {
    mock.restore()
    globalThis.fetch = originalFetch
    globalThis.setTimeout = originalSetTimeout

    if (originalConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME
    } else {
      process.env.XDG_CONFIG_HOME = originalConfigHome
    }

    if (tempConfigHome) {
      await rm(tempConfigHome, { recursive: true, force: true })
    }
  })

  test('loadConfig returns null for a missing file', async () => {
    expect(await loadConfig()).toBeNull()
  })

  test('loadConfig parses a valid config', async () => {
    const config = createConfig()
    const path = configPath()

    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(config)}\n`, 'utf8')

    expect(await loadConfig()).toEqual(config)
  })

  test('loadConfig returns null for malformed JSON', async () => {
    const path = configPath()

    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, '{not-json', 'utf8')

    expect(await loadConfig()).toBeNull()
  })

  test('loadConfig returns null for a non-numeric primaryRecoveryIntervalMs', async () => {
    const path = configPath()
    const config = {
      ...createConfig(),
      primaryRecoveryIntervalMs: 'every-so-often',
    }

    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(config)}\n`, 'utf8')

    expect(await loadConfig()).toBeNull()
  })

  test('saveConfig writes valid JSON', async () => {
    const config = createConfig()

    await saveConfig(config)

    const raw = await readFile(configPath(), 'utf8')
    expect(JSON.parse(raw)).toEqual(config)
  })

  test('addAccount appends an account with a generated UUID', () => {
    const result = addAccount(createConfig(), {
      label: 'Tertiary',
      refresh: 'refresh-3',
      access: 'access-3',
      expires: 1_700_000_200_000,
    })

    const addedAccount =
      result.config.accounts[result.config.accounts.length - 1]
    expect(result.config.accounts).toHaveLength(3)
    expect(result.accountId).toMatch(uuidPattern)
    expect(addedAccount?.id).toBe(result.accountId)
    expect(addedAccount?.label).toBe('Tertiary')
    expect(addedAccount?.refresh).toBe('refresh-3')
    expect(addedAccount?.access).toBe('access-3')
    expect(addedAccount?.expires).toBe(1_700_000_200_000)
    expect(addedAccount?.addedAt).toBeString()
  })

  test('addAccount preserves existing accounts', () => {
    const config = createConfig()
    const result = addAccount(config, {
      refresh: 'refresh-3',
      access: 'access-3',
      expires: 1_700_000_200_000,
    })

    expect(result.config.accounts[0]).toEqual(config.accounts[0])
    expect(result.config.accounts[1]).toEqual(config.accounts[1])
  })

  test('removeAccount removes an account by ID', () => {
    const result = removeAccount(createConfig(), 'account-2')

    expect(result?.accounts).toHaveLength(1)
    expect(result?.accounts[0]?.id).toBe('account-1')
  })

  test('removeAccount switches the active account when removing the active one', () => {
    const result = removeAccount(createConfig(), 'account-1')

    expect(result?.activeAccountId).toBe('account-2')
    expect(result?.accounts[0]?.id).toBe('account-2')
  })

  test('removeAccount returns null when removing the last account', () => {
    const config = createInitialConfig({
      refresh: 'refresh-1',
      access: 'access-1',
      expires: 1_700_000_000_000,
    })

    expect(removeAccount(config, config.activeAccountId)).toBeNull()
  })

  test('getActiveAccount returns the correct account', () => {
    const activeAccount = getActiveAccount(createConfig())

    expect(activeAccount?.id).toBe('account-1')
    expect(activeAccount?.label).toBe('Primary')
  })

  test('getActiveAccount returns null for an unknown activeAccountId', () => {
    const config = {
      ...createConfig(),
      activeAccountId: 'missing-account',
    }

    expect(getActiveAccount(config)).toBeNull()
  })

  test('switchActiveAccount updates activeAccountId', () => {
    const result = switchActiveAccount(createConfig(), 'account-2')

    expect(result.activeAccountId).toBe('account-2')
  })

  test('createInitialConfig creates a valid config from single auth', () => {
    const config = createInitialConfig({
      refresh: 'refresh-initial',
      access: 'access-initial',
      expires: 1_700_000_000_000,
    })
    const account = config.accounts[0]

    if (!account) {
      throw new Error('Expected initial config to include one account')
    }

    expect(config.version).toBe(1)
    expect(config.accounts).toHaveLength(1)
    expect(config.activeAccountId).toBe(account.id)
    expect(account.refresh).toBe('refresh-initial')
    expect(account.access).toBe('access-initial')
    expect(account.expires).toBe(1_700_000_000_000)
    expect(account.id).toMatch(uuidPattern)
  })

  test('createAccountRefresher deduplicates concurrent refreshes for the same account', async () => {
    const account = createConfig().accounts[0]
    let fetchCalls = 0
    let resolveResponse: ((response: Response) => void) | undefined

    const pendingResponse = new Promise<Response>((resolve) => {
      resolveResponse = resolve
    })

    const fetchMock = mock(() => {
      fetchCalls += 1
      return pendingResponse
    })

    globalThis.fetch = fetchMock as unknown as typeof fetch

    const refresher = createAccountRefresher({
      clientId: 'client-id',
      tokenUrl: 'https://example.com/oauth/token',
      onTokensRefreshed: async () => {},
    })

    const firstRefresh = refresher.refresh(account!)
    const secondRefresh = refresher.refresh(account!)

    expect(fetchCalls).toBe(1)

    resolveResponse?.(
      new Response(
        JSON.stringify({
          refresh_token: 'fresh-refresh',
          access_token: 'fresh-access',
          expires_in: 3600,
        }),
        { status: 200 },
      ),
    )

    const [firstToken, secondToken] = await Promise.all([
      firstRefresh,
      secondRefresh,
    ])

    expect(firstToken).toBe('fresh-access')
    expect(secondToken).toBe('fresh-access')
    expect(fetchCalls).toBe(1)
  })

  test('createAccountRefresher calls onTokensRefreshed', async () => {
    const account = createConfig().accounts[0]
    let refreshed:
      | {
          accountId: string
          tokens: { refresh: string; access: string; expires: number }
        }
      | undefined

    const fetchMock = mock(() => {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            refresh_token: 'fresh-refresh',
            access_token: 'fresh-access',
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      )
    })

    globalThis.fetch = fetchMock as unknown as typeof fetch

    const refresher = createAccountRefresher({
      clientId: 'client-id',
      tokenUrl: 'https://example.com/oauth/token',
      onTokensRefreshed: mock(
        async (
          accountId: string,
          tokens: { refresh: string; access: string; expires: number },
        ) => {
          refreshed = { accountId, tokens }
        },
      ),
    })

    const token = await refresher.refresh(account!)

    expect(token).toBe('fresh-access')
    expect(refreshed?.accountId).toBe('account-1')
    expect(refreshed?.tokens.refresh).toBe('fresh-refresh')
    expect(refreshed?.tokens.access).toBe('fresh-access')
    expect(refreshed?.tokens.expires).toBeGreaterThan(Date.now())
  })

  test('refreshWithThrottle respects the concurrency limit', async () => {
    const accounts = createAccounts(5)
    let activeCount = 0
    let maxActiveCount = 0
    const resolvers = new Map<string, () => void>()

    const waitFor = async (predicate: () => boolean) => {
      for (let attempt = 0; attempt < 20; attempt++) {
        if (predicate()) {
          return
        }

        await new Promise((resolve) => setTimeout(resolve, 0))
      }

      throw new Error('Expected refresh batch to start')
    }

    const refreshPromise = refreshWithThrottle(
      accounts,
      async (account) => {
        activeCount += 1
        maxActiveCount = Math.max(maxActiveCount, activeCount)

        await new Promise<void>((resolve) => {
          resolvers.set(account.id, resolve)
        })

        activeCount -= 1
        return `access-${account.id}`
      },
      2,
    )

    await waitFor(
      () =>
        activeCount === 2 &&
        resolvers.has('account-1') &&
        resolvers.has('account-2'),
    )
    expect(activeCount).toBe(2)

    resolvers.get('account-1')?.()
    resolvers.get('account-2')?.()
    resolvers.delete('account-1')
    resolvers.delete('account-2')

    await waitFor(
      () =>
        activeCount === 2 &&
        resolvers.has('account-3') &&
        resolvers.has('account-4'),
    )

    expect(activeCount).toBe(2)

    resolvers.get('account-3')?.()
    resolvers.get('account-4')?.()
    resolvers.delete('account-3')
    resolvers.delete('account-4')

    await waitFor(() => activeCount === 1 && resolvers.has('account-5'))

    expect(activeCount).toBe(1)

    resolvers.get('account-5')?.()
    resolvers.delete('account-5')
    await refreshPromise

    expect(maxActiveCount).toBe(2)
  })

  test('refreshWithThrottle returns success for each refreshed account', async () => {
    const accounts = createAccounts(3)

    const results = await refreshWithThrottle(
      accounts,
      async (account) => `token-${account.id}`,
      3,
    )

    expect(results).toEqual([
      { accountId: 'account-1', success: true },
      { accountId: 'account-2', success: true },
      { accountId: 'account-3', success: true },
    ])
  })

  test('refreshWithThrottle handles mixed success and failure results', async () => {
    const accounts = createAccounts(4)

    const results = await refreshWithThrottle(
      accounts,
      async (account) => {
        if (account.id === 'account-2') {
          throw new Error('refresh failed')
        }

        if (account.id === 'account-4') {
          throw 'non-error failure'
        }

        return `token-${account.id}`
      },
      2,
    )

    expect(results[0]).toEqual({ accountId: 'account-1', success: true })
    expect(results[1]?.accountId).toBe('account-2')
    expect(results[1]?.success).toBe(false)
    expect(results[1]?.error?.message).toBe('refresh failed')
    expect(results[2]).toEqual({ accountId: 'account-3', success: true })
    expect(results[3]?.accountId).toBe('account-4')
    expect(results[3]?.success).toBe(false)
    expect(results[3]?.error?.message).toBe('non-error failure')
  })
})
