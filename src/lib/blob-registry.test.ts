/// <reference types="bun" />
import { beforeEach, describe, expect, test } from 'bun:test'
import { install, inventory, purge, purgeAll, setCapturing, setLimits } from './blob-registry'
import { DEFAULT_LIMITS, type Limits } from './limits'

/**
 * The Blob half of the registry, which is the half that runs without a browser.
 *
 * `install()` patches `MediaSource` and `SourceBuffer` only when they exist, so
 * under bun it installs the two `URL` patches and stops — which is exactly the
 * surface these tests want. The MediaSource half stays with the manual harness
 * in `test/blob-test.html`: capturing a stream needs a real demuxer to append
 * into, and a fake SourceBuffer would only prove the fake works.
 *
 * Two globals are stubbed because building an inventory reads them: the
 * hostname that names a saved file, and the media elements a blob might be
 * playing in. Neither is what any of this is about.
 */
Object.assign(globalThis, {
  location: { hostname: 'example.test' },
  document: { querySelectorAll: () => [] },
})

const MB = 1024 * 1024
const budget = (retainedBytes: number): Limits => ({ ...DEFAULT_LIMITS, retainedBytes })
const blobOf = (bytes: number, type = 'application/octet-stream'): Blob =>
  new Blob([new Uint8Array(bytes)], { type })

/** The one row this test made. */
function only() {
  const items = inventory()
  expect(items).toHaveLength(1)
  return items[0]!
}

const sized = (bytes: number) => inventory().find((item) => item.size === bytes)!

beforeEach(() => {
  install()
  setCapturing(true)
  setLimits(DEFAULT_LIMITS)
  purgeAll()
})

describe('a real Blob', () => {
  test('a URL for it becomes a row, held against the page revoking', () => {
    URL.createObjectURL(blobOf(1024, 'image/png'))
    const item = only()
    expect(item.kind).toBe('blob')
    expect(item.size).toBe(1024)
    expect(item.retained).toBe(true)
    expect(item.revoked).toBe(false)
    expect(item.saveable).toBe(true)
  })

  test('two URLs for the same Blob are one row, not two', () => {
    const blob = blobOf(512)
    URL.createObjectURL(blob)
    URL.createObjectURL(blob)
    expect(inventory()).toHaveLength(1)
  })

  test('revoking the URL keeps the row, which is the whole point of holding it', () => {
    const url = URL.createObjectURL(blobOf(2048))
    URL.revokeObjectURL(url)
    const item = only()
    expect(item.revoked).toBe(true)
    expect(item.retained).toBe(true)
    expect(item.saveable).toBe(true)
    expect(item.note).toContain('URL revoked')
  })
})

describe('the retained-blob budget', () => {
  test('a blob past it is tracked but not held, and says so', () => {
    setLimits(budget(16 * MB))
    URL.createObjectURL(blobOf(20 * MB))
    const item = only()
    expect(item.retained).toBe(false)
    expect(item.concern).toBe(true)
    // Still saveable: nothing was retained, but the page's own URL is live.
    expect(item.saveable).toBe(true)
    expect(item.note).toContain('over the memory budget')
  })

  test('eviction gives up a live URL before the last handle on some bytes', () => {
    setLimits(budget(25 * MB))
    const revoked = URL.createObjectURL(blobOf(10 * MB))
    URL.revokeObjectURL(revoked)
    URL.createObjectURL(blobOf(11 * MB))
    URL.createObjectURL(blobOf(12 * MB))

    // Releasing the revoked one would lose its bytes for good; the live one can
    // still be re-read from the page.
    expect(sized(10 * MB).retained).toBe(true)
    expect(sized(11 * MB).retained).toBe(false)
    expect(sized(12 * MB).retained).toBe(true)
  })

  test('lowering it gives memory back at once, not on the next blob', () => {
    URL.createObjectURL(blobOf(20 * MB))
    expect(only().retained).toBe(true)
    setLimits(budget(16 * MB))
    expect(only().retained).toBe(false)
  })
})

describe('purge', () => {
  test('drops the row and the bytes behind it', () => {
    URL.createObjectURL(blobOf(1024))
    purge(only().id)
    expect(inventory()).toHaveLength(0)
  })

  test('an id that is no longer here says so rather than failing quietly', () => {
    expect(() => purge('b-nonexistent')).toThrow('no longer on the page')
  })

  test('purgeAll empties every row in one go', () => {
    for (let i = 0; i < 5; i++) URL.createObjectURL(blobOf(128 + i))
    expect(inventory()).toHaveLength(5)
    purgeAll()
    expect(inventory()).toHaveLength(0)
  })

  test('a purged Blob seen again starts a new row, not the old one over again', () => {
    // Only reachable through a released blob: `forget` unmaps a Blob it still
    // holds, but a released one left no key to unmap with, so the mapping
    // outlives the row and the next sighting has to notice it is stale.
    setLimits(budget(25 * MB))
    const evicted = blobOf(20 * MB)
    URL.createObjectURL(evicted)
    const first = sized(20 * MB).id
    URL.createObjectURL(blobOf(10 * MB)) // pushes the 20 MB one out of memory
    expect(sized(20 * MB).retained).toBe(false)

    purge(first)
    expect(inventory()).toHaveLength(1)

    URL.createObjectURL(evicted)
    expect(inventory()).toHaveLength(2)
    expect(sized(20 * MB).id).not.toBe(first)
  })
})

describe('setCapturing', () => {
  test('switching off hands back whatever landed before the policy arrived', () => {
    URL.createObjectURL(blobOf(1024))
    expect(inventory()).toHaveLength(1)
    setCapturing(false)
    expect(inventory()).toHaveLength(0)
  })

  test('and records nothing while it is off', () => {
    setCapturing(false)
    URL.createObjectURL(blobOf(1024))
    expect(inventory()).toHaveLength(0)
  })
})
