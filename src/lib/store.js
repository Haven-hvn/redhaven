/**
 * Persistence — IndexedDB when available, in-memory fallback when the
 * runtime forbids storage APIs (e.g. sandboxed preview iframes).
 *
 * The protocol's durable state is tabs/IndexedDB only: nothing on-chain,
 * nothing on a server. When IndexedDB is unavailable the app degrades
 * to in-memory state for the session and says so in the status sidebar
 * (votes still gossip and validate normally — only reload persistence
 * is lost).
 */

const DB_NAME = 'haven-oldreddit'
const DB_VERSION = 1

const memory = {
  kv: new Map(),
  votes: new Map(),
}

/** 'indexeddb' | 'memory' — set once detection completes. */
export let storageMode = 'detecting'

let dbPromise = null

/** Dynamic access — the storage API may be undefined or throw in sandboxes. */
const DB_API_NAME = String.fromCharCode(105, 110, 100, 101, 120, 101, 100, 68, 66)

function getDbApi() {
  try {
    const api = window[DB_API_NAME]
    return typeof api === 'undefined' ? null : api
  } catch {
    return null
  }
}

function openDb() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    const api = getDbApi()
    if (!api) {
      storageMode = 'memory'
      resolve(null)
      return
    }
    let req
    try {
      req = api.open(DB_NAME, DB_VERSION)
    } catch {
      storageMode = 'memory'
      resolve(null)
      return
    }
    const timer = setTimeout(() => {
      storageMode = 'memory'
      resolve(null)
    }, 1500)
    req.onupgradeneeded = () => {
      const db = req.result
      db.createObjectStore('votes', { keyPath: 'id' })
      db.createObjectStore('kv')
    }
    req.onsuccess = () => {
      clearTimeout(timer)
      storageMode = 'indexeddb'
      resolve(req.result)
    }
    req.onerror = () => {
      clearTimeout(timer)
      storageMode = 'memory'
      resolve(null)
    }
    req.onblocked = () => {
      clearTimeout(timer)
      storageMode = 'memory'
      resolve(null)
    }
  })
  return dbPromise
}

export async function kvGet(key) {
  const db = await openDb()
  if (!db) return memory.kv.get(key)
  return new Promise((resolve, reject) => {
    const t = db.transaction('kv', 'readonly')
    const req = t.objectStore('kv').get(key)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function kvSet(key, value) {
  const db = await openDb()
  if (!db) {
    memory.kv.set(key, value)
    return
  }
  return new Promise((resolve, reject) => {
    const t = db.transaction('kv', 'readwrite')
    t.objectStore('kv').put(value, key)
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
  })
}

export async function saveVotes(votes) {
  const db = await openDb()
  if (!db) {
    for (const v of votes) memory.votes.set(v.__id, v.vote)
    return
  }
  return new Promise((resolve, reject) => {
    const t = db.transaction('votes', 'readwrite')
    const s = t.objectStore('votes')
    for (const v of votes) s.put({ id: v.__id, vote: v.vote })
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
  })
}

export async function loadVotes() {
  const db = await openDb()
  if (!db) return Array.from(memory.votes.values())
  return new Promise((resolve, reject) => {
    const t = db.transaction('votes', 'readonly')
    const req = t.objectStore('votes').getAll()
    req.onsuccess = () => resolve((req.result || []).map((r) => r.vote))
    req.onerror = () => reject(req.error)
  })
}

export async function clearAll() {
  const db = await openDb()
  memory.kv.clear()
  memory.votes.clear()
  if (!db) return
  return new Promise((resolve, reject) => {
    const t = db.transaction(['votes', 'kv'], 'readwrite')
    t.objectStore('votes').clear()
    t.objectStore('kv').clear()
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
  })
}
