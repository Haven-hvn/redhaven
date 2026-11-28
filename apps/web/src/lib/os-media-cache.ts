'use client'

/**
 * Shared IndexedDB playback/media cache client over the Haven OS (`haven-os:v1`)
 * cross-site bridge. When running standalone (not embedded in Haven OS), every
 * method degrades cleanly to a no-op / cache miss.
 */

export interface OsCachedMedia {
  key: string
  bytes: ArrayBuffer
  mimeType: string
  size: number
  encrypted: boolean
}

async function getBridgeProvider(): Promise<{
  request: (args: { method: string; params?: unknown }) => Promise<unknown>
} | null> {
  if (typeof window === 'undefined' || window.self === window.top) return null
  try {
    const { getHavenOsBridge } = await import('haven-aol')
    const bridge = getHavenOsBridge()
    if (!bridge || !bridge.connectedToHost) return null
    return bridge.provider as unknown as {
      request: (args: { method: string; params?: unknown }) => Promise<unknown>
    }
  } catch {
    return null
  }
}

export function mediaCacheKeyFor(opts: { piece?: string; fcid?: string }): string | null {
  if (opts.piece) return `piece:${opts.piece}`
  if (opts.fcid) return `fcid:${opts.fcid}`
  return null
}

export async function osMediaCacheGet(key: string | null): Promise<Uint8Array | null> {
  if (!key) return null
  const provider = await getBridgeProvider()
  if (!provider) return null
  try {
    const res = (await provider.request({
      method: 'haven_mediaCacheGet',
      params: { key },
    })) as OsCachedMedia | null
    if (!res || !res.bytes) return null
    return res.bytes instanceof ArrayBuffer ? new Uint8Array(res.bytes) : new Uint8Array(res.bytes as ArrayBuffer)
  } catch {
    return null
  }
}

export async function osMediaCachePut(
  key: string | null,
  bytes: Uint8Array,
  opts?: { mimeType?: string; encrypted?: boolean },
): Promise<void> {
  if (!key || bytes.byteLength === 0) return
  const provider = await getBridgeProvider()
  if (!provider) return
  try {
    const buf = new ArrayBuffer(bytes.byteLength)
    new Uint8Array(buf).set(bytes)
    await provider.request({
      method: 'haven_mediaCachePut',
      params: {
        key,
        bytes: buf,
        mimeType: opts?.mimeType,
        encrypted: opts?.encrypted,
      },
    })
  } catch {
    // Cache writes are best-effort
  }
}

export async function osMediaCacheDelete(key: string | null): Promise<void> {
  if (!key) return
  const provider = await getBridgeProvider()
  if (!provider) return
  try {
    await provider.request({
      method: 'haven_mediaCacheDelete',
      params: { key },
    })
  } catch {
    // Best-effort
  }
}

export interface OsTransferReport {
  id: string
  direction: 'upload' | 'download'
  label: string
  from?: string
  to?: string
  loaded?: number
  total?: number
  status: 'active' | 'done' | 'error' | 'cancelled'
  detail?: string
}

const lastTransferEmit = new Map<string, number>()

/**
 * Reports an upload or download to Haven OS so it displays the classic Win98
 * flying-paper file transfer dialog. Active progress updates are throttled to
 * ~100ms per transfer id; terminal statuses (`done`/`error`/`cancelled`) are
 * always sent immediately.
 */
export function osReportTransfer(report: OsTransferReport): void {
  const now = Date.now()
  if (report.status === 'active') {
    const prev = lastTransferEmit.get(report.id) ?? 0
    if (now - prev < 100) return
    lastTransferEmit.set(report.id, now)
  } else {
    lastTransferEmit.delete(report.id)
  }
  void getBridgeProvider().then((provider) => {
    if (!provider) return
    return provider
      .request({
        method: 'haven_reportTransfer',
        params: report,
      })
      .catch(() => undefined)
  })
}
