import type { RateLimitInfo } from './types.ts'

const STATUS_HEADER = 'anthropic-ratelimit-unified-status'
const FIVE_HOUR_HEADER = 'anthropic-ratelimit-unified-5h-utilization'
const SEVEN_DAY_HEADER = 'anthropic-ratelimit-unified-7d-utilization'
const CLAIM_HEADER = 'anthropic-ratelimit-unified-representative-claim'

function parseUtilization(value: string | null): number {
  if (value == null) return Number.NaN
  return Number.parseFloat(value)
}

function isRateLimitStatus(value: string): value is RateLimitInfo['status'] {
  return (
    value === 'allowed' || value === 'allowed_warning' || value === 'rejected'
  )
}

/** Parse Anthropic unified rate-limit headers from a response. */
export function parseRateLimitHeaders(
  response: Response,
): RateLimitInfo | null {
  const status = response.headers.get(STATUS_HEADER)
  if (!status || !isRateLimitStatus(status)) {
    return null
  }

  return {
    status,
    fiveHourUtilization: parseUtilization(
      response.headers.get(FIVE_HOUR_HEADER),
    ),
    sevenDayUtilization: parseUtilization(
      response.headers.get(SEVEN_DAY_HEADER),
    ),
    representativeClaim: response.headers.get(CLAIM_HEADER),
  }
}
