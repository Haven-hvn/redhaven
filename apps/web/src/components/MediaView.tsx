'use client'

import { useEffect, useState } from 'react'
import { ENUM_TO_MIME, type MediaField, type ThreadRecord } from '@fairhaven/board-core'
import { canOpenNow, foreignHref, getOpened, locatorOf, mediaKind, openMedia, phaseLabel, type MediaPhase, type OpenedMedia } from '@/lib/media'
import { formatBytes } from '@/lib/post'
import { parseGateJson } from '@/lib/aol'
import { useSession } from '@/store/session'
import { FrostText } from './Frost'
import { env } from '@/lib/env'

type State = { s: 'idle' } | { s: 'busy'; phase: MediaPhase; cancel: () => void } | { s: 'open'; media: OpenedMedia } | { s: 'failed'; reason: string }

/**
 * Inline media for a submission. Entitled viewers get it opened on mount
 * (pre-fetched and pre-decrypted); one wait line with exact numbers and
 * `cancel`; non-holders see frost with the adaptive caption.
 */
export function MediaView({ thread, media }: { thread: ThreadRecord; media: MediaField }) {
  const version = useSession((s) => s.unlockVersion)
  const locator = locatorOf(media)
  const [st, setSt] = useState<State>(() => {
    const hit = getOpened(locator)
    return hit ? { s: 'open', media: hit } : { s: 'idle' }
  })
  const mime = ENUM_TO_MIME[media.mime] ?? 'application/octet-stream'
  const kind = mediaKind(media.mime)
  const sealed = media.piece !== undefined
  const gate = thread.payload?.gate ? parseGateJson(thread.payload.gate) : undefined
  const foreign = sealed && (!gate || gate.version !== 3)

  const start = () => {
    if (st.s === 'busy' || st.s === 'open') return
    const task = openMedia(thread, media)
    const unsub = task.subscribe((phase) => setSt({ s: 'busy', phase, cancel: task.cancel }))
    task.promise
      .then((m) => setSt({ s: 'open', media: m }))
      .catch((e: unknown) => setSt(e instanceof DOMException && e.name === 'AbortError' ? { s: 'idle' } : { s: 'failed', reason: e instanceof Error ? e.message : String(e) }))
      .finally(unsub)
  }

  useEffect(() => {
    if (st.s === 'idle' && canOpenNow(thread, media)) start()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locator, version])

  if (st.s === 'open') return <Opened media={st.media} kind={kind} name={media.name} size={media.size} />
  if (foreign) return <FrostText sealedBytes={Math.min(media.size, 4096)} state="foreign" gate={thread.gate} reason={`protocol v${gate?.version ?? '?'}`} foreignHref={foreignHref(thread)} />
  if (st.s === 'failed') return <FrostText sealedBytes={2048} state="failed" gate={thread.gate} reason={st.reason} />
  if (st.s === 'busy') {
    return (
      <div className="media-wait">
        <span className="kind">{kind}</span> · {phaseLabel(st.phase, formatBytes)} ·{' '}
        <a href="#" onClick={(e) => { e.preventDefault(); st.cancel() }}>cancel</a>
      </div>
    )
  }
  if (sealed) return <FrostText sealedBytes={Math.min(media.size, 4096)} state="locked" gate={thread.gate} />
  // Clear media without a gateway: link out rather than leak the reader's IP to a default gateway.
  if (!env.ipfsGateway) {
    return (
      <div className="media-wait">
        <span className="kind">{kind}</span> · {media.name ?? mime} · {formatBytes(media.size)} ·{' '}
        <a href={foreignHref(thread)} target="_blank" rel="noreferrer noopener">open in haven-dapp</a>
      </div>
    )
  }
  return (
    <div className="media-wait">
      <span className="kind">{kind}</span> · {media.name ?? mime} · {formatBytes(media.size)} ·{' '}
      <a href="#" onClick={(e) => { e.preventDefault(); start() }}>open</a>
    </div>
  )
}

function Opened({ media, kind, name, size }: { media: OpenedMedia; kind: ReturnType<typeof mediaKind>; name?: string; size: number }) {
  switch (kind) {
    case 'image':
      return <img className="media-img" src={media.url} alt={name ?? 'image'} />
    case 'video':
      return <video className="media-video" src={media.url} controls preload="metadata" />
    case 'audio':
      return <audio src={media.url} controls preload="metadata" />
    case 'pdf':
      return <iframe className="media-pdf" src={media.url} title={name ?? 'document'} />
    case 'text':
      return <TextMedia bytes={media.bytes} />
    default:
      return (
        <div className="media-wait">
          <a href={media.url} download={name ?? 'file'}>download {name ?? kind}</a> · {formatBytes(size)}
        </div>
      )
  }
}

function TextMedia({ bytes }: { bytes: Uint8Array }) {
  const [text] = useState(() => new TextDecoder().decode(bytes.subarray(0, 64 * 1024)))
  return <pre className="media-text">{text}</pre>
}

/** The 70×50 tile on listing rows: a real thumbnail once opened, else a labelled tile. */
export function Thumbnail({ thread }: { thread: ThreadRecord }) {
  const version = useSession((s) => s.unlockVersion)
  const media = thread.payload?.media
  const [url, setUrl] = useState<string | undefined>(() => (media ? getOpened(locatorOf(media))?.url : undefined))
  useEffect(() => {
    if (!media || url || mediaKind(media.mime) !== 'image' || !canOpenNow(thread, media)) return
    const task = openMedia(thread, media)
    let alive = true
    task.promise.then((m) => { if (alive) setUrl(m.url) }).catch(() => undefined)
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [media?.piece, media?.fcid, version])
  if (!media) return <span className="thumbnail self" aria-hidden />
  const kind = mediaKind(media.mime)
  if (url) return <span className="thumbnail" style={{ backgroundImage: `url(${url})` }} role="img" aria-label={media.name ?? 'image'} />
  return <span className={`thumbnail ${media.piece ? 'sealed' : ''}`} title={media.piece ? 'sealed media' : kind}>{kind}</span>
}
