import { describe, expect, it } from 'vitest'
import { SESSION_DOMAIN_NAME, SESSION_DOMAIN_VERSION, SESSION_TYPES, gateSpec, parseGate, votePreimage } from '../src/index.ts'
import vectors from './fixtures/vote-vectors.json'
import { mintHolder } from './helpers.ts'

describe('pinned wire vectors', () => {
  it('vote preimage', () => {
    const h = mintHolder()
    const v = { ...vectors.votePreimage.input, session: h.session } as never
    expect(votePreimage(v)).toBe(vectors.votePreimage.expected)
  })

  it('session EIP-712 type string and domain', () => {
    const typeString = `HavenVoteSession(${SESSION_TYPES.HavenVoteSession.map((f) => `${f.type} ${f.name}`).join(',')})`
    expect(typeString).toBe(vectors.sessionType)
    expect({ name: SESSION_DOMAIN_NAME, version: SESSION_DOMAIN_VERSION }).toEqual(vectors.domain)
  })

  it('gate specs: canonical only', () => {
    for (const g of vectors.gateSpec.valid) expect(parseGate(g)).toBeDefined()
    for (const g of vectors.gateSpec.invalid) expect(parseGate(g)).toBeUndefined()
    expect(gateSpec(8453, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 1n)).toBe(vectors.gateSpec.valid[1])
  })
})
