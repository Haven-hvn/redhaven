/**
 * Chain variant table — ported from Haven-dapp `src/lib/gate-chains.ts`.
 * The canister records Haven-AOL variant names ("ethereum", "base", …);
 * entities store EIP-155 ids. Attestations and boards are compared
 * through this shared table.
 */

/** Map from EIP-155 chain id → Haven-AOL variant name. */
export const CHAIN_ID_VARIANTS = {
  1: 'ethereum',
  8453: 'base',
  59144: 'linea',
  2741: 'abstract',
}

/** Map from variant name → EIP-155 chain id. */
export const CHAIN_VARIANT_IDS = {
  ethereum: 1,
  base: 8453,
  linea: 59144,
  abstract: 2741,
}

/**
 * Resolve an EIP-155 chain id (number) to a Haven-AOL variant name.
 * Returns undefined when the chain is unknown.
 */
export function toChainVariant(chainId) {
  if (chainId === undefined || chainId === null) return undefined
  return CHAIN_ID_VARIANTS[Number(chainId)]
}

/** Human label for a variant name, e.g. "Base (8453)". */
export function chainLabel(variant) {
  const id = CHAIN_VARIANT_IDS[variant]
  if (id === undefined) return variant
  const pretty = variant === 'base' ? 'Base' : variant[0].toUpperCase() + variant.slice(1)
  return `${pretty} (${id})`
}
