import { describe, expect, it } from 'vitest'
import { compactNumber, inFuture, pluralize, shortAddress, timeAgo } from '../src/lib/format'
import { anchorId, commentsPath, frontpagePath, subredditPath, submitPath, userPath } from '../src/lib/paths'
import { pageSlice, parsePage } from '../src/lib/ranking'

describe('format', () => {
  it('timeAgo reads like reddit', () => {
    const now = 1_760_000_000
    expect(timeAgo(now, now)).toBe('just now')
    expect(timeAgo(now - 90, now)).toBe('1 minute ago')
    expect(timeAgo(now - 3 * 3600, now)).toBe('3 hours ago')
    expect(timeAgo(now - 2 * 86400, now)).toBe('2 days ago')
    expect(timeAgo(now - 40 * 86400, now)).toBe('1 month ago')
    expect(timeAgo(now - 400 * 86400, now)).toBe('1 year ago')
  })
  it('helpers', () => {
    expect(shortAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')).toBe('0x8335…2913')
    expect(pluralize(1, 'comment')).toBe('1 comment')
    expect(pluralize(2, 'reply', 'replies')).toBe('2 replies')
    expect(inFuture(90)).toBe('in 2 min')
    expect(inFuture(3 * 86400)).toBe('in 3 d')
    expect(compactNumber(12345)).toBe('12.3k')
  })
})

describe('paths use app terminology, never "board"', () => {
  it('builds routes', () => {
    expect(subredditPath('base.usdc')).toBe('/r/?s=base.usdc')
    expect(subredditPath('base.usdc', 'top', 2)).toBe('/r/?s=base.usdc&sort=top&p=2')
    expect(commentsPath('base.usdc', '0xabc')).toBe('/comments/?s=base.usdc&id=0xabc')
    expect(commentsPath('base.usdc', `0x${'1'.repeat(64)}`, `0x${'2'.repeat(64)}`)).toBe(`/comments/?s=base.usdc&id=0x${'1'.repeat(64)}#c22222222`)
    expect(submitPath('base.usdc')).toBe('/submit/?s=base.usdc')
    expect(submitPath()).toBe('/submit/')
    expect(userPath('0xABC')).toBe('/u/?a=0xabc')
    expect(frontpagePath()).toBe('/')
    expect(frontpagePath('new', 3)).toBe('/?sort=new&p=3')
    expect(anchorId(`0x${'f'.repeat(64)}`)).toBe('cffffffff')
    for (const p of [subredditPath('x.y'), commentsPath('x.y', '0x1'), submitPath('x.y'), userPath('0x1'), frontpagePath('top')]) expect(p).not.toMatch(/board/)
  })
})

describe('pagination', () => {
  it('slices 25 per page and clamps', () => {
    const items = Array.from({ length: 60 }, (_, i) => i)
    expect(pageSlice(items, 1).items).toHaveLength(25)
    expect(pageSlice(items, 3).items).toHaveLength(10)
    expect(pageSlice(items, 9).page).toBe(3)
    expect(pageSlice([], 1)).toEqual({ items: [], page: 1, pages: 1 })
    expect(parsePage('2')).toBe(2)
    expect(parsePage('x')).toBe(1)
    expect(parsePage(null)).toBe(1)
  })
})
