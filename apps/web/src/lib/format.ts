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
