/** Route builders. Static export + trailingSlash: every route is a directory with query params. */

export function subredditPath(s: string, sort?: string, page?: number): string {
  const q = new URLSearchParams({ s })
  if (sort && sort !== 'hot') q.set('sort', sort)
  if (page && page > 1) q.set('p', String(page))
  return `/r/?${q.toString()}`
}

export function commentsPath(s: string, id: string, comment?: string, sort?: string): string {
  const q = new URLSearchParams({ s, id })
  if (sort && sort !== 'best') q.set('sort', sort)
  return `/comments/?${q.toString()}${comment ? `#c${comment.slice(2, 10)}` : ''}`
}

export function submitPath(s?: string): string {
  return s ? `/submit/?s=${encodeURIComponent(s)}` : '/submit/'
}

export function userPath(address: string): string {
  return `/u/?a=${address.toLowerCase()}`
}

export function frontpagePath(sort?: string, page?: number): string {
  const q = new URLSearchParams()
  if (sort && sort !== 'hot') q.set('sort', sort)
  if (page && page > 1) q.set('p', String(page))
  const qs = q.toString()
  return qs ? `/?${qs}` : '/'
}

export function anchorId(key: string): string {
  return `c${key.slice(2, 10)}`
}
