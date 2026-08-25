import {
  PAGE_COMMAND,
  PAGE_EVENT,
  type FrameRequest,
  type Item,
  type PageCommand,
  type PageEvent,
  type PrepareResult,
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

/** A prepare is a click in the popup; if the page hasn't answered by now it isn't going to. */
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
function checked(result: PrepareResult): PrepareResult {
  const malformed: PrepareResult = { ok: false, error: 'The page sent a malformed reply.' }
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
    const pending = new Map<string, (result: PrepareResult) => void>()
    let requests = 0

    const command = (message: PageCommand): void => {
      document.dispatchEvent(new CustomEvent(PAGE_COMMAND, { detail: JSON.stringify(message) }))
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

      if (message.type !== 'prepared' || typeof message.requestId !== 'string') return
      const settle = pending.get(message.requestId)
      if (!settle) return
      pending.delete(message.requestId)
      settle(checked(message.result))
    })

    chrome.runtime.onMessage.addListener((request: FrameRequest, _sender, sendResponse) => {
      if (request.type === 'REFRESH') {
        command({ type: 'refresh' })
        return false
      }

      if (request.type === 'PREPARE') {
        const requestId = `r${++requests}`
        pending.set(requestId, sendResponse)
        // Without this the popup's button would sit disabled for ever if the
        // page world never answered — an extension reloaded under a live page
        // leaves a bridge with no hook on the other side.
        setTimeout(() => {
          if (!pending.delete(requestId)) return
          sendResponse({ ok: false, error: 'The page did not respond.' } satisfies PrepareResult)
        }, PREPARE_TIMEOUT_MS)
        command({ type: 'prepare', requestId, id: request.id })
        return true
      }

      return false
    })

    // The hook is installed before this runs, so anything it found in the
    // meantime is already waiting to be asked for.
    command({ type: 'refresh' })
  },
})
