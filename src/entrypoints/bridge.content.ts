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
        push(message.items)
        return
      }

      const settle = pending.get(message.requestId)
      if (!settle) return
      pending.delete(message.requestId)
      settle(message.result)
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
