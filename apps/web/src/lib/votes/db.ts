'use client'

/**
 * IndexedDB persistence for the vote layer. One database, three stores:
 *
 *   votes     — validated votes, keyed by id, indexed by gate
 *   sessions  — session certificates + the session private key WRAPPED with a
 *               non-extractable AES-GCM key (see keystore.ts), keyed by gate+holder
 *   kv        — the wrapping key itself and small settings
 *
 * All methods degrade to an in-memory map when IndexedDB is unavailable
 * (private mode, sandboxed iframe), so the app still works for the session.
 */

import type { Vote } from '@redhaven/vote-core'

// v2: HAVEN_VOTE_V3 (receipt-bearing sessions). Older stores are dropped on upgrade; peers resend.
const DB_NAME = 'redhaven'
const DB_VERSION = 2

export interface StoredSession {
  /** `${gate}|${holder}` */
  id: string
  gate: string
  holder: string
  cert: import('@redhaven/vote-core').SessionCert
  /** AES-GCM ciphertext of the 32-byte session private key. */
  wrapped: Uint8Array
  iv: Uint8Array
}

interface StoredVote {
  id: string
  gate: string
  at: number
  vote: Vote
}

type Mode = { kind: 'idb'; db: IDBDatabase } | { kind: 'memory'; votes: Map<string, StoredVote>; sessions: Map<string, StoredSession>; kv: Map<string, unknown> }

let modeP: Promise<Mode> | undefined

function openDb(): Promise<Mode> {
  return (modeP ??= new Promise<Mode>((resolve) => {
    const memory = (): Mode => ({ kind: 'memory', votes: new Map(), sessions: new Map(), kv: new Map() })
    if (typeof indexedDB === 'undefined') return resolve(memory())
    let settled = false
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve(memory()) } }, 2000)
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        // Nothing from a previous protocol version is reusable: votes fail validation, sessions lack receipts.
        for (const name of ['votes', 'sessions']) if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name)
        if (!db.objectStoreNames.contains('votes')) db.createObjectStore('votes', { keyPath: 'id' }).createIndex('gate', 'gate')
        if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' })
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv')
      }
      req.onsuccess = () => { if (!settled) { settled = true; clearTimeout(timer); resolve({ kind: 'idb', db: req.result }) } }
      req.onerror = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(memory()) } }
      req.onblocked = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(memory()) } }
    } catch {
      if (!settled) { settled = true; clearTimeout(timer); resolve(memory()) }
    }
  }))
}

function tx<T>(db: IDBDatabase, store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode)
    const s = t.objectStore(store)
    let out: T | undefined
    const r = fn(s)
    if (r) r.onsuccess = () => { out = r.result }
    t.oncomplete = () => resolve(out)
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error)
  })
}

export const voteDb = {
  async loadVotes(gate: string): Promise<Vote[]> {
    const m = await openDb()
    if (m.kind === 'memory') return [...m.votes.values()].filter((v) => v.gate === gate).map((v) => v.vote)
    const rows = await tx<StoredVote[]>(m.db, 'votes', 'readonly', (s) => s.index('gate').getAll(gate))
    return (rows ?? []).map((r) => r.vote)
  },

  async putVotes(entries: Array<{ id: string; vote: Vote }>): Promise<void> {
    if (entries.length === 0) return
    const m = await openDb()
    if (m.kind === 'memory') {
      for (const e of entries) m.votes.set(e.id, { id: e.id, gate: e.vote.gate, at: e.vote.at, vote: e.vote })
      return
    }
    await tx(m.db, 'votes', 'readwrite', (s) => { for (const e of entries) s.put({ id: e.id, gate: e.vote.gate, at: e.vote.at, vote: e.vote } satisfies StoredVote) })
  },

  async deleteVotes(ids: string[]): Promise<void> {
    if (ids.length === 0) return
    const m = await openDb()
    if (m.kind === 'memory') { for (const id of ids) m.votes.delete(id); return }
    await tx(m.db, 'votes', 'readwrite', (s) => { for (const id of ids) s.delete(id) })
  },

  async getSession(gate: string, holder: string): Promise<StoredSession | undefined> {
    const m = await openDb()
    const id = `${gate}|${holder.toLowerCase()}`
    if (m.kind === 'memory') return m.sessions.get(id)
    return tx<StoredSession>(m.db, 'sessions', 'readonly', (s) => s.get(id))
  },

  async putSession(s: StoredSession): Promise<void> {
    const m = await openDb()
    if (m.kind === 'memory') { m.sessions.set(s.id, s); return }
    await tx(m.db, 'sessions', 'readwrite', (st) => { st.put(s) })
  },

  async listSessions(): Promise<StoredSession[]> {
    const m = await openDb()
    if (m.kind === 'memory') return [...m.sessions.values()]
    return (await tx<StoredSession[]>(m.db, 'sessions', 'readonly', (s) => s.getAll())) ?? []
  },

  async deleteSession(id: string): Promise<void> {
    const m = await openDb()
    if (m.kind === 'memory') { m.sessions.delete(id); return }
    await tx(m.db, 'sessions', 'readwrite', (s) => { s.delete(id) })
  },

  async kvGet<T>(key: string): Promise<T | undefined> {
    const m = await openDb()
    if (m.kind === 'memory') return m.kv.get(key) as T | undefined
    return tx<T>(m.db, 'kv', 'readonly', (s) => s.get(key))
  },

  async kvSet(key: string, value: unknown): Promise<void> {
    const m = await openDb()
    if (m.kind === 'memory') { m.kv.set(key, value); return }
    await tx(m.db, 'kv', 'readwrite', (s) => { s.put(value, key) })
  },

  async kvDelete(key: string): Promise<void> {
    const m = await openDb()
    if (m.kind === 'memory') { m.kv.delete(key); return }
    await tx(m.db, 'kv', 'readwrite', (s) => { s.delete(key) })
  },

  /** Wipe everything (prefs → "clear local data"). */
  async clearAll(): Promise<void> {
    const m = await openDb()
    if (m.kind === 'memory') { m.votes.clear(); m.sessions.clear(); m.kv.clear(); return }
    for (const store of ['votes', 'sessions', 'kv']) await tx(m.db, store, 'readwrite', (s) => { s.clear() })
  },

  async isPersistent(): Promise<boolean> {
    return (await openDb()).kind === 'idb'
  },
}
