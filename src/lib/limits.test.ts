/// <reference types="bun" />
import { describe, expect, test } from 'bun:test'
import { BOUNDS, DEFAULT_LIMITS, fromMB, normalise, toMB } from './limits'

describe('normalise', () => {
  test('anything that is not a pair of numbers falls back to the defaults', () => {
    // Storage outlives the code that wrote it, and the page shares a document
    // with the hook — so this is the shape the caller allocates against.
    for (const stored of [undefined, null, {}, 'limits', 42, [], { trackBytes: '512' }]) {
      expect(normalise(stored)).toEqual(DEFAULT_LIMITS)
    }
  })

  test('a readable half survives a garbage other half', () => {
    expect(normalise({ trackBytes: fromMB(64), retainedBytes: null })).toEqual({
      trackBytes: fromMB(64),
      retainedBytes: DEFAULT_LIMITS.retainedBytes,
    })
  })

  test('non-finite numbers are not numbers for this purpose', () => {
    expect(normalise({ trackBytes: NaN, retainedBytes: Infinity })).toEqual(DEFAULT_LIMITS)
  })

  test('clamps to both ends rather than refusing', () => {
    expect(normalise({ trackBytes: 0, retainedBytes: 0 })).toEqual({
      trackBytes: BOUNDS.trackBytes.min,
      retainedBytes: BOUNDS.retainedBytes.min,
    })
    expect(normalise({ trackBytes: fromMB(99_999), retainedBytes: fromMB(99_999) })).toEqual({
      trackBytes: BOUNDS.trackBytes.max,
      retainedBytes: BOUNDS.retainedBytes.max,
    })
    expect(normalise({ trackBytes: -1, retainedBytes: -1 })).toEqual({
      trackBytes: BOUNDS.trackBytes.min,
      retainedBytes: BOUNDS.retainedBytes.min,
    })
  })

  test('a fraction of a MB is below the floor, which is the point of the floor', () => {
    // A cap under one segment stops a capture on its first append.
    expect(normalise({ trackBytes: fromMB(0.5), retainedBytes: fromMB(0.5) }).trackBytes).toBe(
      BOUNDS.trackBytes.min,
    )
  })

  test('a value already in range is left alone', () => {
    const stored = { trackBytes: fromMB(256), retainedBytes: fromMB(2048) }
    expect(normalise(stored)).toEqual(stored)
  })

  test('is idempotent, because both sides of the channel apply it', () => {
    const once = normalise({ trackBytes: 1, retainedBytes: fromMB(99_999) })
    expect(normalise(once)).toEqual(once)
  })
})

describe('toMB / fromMB', () => {
  test('round-trip the values the popup shows', () => {
    expect(toMB(DEFAULT_LIMITS.trackBytes)).toBe(512)
    expect(toMB(DEFAULT_LIMITS.retainedBytes)).toBe(1024)
    expect(fromMB(toMB(DEFAULT_LIMITS.trackBytes))).toBe(DEFAULT_LIMITS.trackBytes)
  })
})
