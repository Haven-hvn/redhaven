import { describe, expect, it } from 'vitest'
import { AUTO_OPEN_MAX_BYTES, canAutoOpen, describeError } from '../src/lib/media'

describe('auto-open policy', () => {
  it('auto-opens small sealed media but not large files', () => {
    expect(canAutoOpen({ mime: 4, size: 1024, piece: 'baga' })).toBe(true)
    expect(canAutoOpen({ mime: 4, size: AUTO_OPEN_MAX_BYTES + 1, piece: 'baga' })).toBe(false)
    expect(canAutoOpen({ mime: 4, size: AUTO_OPEN_MAX_BYTES + 1, fcid: 'bafy' })).toBe(true)
  })
  it('names DOMExceptions with empty messages', () => {
    expect(describeError(new DOMException('', 'OperationError'))).toBe('OperationError')
  })
})
