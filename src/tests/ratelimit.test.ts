import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { parseRateLimitHeaders } from '../ratelimit'

function createResponse(headers: Record<string, string>): Response {
  return new Response(null, { headers })
}

beforeEach(() => {
  mock.restore()
})

afterEach(() => {
  mock.restore()
})

describe('parseRateLimitHeaders', () => {
  test('returns complete RateLimitInfo when all headers are present', () => {
    const response = createResponse({
      'anthropic-ratelimit-unified-status': 'allowed_warning',
      'anthropic-ratelimit-unified-5h-utilization': '0.81',
      'anthropic-ratelimit-unified-7d-utilization': '0.64',
      'anthropic-ratelimit-unified-representative-claim': 'org:test',
    })

    expect(parseRateLimitHeaders(response)).toEqual({
      status: 'allowed_warning',
      fiveHourUtilization: 0.81,
      sevenDayUtilization: 0.64,
      representativeClaim: 'org:test',
    })
  })

  test('returns null when the status header is missing', () => {
    const response = createResponse({
      'anthropic-ratelimit-unified-5h-utilization': '0.81',
    })

    expect(parseRateLimitHeaders(response)).toBeNull()
  })

  test('handles missing utilization headers as NaN', () => {
    const response = createResponse({
      'anthropic-ratelimit-unified-status': 'allowed',
    })

    const result = parseRateLimitHeaders(response)
    expect(result?.status).toBe('allowed')
    expect(Number.isNaN(result?.fiveHourUtilization)).toBe(true)
    expect(Number.isNaN(result?.sevenDayUtilization)).toBe(true)
  })

  test('handles malformed utilization values as NaN', () => {
    const response = createResponse({
      'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-5h-utilization': 'oops',
      'anthropic-ratelimit-unified-7d-utilization': 'still-bad',
    })

    const result = parseRateLimitHeaders(response)
    expect(Number.isNaN(result?.fiveHourUtilization)).toBe(true)
    expect(Number.isNaN(result?.sevenDayUtilization)).toBe(true)
  })

  test('parses rejected status correctly', () => {
    const response = createResponse({
      'anthropic-ratelimit-unified-status': 'rejected',
    })

    expect(parseRateLimitHeaders(response)?.status).toBe('rejected')
  })

  test('parses allowed_warning status correctly', () => {
    const response = createResponse({
      'anthropic-ratelimit-unified-status': 'allowed_warning',
    })

    expect(parseRateLimitHeaders(response)?.status).toBe('allowed_warning')
  })

  test('parses allowed status correctly', () => {
    const response = createResponse({
      'anthropic-ratelimit-unified-status': 'allowed',
    })

    expect(parseRateLimitHeaders(response)?.status).toBe('allowed')
  })
})
