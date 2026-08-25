/// <reference types="bun" />
import { describe, expect, test } from 'bun:test'
import { SegmentStore } from './segment-store'

const bytes = (...values: number[]) => new Uint8Array(values)

async function read(blob: Blob): Promise<number[]> {
  return [...new Uint8Array(await blob.arrayBuffer())]
}

describe('SegmentStore', () => {
  test('assembles segments in append order', async () => {
    const store = new SegmentStore()
    store.append(bytes(1, 2))
    store.append(bytes(3))
    expect(store.size).toBe(3)
    expect(store.count).toBe(2)
    expect(await read(store.assemble('video/mp4'))).toEqual([1, 2, 3])
    expect(store.assemble('video/mp4').type).toBe('video/mp4')
  })

  test('copies, because players reuse one scratch buffer for every fetch', async () => {
    const store = new SegmentStore()
    const scratch = bytes(1, 2, 3)
    store.append(scratch)
    scratch.set([9, 9, 9])
    expect(await read(store.assemble('video/mp4'))).toEqual([1, 2, 3])
  })

  test('accepts a view into a larger buffer without swallowing the whole buffer', async () => {
    const store = new SegmentStore()
    const backing = new Uint8Array([0, 0, 7, 8, 0, 0])
    store.append(new Uint8Array(backing.buffer, 2, 2))
    expect(store.size).toBe(2)
    expect(await read(store.assemble(''))).toEqual([7, 8])
  })

  test('accepts a bare ArrayBuffer', async () => {
    const store = new SegmentStore()
    store.append(bytes(4, 5).buffer)
    expect(await read(store.assemble(''))).toEqual([4, 5])
  })

  test('drops overshoot from the end, keeping the init segment that makes the file readable', async () => {
    const store = new SegmentStore(4)
    store.append(bytes(1, 2, 3))
    store.append(bytes(4, 5)) // would exceed the cap
    store.append(bytes(6)) // still fits
    expect(store.truncated).toBe(true)
    expect(store.dropped).toBe(2)
    expect(await read(store.assemble(''))).toEqual([1, 2, 3, 6])
  })

  test('an empty append is not a segment', () => {
    const store = new SegmentStore()
    store.append(new Uint8Array(0))
    expect(store.count).toBe(0)
    expect(store.truncated).toBe(false)
  })

  test('clear releases everything', () => {
    const store = new SegmentStore(2)
    store.append(bytes(1, 2, 3))
    store.clear()
    expect(store.size).toBe(0)
    expect(store.count).toBe(0)
    expect(store.truncated).toBe(false)
  })
})
