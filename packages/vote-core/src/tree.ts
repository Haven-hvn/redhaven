/**
 * Nested comment tree over Fairhaven replies: `parent_ref` names the parent
 * reply, absent means a direct answer to the OP. Pure; sorting is injected.
 */

import type { Rankable } from './rank.ts'

export interface TreeInput extends Rankable {
  rootRef: string
  parentRef?: string
}

export interface CommentNode<T extends TreeInput = TreeInput> {
  item: T
  depth: number
  children: CommentNode<T>[]
  /** Total descendants (for "load N more" / collapse labels). */
  descendants: number
}

export interface CommentTree<T extends TreeInput = TreeInput> {
  roots: CommentNode<T>[]
  /** Replies whose parent was not found (expired or hidden parent): shown under the OP. */
  orphans: number
}

export function buildTree<T extends TreeInput>(rootKey: string, replies: readonly T[], compare: (a: T, b: T) => number): CommentTree<T> {
  const root = rootKey.toLowerCase()
  const byKey = new Map<string, CommentNode<T>>()
  for (const r of replies) {
    if (r.rootRef.toLowerCase() !== root) continue
    byKey.set(r.key.toLowerCase(), { item: r, depth: 0, children: [], descendants: 0 })
  }
  const roots: CommentNode<T>[] = []
  let orphans = 0
  for (const node of byKey.values()) {
    const p = node.item.parentRef?.toLowerCase()
    if (!p || p === root) {
      roots.push(node)
      continue
    }
    const parent = byKey.get(p)
    if (!parent || parent === node) {
      orphans++
      roots.push(node)
      continue
    }
    parent.children.push(node)
  }
  // Break any accidental cycle (A→B→A) by dropping back-edges to an ancestor.
  const visiting = new Set<string>()
  const settle = (n: CommentNode<T>, depth: number): number => {
    const k = n.item.key.toLowerCase()
    if (visiting.has(k)) return 0
    visiting.add(k)
    n.depth = depth
    n.children = n.children.filter((c) => !visiting.has(c.item.key.toLowerCase()))
    n.children.sort((a, b) => compare(a.item, b.item))
    let d = 0
    for (const c of n.children) d += 1 + settle(c, depth + 1)
    n.descendants = d
    visiting.delete(k)
    return d
  }
  for (const r of roots) settle(r, 0)
  roots.sort((a, b) => compare(a.item, b.item))
  return { roots, orphans }
}

/** Depth-first flatten for virtualized rendering or tests. */
export function flatten<T extends TreeInput>(tree: CommentTree<T>): CommentNode<T>[] {
  const out: CommentNode<T>[] = []
  const walk = (n: CommentNode<T>) => {
    out.push(n)
    for (const c of n.children) walk(c)
  }
  for (const r of tree.roots) walk(r)
  return out
}
