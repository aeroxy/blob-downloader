import type {
  FrameInventory,
  ListResult,
  PrepareResult,
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
  writes = writes.then(async () => {
    const frames = await read(tabId)
    const at = frames.findIndex((f) => f.frameId === frame.frameId)
    if (at === -1) frames.push(frame)
    else frames[at] = frame
    await chrome.storage.session.set({ [keyFor(tabId)]: frames })
    await paintBadge(tabId, frames)
  })
  return writes.then(() => undefined)
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

    return false
  })

  chrome.tabs.onRemoved.addListener((tabId) => void forget(tabId))
  // A reload destroys every Blob the page held, so the inventory goes with it.
  // A same-document navigation does not, and does not fire this either.
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status === 'loading' && info.url) void forget(tabId)
  })
})
