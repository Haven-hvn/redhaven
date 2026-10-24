import { sha256 } from '@noble/hashes/sha2.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js'

export { bytesToHex, hexToBytes, randomBytes, utf8ToBytes }

export const ADDR_RE: RegExp = /^0x[0-9a-f]{40}$/
export const KEY_RE: RegExp = /^0x[0-9a-f]{64}$/
export const SIG_RE: RegExp = /^0x[0-9a-f]{130}$/
export const GATE_RE: RegExp = /^gate:(\d{1,10}):(0x[0-9a-f]{40}):(\d{1,78})$/

export function strip0x(h: string): string {
  return h.startsWith('0x') || h.startsWith('0X') ? h.slice(2) : h
}

export function hex0x(b: Uint8Array): string {
  return `0x${bytesToHex(b)}`
}

export function sha256Hex(data: Uint8Array | string): string {
  return bytesToHex(sha256(typeof data === 'string' ? utf8ToBytes(data) : data))
}

export function keccak(data: Uint8Array | string): Uint8Array {
  return keccak_256(typeof data === 'string' ? utf8ToBytes(data) : data)
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0
  for (const p of parts) n += p.length
  const out = new Uint8Array(n)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** Left-pad to 32 bytes (ABI word). */
export function word(b: Uint8Array): Uint8Array {
  if (b.length > 32) throw new Error('vote-core: word overflow')
  const out = new Uint8Array(32)
  out.set(b, 32 - b.length)
  return out
}

export function uint256(n: number | bigint): Uint8Array {
  let v = BigInt(n)
  if (v < 0n) throw new Error('vote-core: negative uint')
  const out = new Uint8Array(32)
  for (let i = 31; i >= 0 && v > 0n; i--) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}

export function addressWord(addr: string): Uint8Array {
  const l = addr.toLowerCase()
  if (!ADDR_RE.test(l)) throw new Error(`vote-core: invalid address ${JSON.stringify(addr)}`)
  return word(hexToBytes(l.slice(2)))
}

export function isUnixSeconds(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < 2 ** 53
}

/** Parse a gate spec. Returns undefined when it is not canonical (lowercase, no leading zeros in numbers). */
export function parseGate(spec: unknown): { chainId: number; token: string; threshold: bigint } | undefined {
  if (typeof spec !== 'string') return undefined
  const m = GATE_RE.exec(spec)
  if (!m) return undefined
  const chainStr = m[1] as string
  const thrStr = m[3] as string
  if ((chainStr.length > 1 && chainStr.startsWith('0')) || (thrStr.length > 1 && thrStr.startsWith('0'))) return undefined
  const chainId = Number(chainStr)
  const threshold = BigInt(thrStr)
  if (chainId <= 0 || threshold <= 0n) return undefined
  return { chainId, token: m[2] as string, threshold }
}

export function gateSpec(chainId: number, token: string, threshold: bigint | number | string): string {
  const t = token.toLowerCase()
  if (!ADDR_RE.test(t)) throw new Error(`vote-core: invalid token ${JSON.stringify(token)}`)
  const thr = BigInt(threshold)
  if (!Number.isInteger(chainId) || chainId <= 0 || thr <= 0n) throw new Error('vote-core: invalid gate')
  return `gate:${chainId}:${t}:${thr.toString()}`
}
