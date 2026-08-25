import { install, inventory, isRecording, onChange, prepare } from '@/lib/blob-registry'
import { PAGE_COMMAND, PAGE_EVENT, type PageCommand, type PageEvent } from '@/types/messages'

/**
 * The page-world half.
 *
 * It runs in the MAIN world at `document_start`, which is the only arrangement
 * that works: the patches have to be in place before the page's own scripts
 * take a reference to `URL.createObjectURL`, and they have to be in the page's
 * world because that is where its Blobs and SourceBuffers exist.
 *
 * The price is that `chrome.*` is not available here at all, so everything
 * reaches the extension through `src/entrypoints/bridge.content.ts` over
 * CustomEvents whose `detail` is always a JSON string — no dependence on how a
 * given browser clones objects between worlds.
 */

/** Changes arrive in bursts (a gallery minting twenty URLs at once); one message covers the burst. */
const PUSH_THROTTLE_MS = 500
/**
 * A playing stream grows continuously and deliberately doesn't announce every
 * segment, so its size is polled instead. `isRecording()` makes this free on
 * the pages — nearly all of them — that have no MediaSource.
 */
const GROWTH_POLL_MS = 2000

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  allFrames: true,
  world: 'MAIN',
  // Anonymous IIFE and no `postMessage` announcement: this shares a global
  // scope with the page, and the point is to be invisible to it.
  globalName: false,
  noScriptStartedPostMessage: true,

  main() {
    install()

    const emit = (event: PageEvent): void => {
      document.dispatchEvent(new CustomEvent(PAGE_EVENT, { detail: JSON.stringify(event) }))
    }

    let lastSent = ''
    /** Skips the push when nothing a human would notice has changed. */
    const pushInventory = (): void => {
      const items = inventory()
      const serialised = JSON.stringify(items)
      if (serialised === lastSent) return
      lastSent = serialised
      emit({ type: 'inventory', items })
    }

    let queued = 0
    onChange(() => {
      clearTimeout(queued)
      queued = window.setTimeout(pushInventory, PUSH_THROTTLE_MS)
    })

    setInterval(() => {
      if (isRecording()) pushInventory()
    }, GROWTH_POLL_MS)

    document.addEventListener(PAGE_COMMAND, (event) => {
      const detail = (event as CustomEvent<string>).detail
      let command: PageCommand
      try {
        command = JSON.parse(detail) as PageCommand
      } catch {
        return
      }

      if (command.type === 'refresh') {
        // Unconditional: the bridge asks when the popup opens, and the throttle
        // above would otherwise answer a fresh popup with silence.
        lastSent = ''
        pushInventory()
        return
      }

      if (command.type === 'prepare') {
        const { requestId } = command
        prepare(command.id).then(
          ({ url, filename }) =>
            emit({ type: 'prepared', requestId, result: { ok: true, url, filename } }),
          (error: unknown) =>
            emit({
              type: 'prepared',
              requestId,
              result: {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              },
            }),
        )
      }
    })
  },
})
