import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { createRotationManager } from '../rotation'
import {
  type AccountsConfig,
  DEFAULT_PRIMARY_RECOVERY_INTERVAL_MS,
  type RateLimitInfo,
} from '../types'

function createConfig(
  accountIds: string[] = ['account-1', 'account-2', 'account-3'],
  overrides: Partial<AccountsConfig> = {},
): AccountsConfig {
  return {
    version: 1,
    activeAccountId: accountIds[0] ?? '',
    primaryAccountId: accountIds[0],
    thresholds: {
      fiveHour: 0.8,
      sevenDay: 0.8,
    },
    proactiveSwitch: true,
    maxRetries: 1,
    accounts: accountIds.map((id, index) => ({
      id,
      label: `Account ${index + 1}`,
      refresh: `refresh-${id}`,
      access: `access-${id}`,
      expires: 1_700_000_000_000 + index,
      addedAt: `2024-01-0${index + 1}T00:00:00.000Z`,
    })),
    ...overrides,
  }
}

function createRateInfo(
  status: RateLimitInfo['status'],
  fiveHourUtilization: number = Number.NaN,
  sevenDayUtilization: number = Number.NaN,
): RateLimitInfo {
  return {
    status,
    fiveHourUtilization,
    sevenDayUtilization,
    representativeClaim: null,
  }
}

describe('createRotationManager', () => {
  const originalDateNow = Date.now
  let now = 1_700_000_000_000

  beforeEach(() => {
    mock.restore()
    now = 1_700_000_000_000
    Date.now = mock(() => now) as typeof Date.now
  })

  afterEach(() => {
    mock.restore()
    Date.now = originalDateNow
  })

  test('returns stay for a single account', () => {
    const manager = createRotationManager({
      config: createConfig(['account-1']),
    })

    expect(manager.decide('account-1', 429, 0)).toEqual({ action: 'stay' })
  })

  test('returns stay when utilization is below thresholds', () => {
    const manager = createRotationManager({
      config: createConfig(['account-1', 'account-2']),
    })

    manager.updateRateState(
      'account-1',
      createRateInfo('allowed_warning', 0.5, 0.6),
    )
    manager.updateRateState('account-2', createRateInfo('allowed', 0.2, 0.1))

    expect(manager.decide('account-1', 200, 0)).toEqual({ action: 'stay' })
  })

  test('returns switch with retry on 429', () => {
    const manager = createRotationManager({
      config: createConfig(['account-1', 'account-2']),
    })

    manager.updateRateState('account-2', createRateInfo('allowed', 0.1, 0.1))

    expect(manager.decide('account-1', 429, 0)).toEqual({
      action: 'switch',
      targetAccountId: 'account-2',
      retry: true,
    })
  })

  test('uses per-request retry state instead of shared global retry budget', () => {
    const manager = createRotationManager({
      config: createConfig(['account-1', 'account-2']),
    })

    manager.updateRateState('account-2', createRateInfo('allowed', 0.1, 0.1))

    expect(manager.decide('account-1', 429, 0)).toEqual({
      action: 'switch',
      targetAccountId: 'account-2',
      retry: true,
    })
    expect(manager.decide('account-1', 429, 0)).toEqual({
      action: 'switch',
      targetAccountId: 'account-2',
      retry: true,
    })
    expect(manager.decide('account-1', 429, 1)).toEqual({ action: 'stay' })
  })

  test('returns switch without retry on allowed_warning above threshold', () => {
    const manager = createRotationManager({
      config: createConfig(['account-1', 'account-2']),
    })

    manager.updateRateState(
      'account-1',
      createRateInfo('allowed_warning', 0.9, 0.4),
    )
    manager.updateRateState('account-2', createRateInfo('allowed', 0.1, 0.1))

    expect(manager.decide('account-1', 200, 0)).toEqual({
      action: 'switch',
      targetAccountId: 'account-2',
      retry: false,
    })
  })

  test('recordFailure increments toward the disable threshold', () => {
    const manager = createRotationManager({
      config: createConfig(['account-1', 'account-2']),
      maxConsecutiveFailures: 3,
    })

    manager.recordFailure('account-2')
    expect(manager.isDisabled('account-2')).toBe(false)

    manager.recordFailure('account-2')
    expect(manager.isDisabled('account-2')).toBe(false)

    manager.recordFailure('account-2')
    expect(manager.isDisabled('account-2')).toBe(true)
  })

  test('disables an account after the configured number of failures', () => {
    const manager = createRotationManager({
      config: createConfig(['account-1', 'account-2']),
      maxConsecutiveFailures: 2,
    })

    manager.recordFailure('account-2')
    expect(manager.isDisabled('account-2')).toBe(false)

    manager.recordFailure('account-2')
    expect(manager.isDisabled('account-2')).toBe(true)
  })

  test('recordSuccess resets failures and re-enables the account', () => {
    const manager = createRotationManager({
      config: createConfig(['account-1', 'account-2']),
      maxConsecutiveFailures: 2,
    })

    manager.recordFailure('account-2')
    manager.recordFailure('account-2')
    expect(manager.isDisabled('account-2')).toBe(true)

    manager.recordSuccess('account-2')
    expect(manager.isDisabled('account-2')).toBe(false)

    manager.recordFailure('account-2')
    expect(manager.isDisabled('account-2')).toBe(false)
  })

  test('isDisabled auto-resets after the timeout', () => {
    const manager = createRotationManager({
      config: createConfig(['account-1', 'account-2']),
      maxConsecutiveFailures: 2,
      circuitBreakerResetMs: 1_000,
    })

    manager.recordFailure('account-2')
    manager.recordFailure('account-2')
    expect(manager.isDisabled('account-2')).toBe(true)

    now += 1_000
    expect(manager.isDisabled('account-2')).toBe(false)

    manager.recordFailure('account-2')
    expect(manager.isDisabled('account-2')).toBe(false)
  })

  test('respects cooldown for proactive switches', () => {
    const manager = createRotationManager({
      config: createConfig(['account-1', 'account-2']),
    })

    manager.updateRateState(
      'account-1',
      createRateInfo('allowed_warning', 0.95, 0.4),
    )
    manager.updateRateState('account-2', createRateInfo('allowed', 0.1, 0.1))

    expect(manager.decide('account-1', 200, 0)).toEqual({
      action: 'switch',
      targetAccountId: 'account-2',
      retry: false,
    })

    now += 1_000

    expect(manager.decide('account-1', 200, 0)).toEqual({ action: 'stay' })
  })

  test('429 ignores cooldown', () => {
    const manager = createRotationManager({
      config: createConfig(['account-1', 'account-2']),
    })

    manager.updateRateState(
      'account-1',
      createRateInfo('allowed_warning', 0.95, 0.4),
    )
    manager.updateRateState('account-2', createRateInfo('allowed', 0.1, 0.1))

    expect(manager.decide('account-1', 200, 0)).toEqual({
      action: 'switch',
      targetAccountId: 'account-2',
      retry: false,
    })

    now += 1_000

    expect(manager.decide('account-1', 429, 0)).toEqual({
      action: 'switch',
      targetAccountId: 'account-2',
      retry: true,
    })
  })

  test('selects the least-utilized alternate account', () => {
    const manager = createRotationManager({
      config: createConfig(['account-1', 'account-2', 'account-3']),
    })

    manager.updateRateState(
      'account-1',
      createRateInfo('allowed_warning', 0.95, 0.95),
    )
    manager.updateRateState('account-2', createRateInfo('allowed', 0.7, 0.7))
    manager.updateRateState('account-3', createRateInfo('allowed', 0.2, 0.2))

    expect(manager.decide('account-1', 200, 0)).toEqual({
      action: 'switch',
      targetAccountId: 'account-3',
      retry: false,
    })
  })

  test('prefers unknown-state accounts', () => {
    const manager = createRotationManager({
      config: createConfig(['account-1', 'account-2', 'account-3']),
    })

    manager.updateRateState(
      'account-1',
      createRateInfo('allowed_warning', 0.95, 0.95),
    )
    manager.updateRateState('account-2', createRateInfo('allowed', 0.2, 0.2))

    expect(manager.decide('account-1', 200, 0)).toEqual({
      action: 'switch',
      targetAccountId: 'account-3',
      retry: false,
    })
  })

  test('returns stay when all alternates are rejected', () => {
    const manager = createRotationManager({
      config: createConfig(['account-1', 'account-2', 'account-3']),
    })

    manager.updateRateState('account-2', createRateInfo('rejected', 0.2, 0.2))
    manager.updateRateState('account-3', createRateInfo('rejected', 0.1, 0.1))

    expect(manager.decide('account-1', 429, 0)).toEqual({ action: 'stay' })
  })

  test('decide skips disabled accounts', () => {
    const manager = createRotationManager({
      config: createConfig(['account-1', 'account-2', 'account-3']),
      maxConsecutiveFailures: 1,
    })

    manager.updateRateState(
      'account-1',
      createRateInfo('allowed_warning', 0.95, 0.95),
    )
    manager.updateRateState('account-2', createRateInfo('allowed', 0.1, 0.1))
    manager.updateRateState('account-3', createRateInfo('allowed', 0.4, 0.4))
    manager.recordFailure('account-2')

    expect(manager.decide('account-1', 200, 0)).toEqual({
      action: 'switch',
      targetAccountId: 'account-3',
      retry: false,
    })
  })

  test('decide reuses an auto-reset account when it becomes available again', () => {
    const manager = createRotationManager({
      config: createConfig(['account-1', 'account-2']),
      maxConsecutiveFailures: 1,
      circuitBreakerResetMs: 1_000,
    })

    manager.updateRateState('account-2', createRateInfo('allowed', 0.1, 0.1))
    manager.recordFailure('account-2')
    expect(manager.isDisabled('account-2')).toBe(true)

    now += 1_000

    expect(manager.decide('account-1', 429, 0)).toEqual({
      action: 'switch',
      targetAccountId: 'account-2',
      retry: true,
    })
  })

  test('respects proactiveSwitch=false config', () => {
    const manager = createRotationManager({
      config: createConfig(['account-1', 'account-2'], {
        proactiveSwitch: false,
      }),
    })

    manager.updateRateState(
      'account-1',
      createRateInfo('allowed_warning', 0.95, 0.95),
    )
    manager.updateRateState('account-2', createRateInfo('allowed', 0.1, 0.1))

    expect(manager.decide('account-1', 200, 0)).toEqual({ action: 'stay' })
  })

  test('returns stay when proactiveSwitch=false even with high utilization, but still switches on 429', () => {
    const manager = createRotationManager({
      config: createConfig(['account-1', 'account-2'], {
        proactiveSwitch: false,
      }),
    })

    manager.updateRateState(
      'account-1',
      createRateInfo('allowed_warning', 0.95, 0.95),
    )
    manager.updateRateState('account-2', createRateInfo('allowed', 0.1, 0.1))

    expect(manager.decide('account-1', 200, 0)).toEqual({ action: 'stay' })
    expect(manager.decide('account-1', 429, 0)).toEqual({
      action: 'switch',
      targetAccountId: 'account-2',
      retry: true,
    })
  })

  test('switches back to the primary account when it has recovered', () => {
    const manager = createRotationManager({
      config: createConfig(['account-1', 'account-2'], {
        proactiveSwitch: false,
      }),
    })

    manager.updateRateState('account-1', createRateInfo('allowed', 0.2, 0.2))

    expect(manager.decide('account-2', 200, 0)).toEqual({
      action: 'switch',
      targetAccountId: 'account-1',
      retry: false,
    })
  })

  test('uses explicit primaryAccountId instead of accounts[0]', () => {
    const manager = createRotationManager({
      config: createConfig(['account-1', 'account-2', 'account-3'], {
        activeAccountId: 'account-1',
        primaryAccountId: 'account-3',
        proactiveSwitch: false,
      }),
      cooldownMs: 0,
    })

    manager.updateRateState('account-3', createRateInfo('allowed', 0.1, 0.1))

    expect(manager.decide('account-1', 200, 0)).toEqual({
      action: 'switch',
      targetAccountId: 'account-3',
      retry: false,
    })
  })

  test('does not switch back to primary when already on the primary account', () => {
    const manager = createRotationManager({
      config: createConfig(['account-1', 'account-2'], {
        proactiveSwitch: false,
      }),
    })

    manager.updateRateState('account-1', createRateInfo('allowed', 0.2, 0.2))

    expect(manager.decide('account-1', 200, 0)).toEqual({ action: 'stay' })
  })

  test('respects the configured primary recovery interval', () => {
    const manager = createRotationManager({
      config: createConfig(['account-1', 'account-2'], {
        proactiveSwitch: false,
        primaryRecoveryIntervalMs: 5_000,
      }),
      cooldownMs: 0,
    })

    manager.updateRateState('account-1', createRateInfo('allowed', 0.2, 0.2))

    expect(manager.decide('account-2', 200, 0)).toEqual({
      action: 'switch',
      targetAccountId: 'account-1',
      retry: false,
    })

    now += 4_000
    expect(manager.decide('account-2', 200, 0)).toEqual({ action: 'stay' })

    now += 1_000
    expect(manager.decide('account-2', 200, 0)).toEqual({
      action: 'switch',
      targetAccountId: 'account-1',
      retry: false,
    })
  })

  test('waits until the next interval after a failed primary recovery check', () => {
    const manager = createRotationManager({
      config: createConfig(['account-1', 'account-2'], {
        proactiveSwitch: false,
        primaryRecoveryIntervalMs: 5_000,
      }),
      cooldownMs: 0,
    })

    manager.updateRateState('account-1', createRateInfo('rejected', 0.2, 0.2))
    expect(manager.decide('account-2', 200, 0)).toEqual({ action: 'stay' })

    manager.updateRateState('account-1', createRateInfo('allowed', 0.2, 0.2))

    now += 4_000
    expect(manager.decide('account-2', 200, 0)).toEqual({ action: 'stay' })

    now += 1_000
    expect(manager.decide('account-2', 200, 0)).toEqual({
      action: 'switch',
      targetAccountId: 'account-1',
      retry: false,
    })
  })

  test('does not switch back to a disabled primary account', () => {
    const manager = createRotationManager({
      config: createConfig(['account-1', 'account-2'], {
        proactiveSwitch: false,
      }),
      maxConsecutiveFailures: 1,
    })

    manager.updateRateState('account-1', createRateInfo('allowed', 0.2, 0.2))
    manager.recordFailure('account-1')

    expect(manager.decide('account-2', 200, 0)).toEqual({ action: 'stay' })
  })

  test('does not switch back to a rejected primary account', () => {
    const manager = createRotationManager({
      config: createConfig(['account-1', 'account-2'], {
        proactiveSwitch: false,
      }),
    })

    manager.updateRateState('account-1', createRateInfo('rejected', 0.2, 0.2))

    expect(manager.decide('account-2', 200, 0)).toEqual({ action: 'stay' })
  })

  test('does not switch back when the primary account still exceeds thresholds', () => {
    const manager = createRotationManager({
      config: createConfig(['account-1', 'account-2'], {
        proactiveSwitch: false,
      }),
    })

    manager.updateRateState('account-1', createRateInfo('allowed', 0.9, 0.2))

    expect(manager.decide('account-2', 200, 0)).toEqual({ action: 'stay' })
  })

  test('disables primary recovery when primaryRecoveryIntervalMs is zero', () => {
    const manager = createRotationManager({
      config: createConfig(['account-1', 'account-2'], {
        proactiveSwitch: false,
        primaryRecoveryIntervalMs: 0,
      }),
    })

    manager.updateRateState('account-1', createRateInfo('allowed', 0.2, 0.2))

    expect(manager.decide('account-2', 200, 0)).toEqual({ action: 'stay' })
  })

  test('uses the default primary recovery interval when not configured', () => {
    const manager = createRotationManager({
      config: createConfig(['account-1', 'account-2'], {
        proactiveSwitch: false,
      }),
      cooldownMs: 0,
    })

    manager.updateRateState('account-1', createRateInfo('allowed', 0.2, 0.2))

    expect(manager.decide('account-2', 200, 0)).toEqual({
      action: 'switch',
      targetAccountId: 'account-1',
      retry: false,
    })

    now += DEFAULT_PRIMARY_RECOVERY_INTERVAL_MS - 1
    expect(manager.decide('account-2', 200, 0)).toEqual({ action: 'stay' })

    now += 1
    expect(manager.decide('account-2', 200, 0)).toEqual({
      action: 'switch',
      targetAccountId: 'account-1',
      retry: false,
    })
  })
})
