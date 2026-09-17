import { LIMITS_KEY, normalise } from '@/lib/limits'
import { POLICY_KEY } from '@/lib/policy'
import {
  PAGE_COMMAND,
  PAGE_EVENT,
  type FrameRequest,
  type Item,
  type PageCommand,
  type PageEvent,
  type PolicyResult,
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
    /**
     * What each in-flight request is waiting for, not just who to hand it to.
     *
     * The expected type is half the key. The page reads `requestId` out of the
     * `blobdl:command` event it shares a document with, so without it a forged
     * `purged` could settle a pending PREPARE — taking the `ack` branch and
     * stepping around `checked()` entirely — and a forged `prepared` could
     * report a purge that never happened as done. A reply of the wrong type is
     * not this request's reply, so it is dropped and the real one still fits.
     */
    const pending = new Map<
      string,
      { expect: 'prepared' | 'purged'; settle: (result: PrepareResult | PurgeResult) => void }
    >()
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
      expect: 'prepared' | 'purged',
      build: (requestId: string) => PageCommand,
      sendResponse: (result: PrepareResult | PurgeResult) => void,
      timedOut: PrepareResult | PurgeResult,
    ): void => {
      const requestId = `r${++requests}`
      pending.set(requestId, { expect, settle: sendResponse })
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
      const waiter = pending.get(message.requestId)
      if (!waiter || waiter.expect !== message.type) return
      pending.delete(message.requestId)
      waiter.settle(message.type === 'prepared' ? checked(message.result) : ack(message.result))
    })

    /**
     * Whether the policy covers this tab.
     *
     * Asked of the background rather than read from storage here, for the one
     * thing this frame cannot know: the policy matches the *tab's* host, and a
     * cross-origin subframe cannot see it. `sender.tab.url` can.
     *
     * A failure changes nothing — it is not an answer, so the frame is told
     * nothing and keeps the state it has. On a fresh frame that means covered,
     * because the registry captures until told otherwise: silently recording
     * nothing because the service worker was mid-restart would look exactly
     * like an extension that had stopped working, and the honest default is
     * the behaviour from before the setting existed. On a frame already told
     * to stop it means staying stopped, which is the half that matters — a
     * failed lookup must never be the thing that starts recording again.
     *
     * Either way it holds only until an answer arrives, which is why a
     * failure retries rather than settling. This runs at `document_start`, so
     * the worker it asks may still be starting; giving up there would leave the
     * frame capturing — and holding memory — on a site the user had excluded,
     * until the tab navigated. The popup is the backstop: it nudges every frame
     * on open, and a frame that never got an answer asks again then.
     *
     * Which is also why only the newest ask counts. Several can be in flight —
     * a retry still pending when a policy change lands, say — and they answer
     * in whatever order the worker gets to them. An older answer arriving last
     * would put the frame back on a site that had just been switched off, and
     * nothing would correct it until the policy changed again.
     */
    const POLICY_RETRY_MS = 1_000
    let policyKnown = false
    let policyAsk = 0

    /**
     * No answer, from either end: the worker never replied, or it replied that
     * it could not read the policy. Either way the frame keeps the capture
     * state it has — it is not told anything — and tries again.
     */
    const policyUnknown = (retry: boolean): void => {
      if (retry) {
        setTimeout(() => askPolicy(false), POLICY_RETRY_MS)
        return
      }
      // Out of tries. Marking it unknown is what lets the popup's next nudge
      // pick this up, rather than leaving the frame on a guess for the life of
      // the document — which is what a policy change we failed to hear is.
      policyKnown = false
    }

    const askPolicy = (retry = true): void => {
      const asked = ++policyAsk
      void chrome.runtime
        .sendMessage({ type: 'POLICY' } satisfies Request)
        .then((result: PolicyResult | undefined) => {
          if (asked !== policyAsk) return
          if (result?.capture == null) {
            policyUnknown(retry)
            return
          }
          policyKnown = true
          command({ type: 'capture', on: result.capture })
        })
        .catch(() => {
          // A newer ask is already on its way with the answer this one wanted.
          if (asked === policyAsk) policyUnknown(retry)
        })
    }

    chrome.runtime.onMessage.addListener((request: FrameRequest, _sender, sendResponse) => {
      if (request.type === 'REFRESH') {
        // Only when both asks failed: the popup polls, and a POLICY round trip
        // per tick per frame would be a lot of traffic to learn nothing.
        if (!policyKnown) askPolicy()
        command({ type: 'refresh' })
        return false
      }

      if (request.type === 'PREPARE') {
        ask(
          'prepared',
          (requestId) => ({ type: 'prepare', requestId, id: request.id }),
          sendResponse,
          { ok: false, error: 'The page did not respond.' } satisfies PrepareResult,
        )
        return true
      }

      if (request.type === 'PURGE' || request.type === 'PURGE_ALL') {
        const id = request.type === 'PURGE' ? request.id : null
        ask(
          'purged',
          (requestId) => ({ type: 'purge', requestId, id }),
          sendResponse,
          { ok: false, error: 'The page did not respond.' } satisfies PurgeResult,
        )
        return true
      }

      return false
    })

    /**
     * The memory ceilings live in `chrome.storage`, which the page world cannot
     * see, so they come through here: once at startup, and again whenever the
     * popup changes them — including for frames that were already capturing,
     * which is the only reason the setting is worth having on a page that is
     * already struggling.
     */
    const sendLimits = (stored: unknown): void => {
      command({ type: 'limits', limits: normalise(stored) })
    }

    void chrome.storage.local
      .get(LIMITS_KEY)
      .then((stored) => sendLimits(stored[LIMITS_KEY]))
      // Nothing readable means the defaults, which the hook is already using.
      .catch(() => {})

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return
      if (LIMITS_KEY in changes) sendLimits(changes[LIMITS_KEY]?.newValue)
      // Re-asked rather than recomputed from the new value: the decision needs
      // this tab's host, which is still only the background's to know.
      if (POLICY_KEY in changes) askPolicy()
    })

    askPolicy()

    // The hook is installed before this runs, so anything it found in the
    // meantime is already waiting to be asked for.
    command({ type: 'refresh' })
  },
})
