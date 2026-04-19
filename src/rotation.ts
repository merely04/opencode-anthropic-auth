import type {
  AccountRateState,
  AccountsConfig,
  CircuitBreakerState,
  RateLimitInfo,
  RotationDecision,
} from './types.ts'
import {
  DEFAULT_CIRCUIT_BREAKER_RESET_MS,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_MAX_CONSECUTIVE_FAILURES,
  DEFAULT_MAX_RETRIES,
  DEFAULT_PRIMARY_RECOVERY_INTERVAL_MS,
  DEFAULT_THRESHOLDS,
} from './types.ts'

function utilizationOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0
}

function maxUtilization(info: RateLimitInfo | null | undefined): number {
  if (!info) return 0
  return Math.max(
    utilizationOrZero(info.fiveHourUtilization),
    utilizationOrZero(info.sevenDayUtilization),
  )
}

function exceedsThreshold(
  config: AccountsConfig,
  info: RateLimitInfo,
): boolean {
  const thresholds = {
    ...DEFAULT_THRESHOLDS,
    ...config.thresholds,
  }

  return (
    (Number.isFinite(info.fiveHourUtilization) &&
      info.fiveHourUtilization >= thresholds.fiveHour) ||
    (Number.isFinite(info.sevenDayUtilization) &&
      info.sevenDayUtilization >= thresholds.sevenDay)
  )
}

function findBestAlternateAccount(
  config: AccountsConfig,
  rateStates: Map<string, AccountRateState>,
  currentAccountId: string,
  isDisabled: (accountId: string) => boolean,
): string | null {
  let bestAccountId: string | null = null
  let bestScore = Number.POSITIVE_INFINITY

  for (const account of config.accounts) {
    if (account.id === currentAccountId) continue
    if (isDisabled(account.id)) continue

    const state = rateStates.get(account.id)
    if (state?.lastInfo?.status === 'rejected') continue

    const score = maxUtilization(state?.lastInfo)
    if (score < bestScore) {
      bestScore = score
      bestAccountId = account.id
    }
  }

  return bestAccountId
}

function createCircuitBreakerState(accountId: string): CircuitBreakerState {
  return {
    accountId,
    consecutiveFailures: 0,
    disabled: false,
    disabledAt: null,
  }
}

function resetCircuitBreakerState(state: CircuitBreakerState): void {
  state.consecutiveFailures = 0
  state.disabled = false
  state.disabledAt = null
}

/** Create an in-memory rotation manager for multi-account OAuth switching. */
export function createRotationManager(opts: {
  config: AccountsConfig
  cooldownMs?: number
  maxConsecutiveFailures?: number
  circuitBreakerResetMs?: number
}): {
  updateRateState(accountId: string, info: RateLimitInfo): void
  recordFailure(accountId: string): void
  recordSuccess(accountId: string): void
  isDisabled(accountId: string): boolean
  decide(currentAccountId: string, responseStatus: number): RotationDecision
  getRateState(accountId: string): AccountRateState | undefined
} {
  const rateStates = new Map<string, AccountRateState>()
  const circuitBreakerStates = new Map<string, CircuitBreakerState>()
  const cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS
  const maxRetries = opts.config.maxRetries ?? DEFAULT_MAX_RETRIES
  const maxConsecutiveFailures =
    opts.maxConsecutiveFailures ??
    opts.config.maxConsecutiveFailures ??
    DEFAULT_MAX_CONSECUTIVE_FAILURES
  const circuitBreakerResetMs =
    opts.circuitBreakerResetMs ??
    opts.config.circuitBreakerResetMs ??
    DEFAULT_CIRCUIT_BREAKER_RESET_MS
  let lastSwitchTime = 0
  let lastRecoveryCheckTime = 0
  let retryCount = 0

  function getCircuitBreakerState(accountId: string): CircuitBreakerState {
    const existing = circuitBreakerStates.get(accountId)
    if (existing) return existing

    const state = createCircuitBreakerState(accountId)
    circuitBreakerStates.set(accountId, state)
    return state
  }

  function isDisabled(accountId: string): boolean {
    const state = circuitBreakerStates.get(accountId)
    if (!state?.disabled) {
      return false
    }

    if (
      state.disabledAt != null &&
      Date.now() - state.disabledAt >= circuitBreakerResetMs
    ) {
      resetCircuitBreakerState(state)
      return false
    }

    return true
  }

  return {
    updateRateState(accountId: string, info: RateLimitInfo): void {
      rateStates.set(accountId, {
        accountId,
        lastInfo: info,
        lastUpdated: Date.now(),
      })
    },

    recordFailure(accountId: string): void {
      const state = getCircuitBreakerState(accountId)
      state.consecutiveFailures += 1

      if (
        state.consecutiveFailures >= maxConsecutiveFailures &&
        !state.disabled
      ) {
        state.disabled = true
        state.disabledAt = Date.now()
      }
    },

    recordSuccess(accountId: string): void {
      resetCircuitBreakerState(getCircuitBreakerState(accountId))
    },

    isDisabled,

    decide(currentAccountId: string, responseStatus: number): RotationDecision {
      if (responseStatus !== 429) {
        retryCount = 0
      }

      if (opts.config.accounts.length <= 1) {
        return { action: 'stay' }
      }

      if (responseStatus === 429) {
        if (retryCount >= maxRetries) {
          return { action: 'stay' }
        }

        const targetAccountId = findBestAlternateAccount(
          opts.config,
          rateStates,
          currentAccountId,
          isDisabled,
        )
        if (!targetAccountId) {
          return { action: 'stay' }
        }

        retryCount += 1
        lastSwitchTime = Date.now()
        return { action: 'switch', targetAccountId, retry: true }
      }

      if (opts.config.proactiveSwitch !== false) {
        if (Date.now() - lastSwitchTime >= cooldownMs) {
          const currentInfo = rateStates.get(currentAccountId)?.lastInfo
          if (
            currentInfo?.status === 'allowed_warning' &&
            exceedsThreshold(opts.config, currentInfo)
          ) {
            const targetAccountId = findBestAlternateAccount(
              opts.config,
              rateStates,
              currentAccountId,
              isDisabled,
            )
            if (targetAccountId) {
              lastSwitchTime = Date.now()
              return { action: 'switch', targetAccountId, retry: false }
            }
          }
        }
      }

      const primaryAccount = opts.config.accounts[0]
      if (!primaryAccount) {
        return { action: 'stay' }
      }

      const recoveryInterval =
        opts.config.primaryRecoveryIntervalMs ??
        DEFAULT_PRIMARY_RECOVERY_INTERVAL_MS
      if (recoveryInterval <= 0) {
        return { action: 'stay' }
      }

      if (currentAccountId === primaryAccount.id) {
        return { action: 'stay' }
      }

      if (Date.now() - lastSwitchTime < cooldownMs) {
        return { action: 'stay' }
      }

      if (Date.now() - lastRecoveryCheckTime < recoveryInterval) {
        return { action: 'stay' }
      }

      if (isDisabled(primaryAccount.id)) {
        return { action: 'stay' }
      }

      const primaryInfo = rateStates.get(primaryAccount.id)?.lastInfo
      lastRecoveryCheckTime = Date.now()

      if (primaryInfo?.status === 'rejected') {
        return { action: 'stay' }
      }

      if (primaryInfo && primaryInfo.status !== 'allowed') {
        return { action: 'stay' }
      }

      if (primaryInfo && exceedsThreshold(opts.config, primaryInfo)) {
        return { action: 'stay' }
      }

      lastSwitchTime = lastRecoveryCheckTime
      return {
        action: 'switch',
        targetAccountId: primaryAccount.id,
        retry: false,
      }
    },

    getRateState(accountId: string): AccountRateState | undefined {
      return rateStates.get(accountId)
    },
  }
}
