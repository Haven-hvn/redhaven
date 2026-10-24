/** Display helpers. Pure; tested in `tests/format.spec.ts`. */

export function shortAddress(addr: string): string {
  const a = addr.toLowerCase()
  if (!/^0x[0-9a-f]{40}$/.test(a)) return a
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

/** reddit-style relative time: "3 hours ago", "just now". */
export function timeAgo(unix: number, now: number = Math.floor(Date.now() / 1000)): string {
  const s = Math.max(0, now - unix)
  if (s < 45) return 'just now'
  const units: Array<[number, string]> = [[60, 'second'], [60, 'minute'], [24, 'hour'], [30, 'day'], [12, 'month']]
  let n = s
  let label = 'second'
  for (const [div, name] of units) {
    label = name
    if (n < div) break
    n = Math.floor(n / div)
    label = { second: 'minute', minute: 'hour', hour: 'day', day: 'month', month: 'year' }[name] ?? name
  }
  return `${n} ${label}${n === 1 ? '' : 's'} ago`
}

export function pluralize(n: number, one: string, many: string = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/** "in 3 days" / "in 2 hours" for expiry. */
export function inFuture(seconds: number): string {
  if (seconds <= 0) return 'now'
  if (seconds < 3600) return `in ${Math.max(1, Math.round(seconds / 60))} min`
  if (seconds < 86400) return `in ${Math.round(seconds / 3600)} h`
  return `in ${Math.round(seconds / 86400)} d`
}

export function formatScore(score: number): string {
  return score === 0 ? '0' : score > 0 ? `${score}` : `${score}`
}

export function compactNumber(n: number): string {
  if (Math.abs(n) >= 10_000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

/**
 * Token amounts for display: the gate stores raw wei, the contract knows its
 * decimals, and no reader should ever see `1000000000000000000`. Falls back to
 * the raw integer when decimals are unknown (non-ERC-20 gates).
 *
 * With known decimals the amount is always expressed in token units, exactly:
 * the full fraction with trailing zeros trimmed, never rounded or truncated.
 */
export function fmtTokenAmount(raw: bigint, decimals: number | undefined): string {
  if (decimals === undefined || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) return raw.toString()
  const s = raw.toString()
  if (decimals === 0) return s
  const neg = s.startsWith('-')
  const digits = neg ? s.slice(1) : s
  const padded = digits.padStart(decimals + 1, '0')
  const whole = padded.slice(0, -decimals)
  const frac = padded.slice(-decimals).replace(/0+$/, '')
  return `${neg ? '-' : ''}${whole || '0'}${frac ? `.${frac}` : ''}`
}
