/**
 * Durable state under `storePath`, one JSON file per concern, written
 * atomically (tmp + rename) with mode 0600. Without a `storePath` everything
 * lives in memory and dies with the process; the agent then re-syncs from
 * peers on the next join, which is fine but slower.
 *
 *   <storePath>/votes/<roomId>.json   { v: 1, gate, votes: Vote[] }
 *   <storePath>/sessions.json         { v: 1, sessions: StoredSession[] }
 *   <storePath>/receipts.json         { v: 1, receipts: StoredReceipt[] }
 *
 * Session private keys are throwaway secp256k1 keys scoped to one gate for at
 * most one epoch; they can vote, nothing else. They sit next to the register
 * at 0600 like dsh-haven-aol's keyStorePath. Revoke with vote_session_revoke.
 * Receipts are public data (they travel inside every vote).
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isMemberReceiptShape, isVoteShape, normalizeVote, type MemberReceipt, type SessionCert, type Vote } from '@redhaven/vote-core'

export interface StoredSession {
  /** `<gate>|<holder>` */
  id: string
  gate: string
  holder: string
  cert: SessionCert
  /** Session private key, 0x hex (32 bytes). */
  key: string
}

export interface StoredReceipt {
  /** `<gate>|<holder>` */
  id: string
  receipt: MemberReceipt
}

interface ReceiptsFile {
  v: 1
  receipts: StoredReceipt[]
}

interface VotesFile {
  v: 1
  gate: string
  votes: Vote[]
}

interface SessionsFile {
  v: 1
  sessions: StoredSession[]
}

export interface VoteStore {
  loadVotes(gate: string, roomId: string): Promise<Vote[]>
  saveVotes(gate: string, roomId: string, votes: readonly Vote[]): Promise<void>
  listRooms(): Promise<string[]>
  loadSessions(): Promise<StoredSession[]>
  saveSessions(sessions: readonly StoredSession[]): Promise<void>
  loadReceipts(): Promise<StoredReceipt[]>
  saveReceipts(receipts: readonly StoredReceipt[]): Promise<void>
}

async function writeAtomic(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  await writeFile(tmp, data, { mode: 0o600 })
  await rename(tmp, path)
}

export class FileStore implements VoteStore {
  constructor(private readonly root: string) {}

  private votesPath(roomId: string): string {
    if (!/^[a-z0-9-]+$/.test(roomId)) throw new Error('dsh-votes: bad room id')
    return join(this.root, 'votes', `${roomId}.json`)
  }

  async loadVotes(gate: string, roomId: string): Promise<Vote[]> {
    try {
      const raw = JSON.parse(await readFile(this.votesPath(roomId), 'utf8')) as Partial<VotesFile>
      if (raw.v !== 1 || raw.gate !== gate || !Array.isArray(raw.votes)) return []
      return raw.votes.filter(isVoteShape).map(normalizeVote)
    } catch {
      return []
    }
  }

  async saveVotes(gate: string, roomId: string, votes: readonly Vote[]): Promise<void> {
    const file: VotesFile = { v: 1, gate, votes: [...votes] }
    if (votes.length === 0) {
      await rm(this.votesPath(roomId), { force: true })
      return
    }
    await writeAtomic(this.votesPath(roomId), JSON.stringify(file))
  }

  async listRooms(): Promise<string[]> {
    try {
      return (await readdir(join(this.root, 'votes'))).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5))
    } catch {
      return []
    }
  }

  async loadSessions(): Promise<StoredSession[]> {
    try {
      const raw = JSON.parse(await readFile(join(this.root, 'sessions.json'), 'utf8')) as Partial<SessionsFile>
      if (raw.v !== 1 || !Array.isArray(raw.sessions)) return []
      return raw.sessions.filter((s): s is StoredSession => typeof s === 'object' && s !== null && typeof (s as StoredSession).id === 'string' && typeof (s as StoredSession).key === 'string')
    } catch {
      return []
    }
  }

  async saveSessions(sessions: readonly StoredSession[]): Promise<void> {
    const file: SessionsFile = { v: 1, sessions: [...sessions] }
    await writeAtomic(join(this.root, 'sessions.json'), JSON.stringify(file))
  }

  async loadReceipts(): Promise<StoredReceipt[]> {
    try {
      const raw = JSON.parse(await readFile(join(this.root, 'receipts.json'), 'utf8')) as Partial<ReceiptsFile>
      if (raw.v !== 1 || !Array.isArray(raw.receipts)) return []
      return raw.receipts.filter((r): r is StoredReceipt => typeof r === 'object' && r !== null && typeof (r as StoredReceipt).id === 'string' && isMemberReceiptShape((r as StoredReceipt).receipt))
    } catch {
      return []
    }
  }

  async saveReceipts(receipts: readonly StoredReceipt[]): Promise<void> {
    const file: ReceiptsFile = { v: 1, receipts: [...receipts] }
    await writeAtomic(join(this.root, 'receipts.json'), JSON.stringify(file))
  }
}

export class MemoryStore implements VoteStore {
  private readonly votes = new Map<string, Vote[]>()
  private sessions: StoredSession[] = []
  private receipts: StoredReceipt[] = []

  async loadVotes(_gate: string, roomId: string): Promise<Vote[]> {
    return [...(this.votes.get(roomId) ?? [])]
  }

  async saveVotes(_gate: string, roomId: string, votes: readonly Vote[]): Promise<void> {
    this.votes.set(roomId, [...votes])
  }

  async listRooms(): Promise<string[]> {
    return [...this.votes.keys()]
  }

  async loadSessions(): Promise<StoredSession[]> {
    return [...this.sessions]
  }

  async saveSessions(sessions: readonly StoredSession[]): Promise<void> {
    this.sessions = [...sessions]
  }

  async loadReceipts(): Promise<StoredReceipt[]> {
    return [...this.receipts]
  }

  async saveReceipts(receipts: readonly StoredReceipt[]): Promise<void> {
    this.receipts = [...receipts]
  }
}
