'use client'

/**
 * One Trystero room per subreddit (gate). Signalling over public Nostr
 * relays, data over WebRTC DataChannels; no server of ours anywhere. The room
 * id is derived from the gate so every redhaven client watching the same
 * subreddit meets in the same room, and from the protocol version so v2 and
 * any later version never mix.
 */

import type { DataPayload, JoinRoomConfig } from 'trystero/nostr'
import { ROOM_APP_ID, ROOM_PREFIX, sha256Hex } from '@redhaven/vote-core'
import { env } from '../env'

export interface RoomHandle {
  readonly roomId: string
  send(msg: unknown, to?: string): void
  onMessage(cb: (msg: unknown, from: string) => void): void
  onPeerJoin(cb: (peerId: string) => void): void
  onPeerLeave(cb: (peerId: string) => void): void
  peers(): string[]
  leave(): Promise<void>
}

export function roomIdFor(gate: string): string {
  return `${ROOM_PREFIX}${sha256Hex(gate).slice(0, 24)}`
}

function rtcConfig(): RTCConfiguration {
  const iceServers: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }]
  if (env.turn) iceServers.push({ urls: env.turn.urls, ...(env.turn.username ? { username: env.turn.username } : {}), ...(env.turn.credential ? { credential: env.turn.credential } : {}) })
  return { iceServers }
}

export async function joinGateRoom(gate: string): Promise<RoomHandle> {
  const { joinRoom } = await import('trystero/nostr')
  const roomId = roomIdFor(gate)
  const config: JoinRoomConfig = { appId: ROOM_APP_ID, rtcConfig: rtcConfig() }
  // Trystero 0.26 names relay URLs `relayConfig.urls` (top-level `relayUrls` was the pre-0.26 shape).
  if (env.nostrRelays.length > 0) config.relayConfig = { urls: env.nostrRelays }
  const room = joinRoom(config, roomId)
  // 0.26: makeAction returns one object with `send` and an assignable `onMessage`, not a [send, receive] tuple.
  const action = room.makeAction<DataPayload>('m')
  return {
    roomId,
    send(msg, to) {
      void action.send(msg as DataPayload, to !== undefined ? { target: to } : undefined)
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
      await room.leave()
    },
  }
}
