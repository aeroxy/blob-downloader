import {
  install,
  inventory,
  isRecording,
  onChange,
  prepare,
  purge,
  purgeAll,
  setLimits,
} from '@/lib/blob-registry'
import { normalise } from '@/lib/limits'
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
/** Page-global, because a re-injected copy of this module gets its own module state. */
const MARKER = '__blobdlInstalled__'

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
    // A second injection — a development reload, or an `executeScript` over the
    // declared script — re-evaluates this module with fresh state, so the
    // registry's own idempotence guard never sees the first one. Two of
    // everything below means every segment counted twice and two URLs minted
    // per save, so the marker has to live where both copies can see it. Not
    // enumerable: the patches are already discoverable by a page that looks, but
    // there is no reason to advertise.
    const world = globalThis as Record<string, unknown>
    if (world[MARKER]) return
    Object.defineProperty(world, MARKER, { value: true })

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

      if (command.type === 'limits') {
        // Normalised again on this side: the page shares this document and can
        // dispatch `blobdl:command` too, and a limit is a number this code then
        // allocates against.
        setLimits(normalise(command.limits))
        return
      }

      if (command.type === 'refresh') {
        // Unconditional: the bridge asks when the popup opens, and the throttle
        // above would otherwise answer a fresh popup with silence.
        lastSent = ''
        pushInventory()
        return
      }

      if (command.type === 'purge') {
        const { requestId, id } = command
        try {
          if (id === null) purgeAll()
          else purge(id)
          emit({ type: 'purged', requestId, result: { ok: true } })
        } catch (error) {
          emit({
            type: 'purged',
            requestId,
            result: { ok: false, error: error instanceof Error ? error.message : String(error) },
          })
        }
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
