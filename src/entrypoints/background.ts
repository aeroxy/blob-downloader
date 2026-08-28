import type {
  FrameInventory,
  ListResult,
  PrepareResult,
  PurgeResult,
  Request,
  SaveResult,
} from '@/types/messages'

console.log(`[blobdl] service worker init — v${__VERSION__}, built ${__BUILD_TIME__}`)

/**
 * The aggregator.
 *
 * It holds no blobs and moves no bytes. Its whole job is that a page is not one
 * frame: blobs can be created in any of them, `chrome.tabs.sendMessage` without
 * a `frameId` reaches all of them but returns only the first reply, and the
 * popup needs the union. So each frame's bridge pushes its own inventory here,
 * keyed by `sender.frameId`, and the popup reads the aggregate.
 *
 * Kept in `chrome.storage.session` rather than a module-level Map, for the
 * reason `ig-voice-transcriber` keeps its clip URLs there: Chrome terminates an
 * idle service worker within seconds, and the inventory has to outlive that —
 * the blobs themselves are still sitting in the page. Session storage also
 * clears on browser restart, which is exactly the lifetime of a blob URL.
 */

const keyFor = (tabId: number) => `frames:${tabId}`

/**
 * Frames push independently and often; a read-modify-write per push would let
 * two frames of the same page each read the same array and the later write drop
 * the earlier frame entirely.
 */
let writes: Promise<unknown> = Promise.resolve()

async function read(tabId: number): Promise<FrameInventory[]> {
  const key = keyFor(tabId)
  const stored = await chrome.storage.session.get(key)
  return (stored[key] as FrameInventory[] | undefined) ?? []
}

/** The badge is the only reason the background knows anything; it is also the only reason to look. */
async function paintBadge(tabId: number, frames: FrameInventory[]): Promise<void> {
  const count = frames.reduce((total, frame) => total + frame.items.length, 0)
  await chrome.action.setBadgeText({ tabId, text: count > 0 ? String(count) : '' })
  await chrome.action.setBadgeBackgroundColor({ tabId, color: '#7c3aed' })
}

function put(tabId: number, frame: FrameInventory): Promise<void> {
  const write = writes.then(async () => {
    const frames = await read(tabId)
    const at = frames.findIndex((f) => f.frameId === frame.frameId)
    if (at === -1) frames.push(frame)
    else frames[at] = frame
    await chrome.storage.session.set({ [keyFor(tabId)]: frames })
    await paintBadge(tabId, frames)
  })
  // What the *queue* waits on is this write's outcome swallowed: chaining the
  // next write onto a rejection would skip it, so a single transient storage
  // failure would silence every inventory for the life of the worker. The
  // caller still gets the rejection, and still reports it.
  writes = write.catch(() => undefined)
  return write
}

/** A navigated-away or closed tab's blobs are gone with its document. */
async function forget(tabId: number): Promise<void> {
  await chrome.storage.session.remove(keyFor(tabId))
  await chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {})
}

/**
 * Ask the frame holding the bytes for a URL, then download it.
 *
 * The split matters. The page cannot do the download itself: a download it
 * starts without a user gesture trips Chrome's automatic-downloads block, which
 * lets the first file through and silently drops every one after it. And the
 * background cannot hold the bytes: `chrome.runtime` messaging is JSON, and a
 * service worker has no `URL.createObjectURL` to rebuild them with. So the page
 * keeps the bytes and lends out a URL, and `chrome.downloads` — which is exempt
 * from that block, and does resolve a page's own blob URL — fetches it.
 */
async function save(tabId: number, frameId: number, id: string): Promise<SaveResult> {
  let prepared: PrepareResult
  try {
    prepared = (await chrome.tabs.sendMessage(
      tabId,
      { type: 'PREPARE', id },
      { frameId },
    )) as PrepareResult
  } catch (e) {
    return { ok: false, error: `Could not reach the page: ${(e as Error).message}` }
  }
  if (!prepared.ok) return prepared

  try {
    // `uniquify` is the default conflict action, so saving the same clip twice
    // gives a numbered copy rather than an error or a silent overwrite.
    await chrome.downloads.download({ url: prepared.url, filename: prepared.filename })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: `Chrome refused the download: ${(e as Error).message}` }
  }
}

/** Drop a frame with nothing listening in it: its document is gone, so its blobs are too. */
function dropFrames(tabId: number, frameIds: number[]): Promise<void> {
  const write = writes.then(async () => {
    const frames = (await read(tabId)).filter((f) => !frameIds.includes(f.frameId))
    await chrome.storage.session.set({ [keyFor(tabId)]: frames })
    await paintBadge(tabId, frames)
  })
  writes = write.catch(() => undefined)
  return write
}

/**
 * Hand one item's memory back to the page.
 *
 * Nothing to do here afterwards: the frame's own inventory is the source of
 * truth, so the row and the badge correct themselves on the next PUSH.
 */
async function purge(tabId: number, frameId: number, id: string): Promise<PurgeResult> {
  try {
    return (await chrome.tabs.sendMessage(tabId, { type: 'PURGE', id }, { frameId })) as PurgeResult
  } catch (e) {
    return { ok: false, error: `Could not reach the page: ${(e as Error).message}` }
  }
}

/**
 * Nothing is listening in that frame, as opposed to the message failing to get
 * through.
 *
 * Measured against Chrome 151, which collapses every one of these into the same
 * sentence: a frame removed from the DOM, a frame id that never existed, and a
 * document our content scripts do not run in. The common ground is that no
 * bridge is there, and a frame that had one only loses it by navigating away —
 * so whatever rows we have for it describe a document that is gone.
 *
 * Every other rejection — a port closed mid-flight, an invalidated extension
 * context — means the bytes may well still be sitting in a frame we failed to
 * reach, and both dropping its rows and reporting success would be a lie.
 */
const NOTHING_LISTENING = /receiving end does not exist|could not establish connection/i

/**
 * The same for every frame of the tab.
 *
 * Fanned out here rather than by one frameless `sendMessage`, which reaches all
 * frames but returns only the first reply — with a button that claims to have
 * emptied the page, the frame that refused is the one thing worth knowing.
 */
async function purgeAll(tabId: number): Promise<PurgeResult> {
  const frames = await read(tabId)
  const gone: number[] = []
  const refused: string[] = []

  await Promise.all(
    frames.map(async (frame) => {
      let result: PurgeResult
      try {
        result = (await chrome.tabs.sendMessage(
          tabId,
          { type: 'PURGE_ALL' },
          { frameId: frame.frameId },
        )) as PurgeResult
      } catch (e) {
        const failure = (e as Error).message
        if (NOTHING_LISTENING.test(failure)) gone.push(frame.frameId)
        else refused.push(`frame ${frame.frameId}: ${failure}`)
        return
      }
      if (!result.ok) refused.push(result.error)
    }),
  )

  if (gone.length > 0) await dropFrames(tabId, gone)
  if (refused.length === 0) return { ok: true }
  return {
    ok: false,
    error: refused.length === 1 ? refused[0]! : `${refused.length} frames refused: ${refused[0]!}`,
  }
}

export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((message: Request, sender, sendResponse) => {
    if (message.type === 'PUSH') {
      const tabId = sender.tab?.id
      if (tabId === undefined) return false
      void put(tabId, {
        frameId: sender.frameId ?? 0,
        origin: message.origin,
        items: message.items,
      }).catch((e: unknown) => console.error('[blobdl] failed to store an inventory:', e))
      return false
    }

    if (message.type === 'LIST') {
      const { tabId } = message
      // Answer from storage at once, and separately nudge every frame to report
      // in. The fresh inventories arrive as their own PUSHes; the popup polls,
      // so it picks them up a moment later rather than waiting here for frames
      // that may not all answer.
      chrome.tabs
        .sendMessage(tabId, { type: 'REFRESH' })
        .catch(() => {}) // No content script on this page — chrome://, the Web Store, a PDF.
      read(tabId).then(
        (frames) => sendResponse({ frames } satisfies ListResult),
        () => sendResponse({ frames: [] } satisfies ListResult),
      )
      return true
    }

    if (message.type === 'SAVE') {
      save(message.tabId, message.frameId, message.id).then(sendResponse, (e: unknown) =>
        sendResponse({ ok: false, error: (e as Error).message } satisfies SaveResult),
      )
      return true
    }

    if (message.type === 'PURGE' || message.type === 'PURGE_ALL') {
      const done =
        message.type === 'PURGE'
          ? purge(message.tabId, message.frameId, message.id)
          : purgeAll(message.tabId)
      done.then(sendResponse, (e: unknown) =>
        sendResponse({ ok: false, error: (e as Error).message } satisfies PurgeResult),
      )
      return true
    }

    return false
  })

  chrome.tabs.onRemoved.addListener((tabId) => void forget(tabId))
  // A reload destroys every Blob the page held, so the inventory goes with it.
  // A same-document navigation does not, and does not fire this either.
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status === 'loading' && info.url) void forget(tabId)
  })
})
