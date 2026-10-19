/**
 * Haven-AOL canister client for receipts: `getAttestationPublicKey` (one
 * query, cache it) and `attestHolding` (one update call per member per gate
 * per epoch). Hand-written Candid matching the canister's `AttestRequest` /
 * `AttestResult`. Subpath export (`@redhaven/vote-core/canister`) so the pure
 * core never loads the ICP agent; both the web app and dsh-votes use this.
 */

import type { AttestHoldingOk, AttestHoldingRequest } from './attest.ts'

export interface CanisterOpts {
  canisterId: string
  icpHost: string
  fetchRootKey?: boolean
}

export type AttestHoldingResult = { ok: AttestHoldingOk } | { err: Record<string, unknown> }

export interface AttestCanister {
  publicKey(): Promise<Uint8Array>
  attestHolding(req: AttestHoldingRequest): Promise<AttestHoldingResult>
}

export function describeAttestError(err: Record<string, unknown>): string {
  if ('InsufficientBalance' in err) {
    const e = err.InsufficientBalance as { required: bigint; actual: bigint }
    return `this wallet holds ${e.actual.toString()} of the ${e.required.toString()} required`
  }
  if ('EvmRpcError' in err) return `the canister could not read the gate chain (${String(err.EvmRpcError)}); try again`
  if ('InvalidSignature' in err) return `the canister rejected the wallet signature (${String(err.InvalidSignature)})`
  if ('NonceAlreadyUsed' in err) return 'nonce reused; try again'
  const k = Object.keys(err)[0] ?? 'unknown'
  return `canister refused: ${k}${typeof err[k] === 'string' ? ` (${err[k] as string})` : ''}`
}

export async function connectAttestCanister(opts: CanisterOpts): Promise<AttestCanister> {
  const { HttpAgent, AnonymousIdentity, Actor } = await import('@icp-sdk/core/agent')
  const { IDL } = await import('@icp-sdk/core/candid')
  const agent = await HttpAgent.create({ host: opts.icpHost, identity: new AnonymousIdentity(), verifyQuerySignatures: false })
  if (opts.fetchRootKey) await agent.fetchRootKey()

  const chainVariant = IDL.Variant({ EthMainnet: IDL.Null, EthSepolia: IDL.Null, ArbitrumOne: IDL.Null, BaseMainnet: IDL.Null, OptimismMainnet: IDL.Null })
  const req = IDL.Record({
    chain: chainVariant,
    tokenAddress: IDL.Text,
    threshold: IDL.Nat,
    cidHash: IDL.Text,
    evmAddress: IDL.Text,
    nonce: IDL.Nat,
    signature: IDL.Vec(IDL.Nat8),
    eip712ChainId: IDL.Nat,
    eip712VerifyingContract: IDL.Text,
  })
  const attestation = IDL.Record({
    evmAddress: IDL.Text,
    chain: chainVariant,
    tokenAddress: IDL.Text,
    threshold: IDL.Nat,
    balanceAtCheck: IDL.Nat,
    cidHash: IDL.Text,
    timestamp: IDL.Nat,
  })
  const err = IDL.Variant({
    InsufficientBalance: IDL.Record({ required: IDL.Nat, actual: IDL.Nat }),
    InvalidAddress: IDL.Text,
    InvalidThreshold: IDL.Null,
    EvmRpcError: IDL.Text,
    VetKDError: IDL.Text,
    InvalidSignature: IDL.Text,
    NonceAlreadyUsed: IDL.Null,
    InvalidEpoch: IDL.Null,
    MarketCapNotReached: IDL.Record({ required: IDL.Nat, actual: IDL.Nat }),
    InvalidOracle: IDL.Text,
  })
  const res = IDL.Variant({ ok: IDL.Record({ attestation, signature: IDL.Vec(IDL.Nat8) }), err })
  const factory = () => IDL.Service({ attestHolding: IDL.Func([req], [res], []), getAttestationPublicKey: IDL.Func([], [IDL.Vec(IDL.Nat8)], ['query']) })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actor: any = Actor.createActor(factory, { agent, canisterId: opts.canisterId })

  return {
    async publicKey() {
      const k = new Uint8Array(await actor.getAttestationPublicKey())
      if (k.length !== 32) throw new Error('vote-core: canister returned an attestation key that is not 32 bytes')
      return k
    },
    async attestHolding(r) {
      const out = (await actor.attestHolding({
        chain: { [r.chain]: null },
        tokenAddress: r.tokenAddress,
        threshold: r.threshold,
        cidHash: r.cidHash,
        evmAddress: r.evmAddress,
        nonce: r.nonce,
        signature: r.signature,
        eip712ChainId: r.eip712ChainId,
        eip712VerifyingContract: r.eip712VerifyingContract,
      })) as { ok: { attestation: AttestHoldingOk['attestation']; signature: Uint8Array | number[] } } | { err: Record<string, unknown> }
      if ('err' in out) return out
      return { ok: { attestation: out.ok.attestation, signature: new Uint8Array(out.ok.signature) } }
    },
  }
}
