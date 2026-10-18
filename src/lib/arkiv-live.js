/**
 * LIVE Arkiv data source — real on-chain reads via the Arkiv SDK.
 *
 * Implements the Fairhaven entity contract query cookbook exactly:
 * - Boards:      grp = str('haven.board.def')
 * - Thread roots: AND(grp = str('haven.board.thread'), board = str('<slug>'))
 * - Replies:     AND(grp = str('haven.board.post'), board = str('<slug>'))
 * - One thread:   getEntity(root_ref) with payload
 *
 * Built as a separate lazily-imported bundle so the demo core stays small.
 */

import { createPublicClient } from '@arkiv-network/sdk'
import { tiramisu } from '@arkiv-network/sdk/chains'
import { eq, and } from '@arkiv-network/sdk/query'
import { http } from 'viem'

/** Attribute value → plain JS value. Values arrive as {type, value}. */
function attr(attributes, name) {
  const v = attributes?.[name]
  if (v === undefined || v === null) return undefined
  if (typeof v === 'object' && 'value' in v) {
    if (typeof v.value === 'bigint') return Number(v.value) <= Number.MAX_SAFE_INTEGER ? Number(v.value) : v.value.toString()
    return v.value
  }
  return v
}

export function createLiveSource(config = {}) {
  const chain = config.chain || tiramisu
  const client = createPublicClient({
    chain,
    transport: http(config.rpcUrl || undefined),
  })

  async function fetchEntities(grp, extra, selection) {
    const where = extra ? and(eq('grp', grp), ...extra) : eq('grp', grp)
    const result = await client
      .select(selection)
      .where(where)
      .limit(100)
      .fetch()
    const out = []
    for await (const e of result.entities || []) out.push(e)
    return out
  }

  return {
    isDemo: false,
    chain,

    async listBoards() {
      const rows = await fetchEntities('haven.board.def', null, {
        key: true, owner: true, createdAt: true, attributes: true, payload: true,
      })
      // First writer wins on duplicate slugs (lowest createdAt).
      const bySlug = new Map()
      for (const e of rows) {
        const slug = attr(e.attributes, 'board')
        if (!slug) continue
        const existing = bySlug.get(slug)
        if (existing && e.createdAt >= existing.createdAt) continue
        let about = ''
        try { about = e.toJson()?.about || '' } catch { /* payload absent or not JSON */ }
        bySlug.set(slug, {
          slug,
          title: attr(e.attributes, 'title') || slug,
          gate: {
            tokenAddress: String(attr(e.attributes, 'gate_token') || ''),
            gate_chain: Number(attr(e.attributes, 'gate_chain') || 0),
            gate_threshold: Number(attr(e.attributes, 'gate_threshold') || 0),
          },
          gateType: attr(e.attributes, 'gate_type'),
          description: about,
          entityKey: e.key,
          createdAtBlock: e.createdAt ? Number(e.createdAt) : undefined,
          subscribers: undefined,
        })
      }
      return Array.from(bySlug.values())
    },

    async getBoard(slug) {
      const boards = await this.listBoards()
      return boards.find((b) => b.slug === slug) || null
    },

    async listThreads(slug) {
      const rows = await fetchEntities('haven.board.thread', [eq('board', slug)], {
        key: true, owner: true, createdAt: true, attributes: true,
      })
      return rows.map((e) => ({
        id: e.key,
        title: attr(e.attributes, 'subject') || '(no subject)',
        domain: null,
        submitter: e.owner,
        createdAtBlock: e.createdAt ? Number(e.createdAt) : 0,
        createdAt: 0, // block-time unknown without extra RPC calls; tagline shows block
        sealed: Number(attr(e.attributes, 'sealed') || 0),
        comments: [], // filled by listPosts
      }))
    },

    /**
     * Threads for a gate with no board def (implicit boards): Haven media
     * records in the five haven.*.full groups whose gate matches exactly.
     */
    async listThreadsForGate(gate) {
      const groups = ['haven.video.full', 'haven.audio.full', 'haven.image.full', 'haven.text.full', 'haven.file.full']
      const rows = []
      for (const g of groups) {
        try {
          rows.push(...await fetchEntities(g, [
            eq('gate_token', gate.tokenAddress),
            eq('gate_chain', gate.gate_chain),
          ], { key: true, owner: true, createdAt: true, attributes: true }))
        } catch { /* group unreadable — skip */ }
      }
      return rows
        .filter((e) => Number(attr(e.attributes, 'gate_threshold')) === Number(gate.gate_threshold))
        .map((e) => ({
          id: e.key,
          title: attr(e.attributes, 'title') || attr(e.attributes, 'subject') || '(untitled media)',
          domain: null,
          submitter: e.owner,
          createdAtBlock: e.createdAt ? Number(e.createdAt) : 0,
          createdAt: 0,
          sealed: 0,
          comments: [],
        }))
    },

    async listPosts(slug) {
      const rows = await fetchEntities('haven.board.post', [eq('board', slug)], {
        key: true, owner: true, createdAt: true, attributes: true, payload: true,
      })
      return rows.map((e) => {
        let body = null
        let sealed = false
        try {
          const json = e.toJson()
          const text = json?.text
          if (text?.sealed) { body = null; sealed = true }
          else if (text?.clear) body = text.clear
          else body = typeof text === 'string' ? text : null
        } catch { /* unreadable payload */ }
        return {
          id: e.key,
          author: e.owner,
          body,
          sealed,
          rootRef: attr(e.attributes, 'root_ref'),
          parentRef: attr(e.attributes, 'parent_ref'),
          createdAtBlock: e.createdAt ? Number(e.createdAt) : 0,
          createdAt: 0,
        }
      })
    },

    /** Full thread OP payload (text clear or sealed marker). */
    async getThreadPayload(entityKey) {
      try {
        const e = await client.getEntity(entityKey)
        const json = e.toJson()
        const text = json?.text
        if (text?.sealed) return { body: null, sealed: true, media: json?.media || null }
        return { body: text?.clear || json?.subject || null, sealed: false, media: json?.media || null }
      } catch {
        return { body: null, sealed: false, media: null }
      }
    },
  }
}
