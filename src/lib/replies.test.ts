/// <reference types="bun" />
import { describe, expect, test } from 'bun:test'
import { ack, checked, replyFor } from './replies'
import type { PrepareResult, PurgeResult } from '@/types/messages'

/**
 * The reply path is the one thing in this design that is defended rather than
 * conceded, so it is the one thing worth a regression test: every command the
 * page receives is forgeable by construction, and the only reason that is
 * tolerable is that a forged *reply* cannot get past these two rules.
 */

const ORIGIN = 'https://example.test'
const MALFORMED = { ok: false, error: 'The page sent a malformed reply.' } as const

/** Whatever the page felt like sending, typed only so the call compiles. */
const sent = (value: unknown) => value as PrepareResult & PurgeResult

describe('checked', () => {
  test('takes a blob URL belonging to this frame', () => {
    const real = { ok: true, url: `blob:${ORIGIN}/abc-123`, filename: 'clip.mp4' } as const
    expect(checked(real, ORIGIN)).toEqual(real)
  })

  test('takes `blob:null/…`, which is what an opaque origin mints', () => {
    const real = { ok: true, url: 'blob:null/abc-123', filename: 'clip.mp4' } as const
    expect(checked(real, 'null')).toEqual(real)
  })

  test('refuses a URL belonging to anywhere else', () => {
    // The whole point: this URL would be fetched with the extension's
    // privileges, not the page's.
    for (const url of [
      `blob:https://evil.test/abc`,
      `https://evil.test/abc`,
      `file:///etc/passwd`,
      `blob:${ORIGIN}.evil.test/abc`,
      // Right origin, wrong shape — the separator is what bounds the prefix.
      `blob:${ORIGIN}@evil.test/abc`,
      'data:text/html,x',
    ])
      expect(checked(sent({ ok: true, url, filename: 'clip.mp4' }), ORIGIN)).toEqual(MALFORMED)
  })

  test('refuses a success that is missing the parts that make it one', () => {
    expect(checked(sent({ ok: true, filename: 'clip.mp4' }), ORIGIN)).toEqual(MALFORMED)
    expect(checked(sent({ ok: true, url: `blob:${ORIGIN}/a` }), ORIGIN)).toEqual(MALFORMED)
    expect(checked(sent({ ok: true, url: 42, filename: 'clip.mp4' }), ORIGIN)).toEqual(MALFORMED)
  })

  test('passes a failure through only when it explains itself', () => {
    const failed: PrepareResult = { ok: false, error: 'The page revoked this URL.' }
    expect(checked(failed, ORIGIN)).toEqual(failed)
    expect(checked(sent({ ok: false }), ORIGIN)).toEqual(MALFORMED)
    expect(checked(sent({ ok: 'yes' }), ORIGIN)).toEqual(MALFORMED)
  })

  test('refuses anything that is not a reply at all', () => {
    for (const value of [null, undefined, 'ok', 7, []])
      expect(checked(sent(value), ORIGIN)).toEqual(MALFORMED)
  })
})

describe('ack', () => {
  test('keeps a success to a bare yes, dropping what was bolted on', () => {
    const result = ack(sent({ ok: true, url: `blob:${ORIGIN}/a`, filename: 'x', extra: 1 }))
    expect(result).toEqual({ ok: true })
    expect(Object.keys(result)).toEqual(['ok'])
  })

  test('keeps a failure to its reason', () => {
    expect(ack(sent({ ok: false, error: 'nope', extra: 1 }))).toEqual({ ok: false, error: 'nope' })
    expect(ack(sent({ ok: false }))).toEqual(MALFORMED)
  })

  test('refuses anything that is not a reply at all', () => {
    for (const value of [null, undefined, 'ok', 7]) expect(ack(sent(value))).toEqual(MALFORMED)
  })
})

describe('replyFor', () => {
  const prepared = {
    type: 'prepared',
    result: { ok: true, url: `blob:${ORIGIN}/a`, filename: 'clip.mp4' },
  } as const
  const purged = { type: 'purged', result: { ok: true } } as const

  test('settles a waiter with its own kind of reply', () => {
    expect(replyFor('prepared', prepared, ORIGIN)).toEqual(prepared.result)
    expect(replyFor('purged', purged, ORIGIN)).toEqual({ ok: true })
  })

  test('drops a reply of the wrong kind rather than settling with it', () => {
    // A `purged` settling a pending PREPARE would take the `ack` path and step
    // around `checked` entirely; a `prepared` settling a PURGE would report a
    // purge that never happened. Neither is this waiter's reply.
    expect(replyFor('prepared', purged, ORIGIN)).toBeNull()
    expect(replyFor('purged', prepared, ORIGIN)).toBeNull()
  })

  test('a forged reply of the right kind still has to pass the check', () => {
    const forged = {
      type: 'prepared',
      result: sent({ ok: true, url: 'blob:https://evil.test/a', filename: 'clip.mp4' }),
    } as const
    expect(replyFor('prepared', forged, ORIGIN)).toEqual(MALFORMED)
  })

  test('validates against the origin it is given, not one of its own', () => {
    const elsewhere: PurgeResult = { ok: true }
    expect(replyFor('purged', { type: 'purged', result: elsewhere }, 'https://other.test')).toEqual({
      ok: true,
    })
    expect(replyFor('prepared', prepared, 'https://other.test')).toEqual(MALFORMED)
  })
})
