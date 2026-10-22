import { describe, expect, it } from 'vitest'
import { getSealedCached } from '../src/lib/media'

describe('sealed byte cache', () => {
  it('starts empty so the first open fetches', () => {
    expect(getSealedCached('baga-piece')).toBeUndefined()
  })
})
