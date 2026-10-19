/**
 * One Trystero room per subreddit (gate), the same room the web client joins:
 * same app id, same `votes-v3-<sha256(gate)[:24]>` id, same Nostr signalling,
 * so an agent and a browser watching one subreddit meet as ordinary peers.
 *
 * Node has no RTCPeerConnection; Trystero accepts one through `rtcPolyfill`
 * and `werift` provides a pure-TypeScript implementation (no native build).
 * The polyfill is imported lazily so tests that replace `createRoom` never
 * load WebRTC at all.
 */

import { ROOM_APP_ID, ROOM_PREFIX, sha256Hex } from '@redhaven/vote-core'

export interface RoomHandle {
  readonly roomId: string
  send(msg: unknown, to?: string): void
  onMessage(cb: (msg: unknown, from: string) => void): void
  onPeerJoin(cb: (peerId: string) => void): void
  onPeerLeave(cb: (peerId: string) => void): void
  peers(): string[]
  leave(): Promise<void>
}

export interface TransportOptions {
  nostrRelays?: string[]
  turn?: { urls: string[]; username?: string; credential?: string }
}

export function roomIdFor(gate: string): string {
  return `${ROOM_PREFIX}${sha256Hex(gate).slice(0, 24)}`
}

function iceServers(opts: TransportOptions): Array<{ urls: string[]; username?: string; credential?: string }> {
  const out: Array<{ urls: string[]; username?: string; credential?: string }> = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }]
  if (opts.turn) out.push({ urls: opts.turn.urls, ...(opts.turn.username ? { username: opts.turn.username } : {}), ...(opts.turn.credential ? { credential: opts.turn.credential } : {}) })
  return out
}

export async function joinGateRoom(gate: string, opts: TransportOptions = {}): Promise<RoomHandle> {
  const [{ joinRoom }, { RTCPeerConnection }] = await Promise.all([import('trystero/nostr'), import('werift')])
  const roomId = roomIdFor(gate)
  const config: Record<string, unknown> = {
    appId: ROOM_APP_ID,
    rtcPolyfill: RTCPeerConnection,
    rtcConfig: { iceServers: iceServers(opts) },
  }
  if (opts.nostrRelays && opts.nostrRelays.length > 0) config.relayUrls = opts.nostrRelays
  const room = joinRoom(config as never, roomId)
  const action = room.makeAction('m')
  return {
    roomId,
    send(msg, to) {
      void action.send(msg as never, to ? { target: to } : undefined)
    },
    onMessage(cb) {
      action.onMessage = (data, context) => cb(data, String(context.peerId))
    },
    onPeerJoin(cb) {
      room.onPeerJoin = (id) => cb(String(id))
    },
    onPeerLeave(cb) {
      room.onPeerLeave = (id) => cb(String(id))
    },
    peers() {
      return Object.keys(room.getPeers())
    },
    async leave() {
      await Promise.resolve(room.leave())
    },
  }
}
