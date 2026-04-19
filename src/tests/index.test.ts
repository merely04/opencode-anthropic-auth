import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { configPath } from '../accounts'
import { AnthropicAuthPlugin } from '../index'

/** Extract the URL string from a fetch input (string, URL, or Request). */
function extractUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

// Minimal mock of the OpenCode plugin client
function createMockClient() {
  return {
    auth: {
      set: mock(() => Promise.resolve()),
    },
  }
}

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages'
const EMPTY_POST = { method: 'POST', body: '{}' } as const

/**
 * Set up the common test scaffolding for concurrent refresh tests:
 * mocks setTimeout to be synchronous and creates a plugin loader
 * with an already-expired OAuth token.
 */
async function setupExpiredTokenLoader() {
  // @ts-expect-error — mock override for testing
  globalThis.setTimeout = mock((handler: () => unknown) => {
    handler()
    return 0
  })

  const mockClient = createMockClient()
  const plugin = await getPlugin(mockClient)
  const result = await plugin.auth.loader(
    () =>
      Promise.resolve({
        type: 'oauth',
        access: 'expired-token',
        refresh: 'old-refresh',
        expires: Date.now() - 1000,
      }),
    { models: {} },
  )

  return { mockClient, result }
}

/** Fire 5 concurrent fetch requests against /v1/messages. */
function fireConcurrentFetches(result: { fetch: typeof fetch }) {
  return Promise.all(
    Array.from({ length: 5 }, () => result.fetch(MESSAGES_URL, EMPTY_POST)),
  )
}

async function getPlugin(client?: ReturnType<typeof createMockClient>) {
  return (await AnthropicAuthPlugin({
    // @ts-expect-error: minimal mock for testing
    client: client ?? createMockClient(),
  })) as Promise<any>
}

async function writeMultiAccountConfig(
  overrides: Record<string, unknown> = {},
) {
  const config = {
    version: 1,
    activeAccountId: 'account-1',
    primaryAccountId: 'account-1',
    proactiveSwitch: false,
    maxRetries: 1,
    accounts: [
      {
        id: 'account-1',
        refresh: 'refresh-1',
        access: 'access-1',
        expires: Date.now() + 100_000,
        addedAt: '2024-01-01T00:00:00.000Z',
      },
      {
        id: 'account-2',
        refresh: 'refresh-2',
        access: 'access-2',
        expires: Date.now() + 100_000,
        addedAt: '2024-01-02T00:00:00.000Z',
      },
      {
        id: 'account-3',
        refresh: 'refresh-3',
        access: 'access-3',
        expires: Date.now() + 100_000,
        addedAt: '2024-01-03T00:00:00.000Z',
      },
    ],
    ...overrides,
  }

  const path = configPath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(config)}\n`, 'utf8')
}

describe('AnthropicAuthPlugin', () => {
  test('returns an object with auth properties', async () => {
    const plugin = await getPlugin()
    expect(plugin.auth).toBeDefined()
    expect(plugin.auth.provider).toBe('anthropic')
    expect(plugin.auth.loader).toBeFunction()
    expect(plugin.auth.methods).toBeArray()
  })
})

describe('auth.methods', () => {
  test('has five auth methods', async () => {
    const plugin = await getPlugin()
    expect(plugin.auth.methods).toHaveLength(5)
  })

  test('first method is Claude Pro/Max OAuth with code flow', async () => {
    const plugin = await getPlugin()
    const method = plugin.auth.methods[0]
    expect(method.label).toBe('Claude Pro/Max')
    expect(method.type).toBe('oauth')
    expect(method.authorize).toBeFunction()
  })

  test('second method is Create an API Key OAuth with code flow', async () => {
    const plugin = await getPlugin()
    const method = plugin.auth.methods[1]
    expect(method.label).toBe('Create an API Key')
    expect(method.type).toBe('oauth')
    expect(method.authorize).toBeFunction()
  })

  test('third method is manual API key', async () => {
    const plugin = await getPlugin()
    const method = plugin.auth.methods[2]
    expect(method.label).toBe('Manually enter API Key')
    expect(method.type).toBe('api')
    expect(method.provider).toBe('anthropic')
  })

  test('fourth method adds an account to the pool', async () => {
    const plugin = await getPlugin()
    const method = plugin.auth.methods[3]
    expect(method.label).toBe('Add Account to Pool')
    expect(method.type).toBe('oauth')
    expect(method.authorize).toBeFunction()
  })

  test('fifth method removes an account from the pool', async () => {
    const plugin = await getPlugin()
    const method = plugin.auth.methods[4]
    expect(method.label).toBe('Remove Account from Pool')
    expect(method.type).toBe('oauth')
    expect(method.authorize).toBeFunction()
  })
})

describe('auth.loader', () => {
  const originalFetch = globalThis.fetch
  const originalSetTimeout = globalThis.setTimeout
  const originalSetInterval = globalThis.setInterval
  const originalClearTimeout = globalThis.clearTimeout
  const originalClearInterval = globalThis.clearInterval
  const originalConfigHome = process.env.XDG_CONFIG_HOME
  let tempConfigHome = ''

  beforeEach(async () => {
    tempConfigHome = await mkdtemp(join(tmpdir(), 'opencode-anthropic-auth-'))
    process.env.XDG_CONFIG_HOME = tempConfigHome
    globalThis.fetch = originalFetch
    globalThis.setTimeout = originalSetTimeout
    globalThis.setInterval = originalSetInterval
    globalThis.clearTimeout = originalClearTimeout
    globalThis.clearInterval = originalClearInterval
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    globalThis.setTimeout = originalSetTimeout
    globalThis.setInterval = originalSetInterval
    globalThis.clearTimeout = originalClearTimeout
    globalThis.clearInterval = originalClearInterval

    if (originalConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME
    } else {
      process.env.XDG_CONFIG_HOME = originalConfigHome
    }

    if (tempConfigHome) {
      await rm(tempConfigHome, { recursive: true, force: true })
    }
  })

  test('returns empty object for non-oauth auth', async () => {
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () => Promise.resolve({ type: 'api' }),
      { models: {} },
    )
    expect(result).toEqual({})
  })

  test('zeros out model costs for oauth auth', async () => {
    const plugin = await getPlugin()
    const models = {
      'claude-3': {
        cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
      },
    }
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'token',
          refresh: 'refresh',
          expires: Date.now() + 100000,
        }),
      { models },
    )
    expect(models['claude-3'].cost).toEqual({
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    })
  })

  test('returns fetch wrapper for oauth auth', async () => {
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'token',
          refresh: 'refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    expect(result.apiKey).toBe('')
    expect(result.fetch).toBeFunction()
  })

  test('fetch wrapper sets OAuth headers and prefixes tools', async () => {
    let capturedHeaders: Headers | undefined
    let capturedBody: string | undefined

    globalThis.fetch = mock((input: any, init: any) => {
      capturedHeaders = init?.headers
      capturedBody = init?.body
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'my-access-token',
          refresh: 'refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    const body = JSON.stringify({
      tools: [{ name: 'bash', type: 'function' }],
      messages: [{ role: 'user', content: 'hello world test message' }],
      system: 'You are a helpful assistant.',
    })

    await result.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body,
    })

    expect(capturedHeaders).toBeDefined()
    expect(capturedHeaders!.get('authorization')).toBe('Bearer my-access-token')
    expect(capturedHeaders!.get('x-api-key')).toBeNull()
    expect(capturedHeaders!.get('anthropic-beta')).toContain('oauth-2025-04-20')

    const parsedBody = JSON.parse(capturedBody!)
    // Tool name should be prefixed
    expect(parsedBody.tools[0].name).toBe('mcp_Bash')
    // Three-block layout: billing header, identity, rest
    expect(parsedBody.system).toHaveLength(3)
    expect(parsedBody.system[0].text).toContain('x-anthropic-billing-header')
    expect(parsedBody.system[1].text).toBe(
      "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
    )
    expect(parsedBody.system[2].text).toBe('You are a helpful assistant.')
    // User message is untouched
    expect(parsedBody.messages[0].content).toBe('hello world test message')
  })

  test('fetch wrapper refreshes expired token', async () => {
    const fetchCalls: Array<{ url: string; body?: string }> = []

    globalThis.fetch = mock((input: any, init: any) => {
      const url = extractUrl(input)
      fetchCalls.push({ url, body: init?.body })

      if (url.includes('/v1/oauth/token')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              refresh_token: 'new-refresh',
              access_token: 'new-access',
              expires_in: 3600,
            }),
            { status: 200 },
          ),
        )
      }

      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient)

    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'expired-token',
          refresh: 'old-refresh',
          expires: Date.now() - 1000, // expired
        }),
      { models: {} },
    )

    await result.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: '{}',
    })

    // Should have called token endpoint first
    const tokenCall = fetchCalls.find((c) => c.url.includes('/v1/oauth/token'))
    expect(tokenCall).toBeDefined()
    const tokenBody = JSON.parse(tokenCall!.body!)
    expect(tokenBody.grant_type).toBe('refresh_token')
    expect(tokenBody.refresh_token).toBe('old-refresh')

    // Should have called client.auth.set with new tokens
    expect(mockClient.auth.set).toHaveBeenCalled()
  })

  test('fetch wrapper retries transient token refresh failures', async () => {
    let tokenRefreshCalls = 0
    const setTimeoutMock = mock((handler: () => unknown) => {
      handler()
      return 0
    })

    // @ts-expect-error — mock override for testing
    globalThis.setTimeout = setTimeoutMock

    globalThis.fetch = mock((input: any) => {
      const url = extractUrl(input)

      if (url.includes('/v1/oauth/token')) {
        tokenRefreshCalls += 1

        if (tokenRefreshCalls === 1) {
          return Promise.resolve(
            new Response('Temporary failure', { status: 500 }),
          )
        }

        return Promise.resolve(
          new Response(
            JSON.stringify({
              refresh_token: 'new-refresh',
              access_token: 'new-access',
              expires_in: 3600,
            }),
            { status: 200 },
          ),
        )
      }

      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient)
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'expired',
          refresh: 'refresh',
          expires: Date.now() - 1000,
        }),
      { models: {} },
    )

    await result.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: '{}',
    })

    expect(tokenRefreshCalls).toBe(2)
    expect(setTimeoutMock).toHaveBeenCalledTimes(1)
    expect(setTimeoutMock).toHaveBeenCalledWith(expect.any(Function), 500)
    expect(mockClient.auth.set).toHaveBeenCalledTimes(1)
  })

  test('fetch wrapper does not retry non-transient token refresh failures', async () => {
    let tokenRefreshCalls = 0

    globalThis.fetch = mock((input: any) => {
      const url = extractUrl(input)
      if (url.includes('/v1/oauth/token')) {
        tokenRefreshCalls += 1
        return Promise.resolve(new Response('Forbidden', { status: 403 }))
      }
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'expired',
          refresh: 'refresh',
          expires: Date.now() - 1000,
        }),
      { models: {} },
    )

    expect(
      result.fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: '{}',
      }),
    ).rejects.toThrow('Token refresh failed: 403')

    expect(tokenRefreshCalls).toBe(1)
  })

  test('fetch wrapper strips tool prefix from streaming response', async () => {
    const encoder = new TextEncoder()
    const responseStream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"content_block":{"type":"tool_use","name":"mcp_bash"}}\n\n',
          ),
        )
        controller.close()
      },
    })

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(responseStream, { status: 200 })),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'token',
          refresh: 'refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    const response = await result.fetch(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        body: '{}',
      },
    )

    const text = await response.text()
    expect(text).toContain('"name": "bash"')
    expect(text).not.toContain('mcp_bash')
  })

  test('concurrent expired token refresh should deduplicate to a single token request', async () => {
    let tokenRefreshCount = 0

    globalThis.fetch = mock((input: any) => {
      const url = extractUrl(input)

      if (url.includes('/v1/oauth/token')) {
        tokenRefreshCount++
        return Promise.resolve(
          new Response(
            JSON.stringify({
              refresh_token: 'new-refresh',
              access_token: 'new-access',
              expires_in: 3600,
            }),
            { status: 200 },
          ),
        )
      }

      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const { result } = await setupExpiredTokenLoader()
    await fireConcurrentFetches(result)

    // With deduplication, only ONE refresh request should be made, not 5
    expect(tokenRefreshCount).toBe(1)
  })

  test('concurrent refresh with token rotation should not cause cascading failures', async () => {
    const usedRefreshTokens = new Set<string>()

    globalThis.fetch = mock((input: any, init: any) => {
      const url = extractUrl(input)

      if (url.includes('/v1/oauth/token')) {
        const body = JSON.parse(init?.body)
        const refreshToken = body.refresh_token

        // Simulate refresh token rotation: first use succeeds, subsequent uses
        // return 401 because the old token has been invalidated
        if (usedRefreshTokens.has(refreshToken)) {
          return Promise.resolve(
            new Response(JSON.stringify({ error: 'invalid_grant' }), {
              status: 401,
            }),
          )
        }

        usedRefreshTokens.add(refreshToken)
        return Promise.resolve(
          new Response(
            JSON.stringify({
              refresh_token: 'rotated-refresh',
              access_token: 'new-access',
              expires_in: 3600,
            }),
            { status: 200 },
          ),
        )
      }

      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const { result } = await setupExpiredTokenLoader()

    // Fire 5 concurrent requests — ALL should succeed because only one refresh
    // fires and the rest reuse its result
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () =>
        result.fetch(MESSAGES_URL, EMPTY_POST).then(
          () => 'ok' as const,
          () => 'fail' as const,
        ),
      ),
    )

    // With deduplication, all callers share the single successful refresh.
    // Without it, 4 out of 5 get 401 from the rotated-away token → cascading failures.
    expect(outcomes).toEqual(['ok', 'ok', 'ok', 'ok', 'ok'])
  })

  test('concurrent refresh should persist tokens exactly once', async () => {
    globalThis.fetch = mock((input: any) => {
      const url = extractUrl(input)

      if (url.includes('/v1/oauth/token')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              refresh_token: 'new-refresh',
              access_token: 'new-access',
              expires_in: 3600,
            }),
            { status: 200 },
          ),
        )
      }

      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const { mockClient, result } = await setupExpiredTokenLoader()
    await fireConcurrentFetches(result)

    // With deduplication, client.auth.set should be called exactly once.
    // Without it, each concurrent refresh calls auth.set independently → 5 calls.
    expect(mockClient.auth.set).toHaveBeenCalledTimes(1)
  })

  test('refresh always reads the latest refresh token, not a stale snapshot', async () => {
    const tokenRequestBodies: string[] = []

    globalThis.fetch = mock((input: any, init: any) => {
      const url = extractUrl(input)

      if (url.includes('/v1/oauth/token')) {
        tokenRequestBodies.push(init?.body)
        return Promise.resolve(
          new Response(
            JSON.stringify({
              refresh_token: 'rotated-refresh',
              access_token: 'fresh-access',
              expires_in: 3600,
            }),
            { status: 200 },
          ),
        )
      }

      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    let callCount = 0
    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient)

    const result = await plugin.auth.loader(
      () => {
        callCount++
        if (callCount === 1) {
          return Promise.resolve({
            type: 'oauth',
            access: 'expired-access',
            refresh: 'stale-refresh',
            expires: Date.now() - 1000,
          })
        }
        return Promise.resolve({
          type: 'oauth',
          access: 'expired-access',
          refresh: 'rotated-refresh-from-storage',
          expires: Date.now() - 1000,
        })
      },
      { models: {} },
    )

    await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(tokenRequestBodies).toHaveLength(1)
    const sentBody = JSON.parse(tokenRequestBodies[0] ?? '{}')
    expect(sentBody.refresh_token).toBe('rotated-refresh-from-storage')
    expect(sentBody.refresh_token).not.toBe('stale-refresh')
  })

  test('multi-account retries use per-request state instead of shared retry budget', async () => {
    await writeMultiAccountConfig()

    let messageCallCount = 0
    globalThis.fetch = mock((input: any) => {
      const url = extractUrl(input)

      if (url.includes('/v1/messages')) {
        messageCallCount += 1
        return Promise.resolve(
          new Response(null, {
            status: messageCallCount % 2 === 1 ? 429 : 200,
          }),
        )
      }

      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin(createMockClient())
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'unused-access',
          refresh: 'unused-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    const first = await result.fetch(MESSAGES_URL, EMPTY_POST)
    const second = await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(messageCallCount).toBe(4)
  })

  test('loader clears existing background timers before creating new ones', async () => {
    await writeMultiAccountConfig()

    const timeoutIds = [101, 202]
    const intervalIds = [303, 404]
    const setTimeoutMock = mock(() => timeoutIds.shift() ?? 0)
    const setIntervalMock = mock(() => intervalIds.shift() ?? 0)
    const clearTimeoutMock = mock(() => undefined)
    const clearIntervalMock = mock(() => undefined)

    globalThis.setTimeout = setTimeoutMock as unknown as typeof setTimeout
    globalThis.setInterval = setIntervalMock as unknown as typeof setInterval
    globalThis.clearTimeout = clearTimeoutMock as unknown as typeof clearTimeout
    globalThis.clearInterval =
      clearIntervalMock as unknown as typeof clearInterval

    const plugin = await getPlugin(createMockClient())
    const getAuth = () =>
      Promise.resolve({
        type: 'oauth',
        access: 'token',
        refresh: 'refresh',
        expires: Date.now() + 100000,
      })

    await plugin.auth.loader(getAuth, { models: {} })
    await plugin.auth.loader(getAuth, { models: {} })

    expect(clearTimeoutMock).toHaveBeenCalledWith(101)
    expect(clearIntervalMock).toHaveBeenCalledWith(303)
    expect(setTimeoutMock).toHaveBeenCalledTimes(2)
    expect(setIntervalMock).toHaveBeenCalledTimes(2)
  })

  test('loader throws when the multi-account config is invalid', async () => {
    const path = configPath()
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, '{not-json', 'utf8')

    const plugin = await getPlugin()

    await expect(
      plugin.auth.loader(
        () =>
          Promise.resolve({
            type: 'oauth',
            access: 'token',
            refresh: 'refresh',
            expires: Date.now() + 100000,
          }),
        { models: {} },
      ),
    ).rejects.toThrow('Invalid anthropic multi-account config')
  })

  test('fetch wrapper adds beta=true to /v1/messages URL', async () => {
    let capturedUrl: string | undefined

    globalThis.fetch = mock((input: any) => {
      capturedUrl = extractUrl(input)
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'token',
          refresh: 'refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    await result.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: '{}',
    })

    expect(capturedUrl).toContain('beta=true')
  })
})
