import { describe, expect, it } from 'vitest'
import type { RawEntity } from '@fairhaven/board-core'
import { isBoardRow, keyTouchesSubmission, openSubmissionOf, rowsIncludeDef, rowsTouchSubmission } from '../src/lib/watch'

/**
 * Regression: the chain-wide entity watch fetched payloads for every Arkiv
 * event (~1/s on Tiramisu, almost none of them board posts) and then
 * reloaded `['submission']` / `['subreddits']` unconditionally — dozens of
 * charged queries a minute for changes no open view depended on. Only a
 * fetched subreddit definition may reload the directory, and only a row
 * touching the open submission may reload it.
 */
const keyA = `0x${'a'.repeat(64)}`
const keyB = `0x${'b'.repeat(64)}`
const foreignKey = `0x${'f'.repeat(64)}`

function row(key: string, grp: string, rootRef?: string): RawEntity {
  return { key, owner: `0x${'1'.repeat(40)}`, createdAt: 1, attributes: { grp, ...(rootRef ? { root_ref: rootRef } : {}) } }
}

const open = [openSubmissionOf({ root: { key: keyA }, replies: [{ key: keyB }] })!]

describe('watch relevance', () => {
  it('recognises board rows and ignores foreign entities', () => {
    expect(isBoardRow(row(keyA, 'haven.board.thread'))).toBe(true)
    expect(isBoardRow(row(keyA, 'haven.board.def'))).toBe(true)
    expect(isBoardRow(row(keyA, 'haven.video.full'))).toBe(true)
    expect(isBoardRow(row(foreignKey, 'haven.storage.file'))).toBe(false)
    expect(isBoardRow({ key: foreignKey, owner: `0x${'1'.repeat(40)}`, createdAt: 1, attributes: {} })).toBe(false)
  })

  it('reloads the subreddit directory only for a fetched definition', () => {
    expect(rowsIncludeDef([row(foreignKey, 'haven.storage.file'), row(keyA, 'haven.board.thread')])).toBe(false)
    expect(rowsIncludeDef([row(keyA, 'haven.board.def')])).toBe(true)
  })

  it('reloads the open submission only for its root, replies, or new replies to it', () => {
    expect(rowsTouchSubmission([row(keyA, 'haven.board.thread')], open)).toBe(true)
    expect(rowsTouchSubmission([row(keyB, 'haven.board.post', keyA)], open)).toBe(true)
    // A brand-new comment on the open submission is not a cached key yet.
    expect(rowsTouchSubmission([row(foreignKey, 'haven.board.post', keyA)], open)).toBe(true)
    expect(rowsTouchSubmission([row(foreignKey, 'haven.board.post', keyB)], open)).toBe(false)
    expect(rowsTouchSubmission([row(foreignKey, 'haven.board.thread')], open)).toBe(false)
    expect(keyTouchesSubmission(keyB, open)).toBe(true)
    expect(keyTouchesSubmission(foreignKey, open)).toBe(false)
  })

  it('touches nothing when no submission is open', () => {
    expect(rowsTouchSubmission([row(keyA, 'haven.board.thread')], [])).toBe(false)
    expect(openSubmissionOf(null)).toBeUndefined()
    expect(openSubmissionOf(undefined)).toBeUndefined()
  })
})
