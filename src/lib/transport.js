/**
 * P2P transport — Trystero WebRTC DataChannels.
 *
 * Signaling strategy: Nostr (borrowed signaling fallback, permitted by
 * the agreed protocol). All vote payload exchange is direct peer-to-peer
 * over DataChannels once signaling completes.
 *
 * Gossip:
 * - on peer join → send full validated vote set to the joiner
 * - on receipt → validate locally; only fully-valid votes enter the
 *   G-Set and are rebroadcast to other peers (dedupe by vote id)
 * - tallies are never transmitted; every client computes them locally
 */

import { joinRoom } from 'trystero/nostr'
import { voteId, validateVote } from './haven/vote.js'

const APP_ID = 'haven-oldreddit-v1'

export class VoteTransport {
  /**
   * @param {object} opts
   * @param {string} opts.mode 'demo' | 'live' — separate rooms so demo
   *   votes never mix with live ones
   * @param {(slug: string) => object} opts.getGate board slug → gate resolver
   * @param {Uint8Array} opts.issuerPublicKey pinned attestation issuer key
   * @param {(votes: object[], fromRemote: boolean) => void} opts.onVotes
   * @param {(rejected: {id?: string, reason: string}[], fromPeerId: string|null) => void} [opts.onRejected]
   * @param {(count: number) => void} opts.onPeers
   */
  constructor(opts) {
    this.mode = opts.mode
    this.getGate = opts.getGate
    this.issuerPublicKey = opts.issuerPublicKey
    this.onVotes = opts.onVotes
    this.onRejected = opts.onRejected
    this.onPeers = opts.onPeers
    this.room = null
    this.voteAction = null
    this.relayedIds = new Set()
  }

  start() {
    this.room = joinRoom({ appId: APP_ID }, `votes-${this.mode}-v1`)

    const voteAction = this.room.makeAction('vote', {
      onMessage: (data, context) => {
        this.ingest(Array.isArray(data) ? data : [data], context.peerId)
      },
    })
    this.voteAction = voteAction

    const setAction = this.room.makeAction('voteSet', {
      onMessage: (data, context) => {
        this.ingest(data?.votes ?? [], context.peerId)
      },
    })
    this.setAction = setAction

    this.room.onPeerJoin = (peerId) => {
      // Gossip-download: hand the new joiner our full validated set.
      setAction.send({ votes: this.snapshot() }, { target: peerId }).catch(() => {})
      this.notifyPeers()
    }
    this.room.onPeerLeave = () => this.notifyPeers()

    // Initial count
    this.notifyPeers()
  }

  notifyPeers() {
    if (!this.room || !this.onPeers) return
    try {
      this.onPeers(Object.keys(this.room.getPeers()).length)
    } catch {
      this.onPeers(0)
    }
  }

  /** Locally-created vote: validate, insert, broadcast. */
  publishVote(vote) {
    return this.ingest([vote], null)
  }

  /**
   * Validate and merge incoming votes. Valid new votes are rebroadcast
   * to every peer (sources dedupe by id). Returns {added, rejected}.
   */
  ingest(votes, fromPeerId) {
    const added = []
    const rejected = []
    for (const vote of votes) {
      const id = safeVoteId(vote)
      if (!id) { rejected.push({ reason: 'malformed' }); continue }
      if (this.relayedIds.has(id)) continue

      const gate = this.getGate(vote.board)
      if (!gate) { rejected.push({ id, reason: 'unknown board' }); continue }

      const check = validateVote(vote, gate, this.issuerPublicKey)
      if (!check.ok) { rejected.push({ id, reason: check.reason }); continue }

      this.relayedIds.add(id)
      added.push({ id, vote })
      this.onVotes([{ id, vote }], fromPeerId !== null)
    }
    for (const { vote } of added) this.voteAction.send(vote).catch(() => {})
    if (rejected.length && this.onRejected) this.onRejected(rejected, fromPeerId)
    return { added, rejected }
  }

  snapshot() {
    return this.snapshotProvider ? this.snapshotProvider() : []
  }

  /** Register the G-Set snapshot provider (avoids circular import). */
  setSnapshotProvider(fn) {
    this.snapshotProvider = fn
  }

  async stop() {
    if (this.room) await this.room.leave()
  }
}

function safeVoteId(vote) {
  try {
    return voteId(vote)
  } catch {
    return null
  }
}
