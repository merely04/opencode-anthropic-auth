/** Persisted to ~/.config/opencode/anthropic-accounts.json */
export interface AccountsConfig {
  version: 1
  activeAccountId: string
  thresholds?: {
    fiveHour?: number
    sevenDay?: number
  }
  /** Whether to proactively switch on allowed_warning (default: true) */
  proactiveSwitch?: boolean
  /** Max retry count on 429 across different accounts (default: 1) */
  maxRetries?: number
  /** Max consecutive refresh failures before disabling account (default: 3) */
  maxConsecutiveFailures?: number
  /** How long to disable a failed account before retrying (ms, default: 30 min) */
  circuitBreakerResetMs?: number
  /** Interval in ms to check if primary account has recovered (default: 60 min). Set to 0 to disable. */
  primaryRecoveryIntervalMs?: number
  accounts: AccountCredentials[]
}

/** Stored credentials for a single Anthropic OAuth account. */
export interface AccountCredentials {
  id: string
  label?: string
  refresh: string
  access: string
  expires: number
  addedAt: string
}

/** Parsed from Anthropic unified rate-limit headers. */
export interface RateLimitInfo {
  status: 'allowed' | 'allowed_warning' | 'rejected'
  fiveHourUtilization: number
  sevenDayUtilization: number
  representativeClaim: string | null
}

/** In-memory rate-limit state tracked per account. */
export interface AccountRateState {
  accountId: string
  lastInfo: RateLimitInfo | null
  lastUpdated: number
}

/** Circuit breaker state tracked per account in memory. */
export interface CircuitBreakerState {
  accountId: string
  consecutiveFailures: number
  disabled: boolean
  disabledAt: number | null
}

/** Action returned by the rotation manager after evaluating a response. */
export type RotationDecision =
  | { action: 'stay' }
  | { action: 'switch'; targetAccountId: string; retry: boolean }

/** Default proactive switching thresholds. */
export const DEFAULT_THRESHOLDS = {
  fiveHour: 0.8,
  sevenDay: 0.8,
} as const

/** Default cooldown between proactive account switches. */
export const DEFAULT_COOLDOWN_MS = 30_000

/** Default retry count for 429-driven account rotation. */
export const DEFAULT_MAX_RETRIES = 1

/** Default consecutive failures before disabling an account. */
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3

/** How long a disabled account stays disabled before being retried (ms). */
export const DEFAULT_CIRCUIT_BREAKER_RESET_MS = 30 * 60 * 1000

/** How often to check whether the primary account can be resumed (ms). */
export const DEFAULT_PRIMARY_RECOVERY_INTERVAL_MS = 60 * 60 * 1000
