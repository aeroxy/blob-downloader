import {
  PAGE_COMMAND,
  PAGE_EVENT,
  type FrameRequest,
  type Item,
  type PageCommand,
  type PageEvent,
  type PrepareResult,
  type PurgeResult,
  type Request,
} from '@/types/messages'

/**
 * The pipe between the page world and the extension.
 *
 * It exists only because neither side can do the other's job: the hook has the
 * page's objects but no `chrome.*`, and this has `chrome.runtime` but cannot
 * see a single page object. So this forwards inventories up to the background
 * and save requests back down, and holds no state of its own beyond the
 * in-flight saves it is waiting on.
 */

/** Every request here is a click in the popup; if the page hasn't answered by now it isn't going to. */
const PREPARE_TIMEOUT_MS = 20_000

/**
 * A `prepared` reply, believed only as far as it can be checked.
 *
 * The hook shares its document with the page, so the page can dispatch
 * `blobdl:event` too — and a forged reply would travel from here to
 * `chrome.downloads`, which fetches with the extension's privileges rather than
 * the page's. The one thing the hook ever mints is a `blob:` URL for this
 * frame's own origin, so anything else is not a reply, whatever it claims.
 */
const MALFORMED = { ok: false, error: 'The page sent a malformed reply.' } as const

/** A bare done-or-why-not, kept to that shape and nothing the page bolted on. */
function ack(result: PurgeResult): PurgeResult {
  if (typeof result !== 'object' || result === null) return MALFORMED
  if (result.ok === true) return { ok: true }
  return typeof result.error === 'string' ? { ok: false, error: result.error } : MALFORMED
}

function checked(result: PrepareResult): PrepareResult {
  const malformed: PrepareResult = MALFORMED
  if (typeof result !== 'object' || result === null) return malformed
  if (result.ok !== true) {
    return result.ok === false && typeof result.error === 'string' ? result : malformed
  }
  if (typeof result.url !== 'string' || typeof result.filename !== 'string') return malformed
  // `blob:null/…` for an opaque origin, which is the form a sandboxed frame's
  // own URLs take too — it is still that frame and nothing else.
  return result.url.startsWith(`blob:${location.origin}/`) ? result : malformed
}

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  allFrames: true,

  main() {
    const pending = new Map<string, (result: PrepareResult | PurgeResult) => void>()
    let requests = 0

    const command = (message: PageCommand): void => {
      document.dispatchEvent(new CustomEvent(PAGE_COMMAND, { detail: JSON.stringify(message) }))
    }

    /**
     * Send one command to the page world and answer the background with the
     * page's reply. The timeout is the load-bearing part: without it the
     * popup's button sits disabled for ever when nothing answers, which is
     * exactly what an extension reloaded under a live page leaves behind — a
     * bridge with no hook on the other side.
     */
    const ask = (
      build: (requestId: string) => PageCommand,
      sendResponse: (result: PrepareResult | PurgeResult) => void,
      timedOut: PrepareResult | PurgeResult,
    ): void => {
      const requestId = `r${++requests}`
      pending.set(requestId, sendResponse)
      setTimeout(() => {
        if (!pending.delete(requestId)) return
        sendResponse(timedOut)
      }, PREPARE_TIMEOUT_MS)
      command(build(requestId))
    }

    const push = (items: Item[]): void => {
      // Fire and forget. A rejected send means the worker is being replaced or
      // the extension was reloaded under a live page — the next push covers it.
      void chrome.runtime
        .sendMessage({ type: 'PUSH', origin: location.origin, items } satisfies Request)
        .catch(() => {})
    }

    document.addEventListener(PAGE_EVENT, (event) => {
      let message: PageEvent
      try {
        message = JSON.parse((event as CustomEvent<string>).detail) as PageEvent
      } catch {
        return
      }

      if (message.type === 'inventory') {
        if (Array.isArray(message.items)) push(message.items)
        return
      }

      if (message.type !== 'prepared' && message.type !== 'purged') return
      if (typeof message.requestId !== 'string') return
      const settle = pending.get(message.requestId)
      if (!settle) return
      pending.delete(message.requestId)
      settle(message.type === 'prepared' ? checked(message.result) : ack(message.result))
    })

    chrome.runtime.onMessage.addListener((request: FrameRequest, _sender, sendResponse) => {
      if (request.type === 'REFRESH') {
        command({ type: 'refresh' })
        return false
      }

      if (request.type === 'PREPARE') {
        ask((requestId) => ({ type: 'prepare', requestId, id: request.id }), sendResponse, {
          ok: false,
          error: 'The page did not respond.',
        } satisfies PrepareResult)
        return true
      }

      if (request.type === 'PURGE' || request.type === 'PURGE_ALL') {
        const id = request.type === 'PURGE' ? request.id : null
        ask((requestId) => ({ type: 'purge', requestId, id }), sendResponse, {
          ok: false,
          error: 'The page did not respond.',
        } satisfies PurgeResult)
        return true
      }

      return false
    })

    // The hook is installed before this runs, so anything it found in the
    // meantime is already waiting to be asked for.
    command({ type: 'refresh' })
  },
})
