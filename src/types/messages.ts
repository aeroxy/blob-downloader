/**
 * Message protocol.
 *
 *   page (MAIN world)  ⇄  bridge (ISOLATED world)   CustomEvent, JSON strings
 *   bridge             →  background                PUSH
 *   popup              ⇄  background                LIST, SAVE
 *
 * Two hops, because the two halves can each only do half the job: the hook
 * lives in the page's own world, which is the only place a page-created `Blob`
 * or `SourceBuffer` exists, and has no `chrome.*` at all. The bridge has
 * `chrome.runtime` but cannot see a single page object.
 */

export type Kind =
  /** `URL.createObjectURL(blob)` — a real Blob, its bytes already complete. */
  | 'blob'
  /** The same, but the argument was a `File`, so it came with a name. */
  | 'file'
  /** One `SourceBuffer` of a MediaSource, accumulated as the player appends. */
  | 'stream'

/** One saveable thing, as the popup shows it. Never carries bytes. */
export interface Item {
  /** Stable for the lifetime of the page; the handle `SAVE` names. */
  id: string
  kind: Kind
  /** The MIME type the page declared, `codecs=…` and all. */
  type: string
  /** Bytes we can hand over right now. For a playing stream this grows. */
  size: number
  /** What the saved file will be called. */
  filename: string
  /** The one-line qualification under the row: which element, which track, or why it can't be saved. */
  note: string
  /**
   * The note reports something that affects whether the saved file is usable —
   * a mid-stream start, a truncation, nothing captured yet. Decided here rather
   * than by the popup reading the prose, because this is where the meaning is.
   * A revoked URL we still hold the bytes for is *not* a concern: it is the
   * feature working.
   */
  concern: boolean
  /** False when the bytes are gone — a revoked URL we never got to retain. */
  saveable: boolean
  /** We hit the per-item byte cap and stopped recording. The file is a prefix of the real one. */
  truncated: boolean
  /**
   * We are holding these bytes in the page's memory right now. False for a blob
   * we only reach through the page's own live URL, which costs us nothing, and
   * for a stream that hasn't been played yet. This is what the header totals:
   * what removing things would actually give back.
   */
  retained: boolean
  /** The page called `revokeObjectURL`. Still saveable if we hold the Blob. */
  revoked: boolean
  createdAt: number
}

/* ---------- page ⇄ bridge ---------- */

/**
 * Event names, and why events rather than `window.postMessage`: pages listen
 * for `message` and some break on shapes they don't expect — the reason WXT
 * grew `noScriptStartedPostMessage`. `detail` is always a JSON string, so
 * nothing depends on how a given browser clones objects between worlds.
 */
export const PAGE_EVENT = 'blobdl:event'
export const PAGE_COMMAND = 'blobdl:command'

export type PageEvent =
  | { type: 'inventory'; items: Item[] }
  | { type: 'prepared'; requestId: string; result: PrepareResult }
  | { type: 'purged'; requestId: string; result: PurgeResult }

export type PageCommand =
  | { type: 'prepare'; requestId: string; id: string }
  /** `id: null` means everything this frame holds. */
  | { type: 'purge'; requestId: string; id: string | null }
  /** The bridge starts after the hook, so it asks once rather than waiting for the next blob. */
  | { type: 'refresh' }

/* ---------- bridge / popup ⇄ background ---------- */

/** One frame's worth of inventory. A page's blobs can be in any of its frames. */
export interface FrameInventory {
  frameId: number
  /** `location.origin` as the frame sees it, so the popup can label cross-origin frames. */
  origin: string
  items: Item[]
}

/** Sent *to* the background: by a frame's bridge, or by the popup. */
export type Request =
  /** bridge → background, on every change. The background only aggregates. */
  | { type: 'PUSH'; origin: string; items: Item[] }
  | { type: 'LIST'; tabId: number }
  | { type: 'SAVE'; tabId: number; frameId: number; id: string }
  | { type: 'PURGE'; tabId: number; frameId: number; id: string }
  /** Everything, in every frame of the tab. The background fans it out. */
  | { type: 'PURGE_ALL'; tabId: number }

/**
 * Sent *to* one frame's bridge by the background. Separate from `Request`
 * because the two travel in opposite directions and share a `SAVE`: the
 * background's carries a tab and frame to route to, a frame's carries only the
 * id, since it has arrived.
 */
export type FrameRequest =
  /** Report in now — the popup has just opened and the push throttle would otherwise answer with silence. */
  | { type: 'REFRESH' }
  /** Mint a URL for this item's bytes. The frame answers with a `PrepareResult`. */
  | { type: 'PREPARE'; id: string }
  /** Drop one item and the bytes behind it. The frame answers with a `PurgeResult`. */
  | { type: 'PURGE'; id: string }
  /** The same for everything this frame holds. */
  | { type: 'PURGE_ALL' }

/**
 * What the page hands over: a fresh `blob:` URL for the bytes, and the name to
 * save them under. Not the bytes themselves — `chrome.runtime` messaging is
 * JSON, so a video would have to cross as base64, and `chrome.downloads`
 * resolves a page's own blob URL perfectly well without any of that.
 */
export type PrepareResult =
  | { ok: true; url: string; filename: string }
  | { ok: false; error: string }

export type ListResult = { frames: FrameInventory[] }

/** Done, or the one line explaining why not. */
export type Ack = { ok: true } | { ok: false; error: string }
export type SaveResult = Ack

export type PurgeResult = Ack
