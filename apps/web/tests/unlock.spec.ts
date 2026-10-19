import { describe, expect, it } from 'vitest'
import type { BoardGate } from '@fairhaven/board-core'
import { forgetStoredVetKeys, loadVetKeyBytes, storeVetKeyBytes } from '../src/lib/aol'

/**
 * Unlock persistence: the recovered epoch key is stored AES-GCM-wrapped
 * (never plaintext) so a page reload needs neither a wallet signature nor
 * a Haven-AOL call — and only the wallet that unlocked can restore it.
 */
const gate: BoardGate = { chain: 'EthSepolia', tokenAddress: '0xf23a728b55be000000000000000000000000493e', threshold: 1n }
const me = '0x5c32469325d4093ab142dddc1305f91d76e45141'
const other = '0x0000000000000000000000000000000000000001'
const bytes = new Uint8Array(48).map((_, i) => i + 1)

describe('stored vetKeys', () => {
  it('round-trips the key bytes for the wallet that unlocked', async () => {
    await storeVetKeyBytes(gate, 679, me, bytes)
    expect(await loadVetKeyBytes(gate, 679, me)).toEqual(bytes)
  })
  it('does not hand the key to a different wallet, gate, or epoch', async () => {
    await storeVetKeyBytes(gate, 679, me, bytes)
    expect(await loadVetKeyBytes(gate, 679, other)).toBeUndefined()
    expect(await loadVetKeyBytes(gate, 680, me)).toBeUndefined()
    expect(await loadVetKeyBytes({ ...gate, threshold: 2n }, 679, me)).toBeUndefined()
  })
  it('forgetting removes the stored key', async () => {
    await storeVetKeyBytes(gate, 679, me, bytes)
    await forgetStoredVetKeys()
    expect(await loadVetKeyBytes(gate, 679, me)).toBeUndefined()
  })
})
