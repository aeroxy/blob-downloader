import type { PrepareResult, PurgeResult } from '@/types/messages'

/**
 * What the bridge is allowed to believe of a reply from the page world.
 *
 * This is the one defended path in a design where the command channel is
 * forgeable by construction. The hook shares its document with the page, so the
 * page can dispatch `blobdl:event` as easily as the hook can, and it can read
 * the `requestId` it needs out of the command it is answering. Everything a
 * forged reply could do is bounded by what this module lets through:
 *
 * - a forged `prepared` would hand `chrome.downloads` a URL fetched with the
 *   extension's privileges rather than the page's, so the URL has to belong to
 *   the frame that is answering;
 * - a reply of the wrong type would settle a waiter that never asked for it —
 *   a `purged` taking the `ack` path around `checked()`, or a `prepared`
 *   reporting a purge that never happened — so the type has to match too.
 *
 * Kept here, apart from the content script, so those two rules can be tested
 * without a browser. `origin` is passed in rather than read from `location`
 * for the same reason.
 */

const MALFORMED = { ok: false, error: 'The page sent a malformed reply.' } as const

/** A bare done-or-why-not, kept to that shape and nothing the page bolted on. */
export function ack(result: PurgeResult): PurgeResult {
  if (typeof result !== 'object' || result === null) return MALFORMED
  if (result.ok === true) return { ok: true }
  return typeof result.error === 'string' ? { ok: false, error: result.error } : MALFORMED
}

/** A `prepared` reply, believed only as far as it can be checked. */
export function checked(result: PrepareResult, origin: string): PrepareResult {
  const malformed: PrepareResult = MALFORMED
  if (typeof result !== 'object' || result === null) return malformed
  if (result.ok !== true) {
    return result.ok === false && typeof result.error === 'string' ? result : malformed
  }
  if (typeof result.url !== 'string' || typeof result.filename !== 'string') return malformed
  // `blob:null/…` for an opaque origin, which is the form a sandboxed frame's
  // own URLs take too — it is still that frame and nothing else.
  return result.url.startsWith(`blob:${origin}/`) ? result : malformed
}

/**
 * The result a waiter expecting `expect` should be settled with, or `null` if
 * this reply is not its reply.
 *
 * `null` rather than a malformed result on a type mismatch, and the difference
 * matters: a mismatched reply leaves the waiter pending, so a forged one cannot
 * consume the slot the real answer is still coming back to.
 */
export function replyFor(
  expect: 'prepared' | 'purged',
  message: { type: 'prepared'; result: PrepareResult } | { type: 'purged'; result: PurgeResult },
  origin: string,
): PrepareResult | PurgeResult | null {
  if (message.type !== expect) return null
  return message.type === 'prepared' ? checked(message.result, origin) : ack(message.result)
}
