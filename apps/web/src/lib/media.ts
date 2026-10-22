'use client'

/**
 * Media bytes for a submission: sealed `piece` CIDs come from Filecoin via
 * Synapse and are opened with the post's AES key; clear `fcid` roots come from
 * the configured IPFS gateway (or link out to haven-dapp when none is set, so
 * no gateway learns the reader's IP by default).
 *
 * Progress is reported as exact numbers: bytes received of total when the
 * provider sent a length, chunk n of m while opening. One task per locator;
 * a click attaches to the task already in flight.
 */

import { ENUM_TO_MIME, openAny, type MediaField, type ThreadRecord } from '@fairhaven/board-core'
import { aesKeyForGate, hasUnlocked, parseGateJson } from './aol'
import { fetchResumable } from './retrieve'
import { fetchSealedBytes } from './sealed-fetch'
import { env } from './env'

export type MediaPhase = { s: 'fetching'; received: number; total?: number } | { s: 'opening'; chunk: number; chunks: number }

export interface OpenedMedia {
  url: string
  bytes: Uint8Array
  mime: string
}

export interface MediaTask {
  phase: MediaPhase
  promise: Promise<OpenedMedia>
  subscribe(cb: (p: MediaPhase) => void): () => void
  cancel(): void
}

const CACHE_LIMIT = 200 * 1024 * 1024
const opened = new Map<string, OpenedMedia>()
let openedBytes = 0
const tasks = new Map<string, MediaTask>()

export function locatorOf(m: MediaField): string {
  return m.piece ?? m.fcid ?? ''
}

export function getOpened(locator: string): OpenedMedia | undefined {
  return opened.get(locator)
}

/** Drop decrypted bytes (wallet disconnect). */
export function clearOpened(): void {
  for (const o of opened.values()) URL.revokeObjectURL(o.url)
  opened.clear()
  openedBytes = 0
}

function remember(locator: string, bytes: Uint8Array, mime: string): OpenedMedia {
  while (openedBytes + bytes.length > CACHE_LIMIT && opened.size > 0) {
    const [k, v] = opened.entries().next().value as [string, OpenedMedia]
    URL.revokeObjectURL(v.url)
    opened.delete(k)
    openedBytes -= v.bytes.length
  }
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }))
  const o = { url, bytes, mime }
  opened.set(locator, o)
  openedBytes += bytes.length
  return o
}

/** Whether the viewer can open this media right now without any wallet prompt. */
export function canOpenNow(thread: ThreadRecord, m: MediaField): boolean {
  if (m.fcid !== undefined) return env.ipfsGateway !== ''
  if (!thread.payload?.gate) return false
  const g = parseGateJson(thread.payload.gate)
  return !!g && g.version === 3 && g.epoch !== undefined && hasUnlocked(g.gate, g.epoch)
}

export function foreignHref(thread: ThreadRecord): string {
  return `${env.havenDappUrl}/watch?v=${thread.key}`
}

async function fetchClear(fcid: string, declared: number | undefined, onPhase: (p: MediaPhase) => void, signal: AbortSignal): Promise<Uint8Array> {
  if (!env.ipfsGateway) throw new Error('clear media lives on IPFS — open it in haven-dapp')
  // Resumable: a dropped gateway connection resumes mid-file, not from zero.
  onPhase({ s: 'fetching', received: 0, ...(declared ? { total: declared } : {}) })
  return fetchResumable(`${env.ipfsGateway}/ipfs/${fcid}`, {
    signal,
    onProgress: (received, total) => {
      const t = total ?? declared
      onPhase({ s: 'fetching', received, ...(t ? { total: t } : {}) })
    },
  })
}

async function fetchSealed(thread: ThreadRecord, piece: string, declared: number | undefined, onPhase: (p: MediaPhase) => void, signal: AbortSignal): Promise<Uint8Array> {
  onPhase({ s: 'fetching', received: 0, ...(declared ? { total: declared } : {}) })
  if (signal.aborted) throw new DOMException('cancelled', 'AbortError')
  const gateChain = thread.payload?.gate ? parseGateJson(thread.payload.gate)?.gate.chain : undefined
  const bytes = await fetchSealedBytes({
    piece,
    owner: thread.owner,
    ...(gateChain ? { gateChain } : {}),
    source: 'redhaven-web',
    withCdn: env.synapseEnableCdn,
    signal,
    onProgress: (received, total) => { const tt = declared ?? total; onPhase({ s: 'fetching', received, ...(tt ? { total: tt } : {}) }) },
  })
  if (signal.aborted) throw new DOMException('cancelled', 'AbortError')
  onPhase({ s: 'fetching', received: bytes.length, total: declared ?? bytes.length })
  return bytes
}

/** Start (or attach to) opening one submission's media. */
export function openMedia(thread: ThreadRecord, m: MediaField): MediaTask {
  const locator = locatorOf(m)
  const existing = tasks.get(locator)
  if (existing) return existing
  const ctl = new AbortController()
  const subs = new Set<(p: MediaPhase) => void>()
  let phase: MediaPhase = { s: 'fetching', received: 0, ...(m.size ? { total: m.size } : {}) }
  const emit = (p: MediaPhase) => {
    phase = p
    task.phase = p
    for (const s of subs) s(p)
  }
  const mime = ENUM_TO_MIME[m.mime] ?? 'application/octet-stream'
  const promise = (async () => {
    const hit = opened.get(locator)
    if (hit) return hit
    if (m.fcid !== undefined) return remember(locator, await fetchClear(m.fcid, m.size, emit, ctl.signal), mime)
    if (!thread.payload?.gate) throw new Error('sealed media without a gate')
    const sealed = await fetchSealed(thread, m.piece!, m.size, emit, ctl.signal)
    const aesKey = await aesKeyForGate(thread.payload.gate)
    const plain = await openAny(sealed, aesKey, (p) => emit({ s: 'opening', chunk: p.chunk, chunks: p.chunks }), ctl.signal)
    return remember(locator, plain, mime)
  })().finally(() => tasks.delete(locator))
  const task: MediaTask = {
    phase,
    promise,
    subscribe(cb) {
      subs.add(cb)
      cb(phase)
      return () => subs.delete(cb)
    },
    cancel() {
      ctl.abort()
    },
  }
  tasks.set(locator, task)
  return task
}

export function phaseLabel(p: MediaPhase, fmt: (n: number) => string): string {
  if (p.s === 'fetching') return p.total ? `fetching · ${fmt(p.received)} of ${fmt(p.total)}` : `fetching · ${fmt(p.received)}`
  return `opening · ${p.chunk} of ${p.chunks}`
}

/** Short label for a listing thumbnail tile. */
export function mediaKind(mime: number): 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'comic' | 'file' | 'none' {
  if (mime === 0) return 'none'
  const m = ENUM_TO_MIME[mime] ?? ''
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('video/')) return 'video'
  if (m.startsWith('audio/')) return 'audio'
  if (m === 'application/pdf') return 'pdf'
  if (m.startsWith('text/')) return 'text'
  if (m.startsWith('application/vnd.comicbook')) return 'comic'
  return 'file'
}
