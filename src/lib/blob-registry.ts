import { baseType, filenameFor } from '@/lib/format'
import { DEFAULT_LIMITS, type Limits } from '@/lib/limits'
import { SegmentStore } from '@/lib/segment-store'
import type { Item } from '@/types/messages'

/**
 * The page's blobs, from inside the page.
 *
 * This module runs in the MAIN world, and it has to: a `Blob` created by the
 * page exists only in the page's own JavaScript world, and a `blob:` URL is
 * scoped to the origin that made it. An isolated-world content script sees the
 * URL string and nothing behind it.
 *
 * There are exactly two ways bytes hide behind a `blob:` URL, and they need
 * opposite treatment:
 *
 * 1. **A real Blob.** `URL.createObjectURL(blob)`. The bytes are complete the
 *    moment the URL exists, and they can be re-read at any time — as long as
 *    something still holds the Blob. Pages routinely revoke the URL on the next
 *    line, which is correct hygiene and destroys the only handle to the data,
 *    so this keeps its own reference.
 *
 * 2. **A MediaSource.** `URL.createObjectURL(mediaSource)` produces a URL that
 *    looks identical and behaves nothing alike: there is no Blob, `fetch()`
 *    fails, and the data does not exist yet. It arrives later, in pieces, as
 *    the player appends it. Every streaming video works this way, which is why
 *    "download this blob URL" so often fails. The only way in is to copy each
 *    segment as it is appended — see `src/lib/segment-store.ts`.
 *
 * Everything is patched on the prototype at `document_start`, before page
 * scripts run, because a page that grabs `URL.createObjectURL` into a local
 * before we arrive would be invisible to us afterwards.
 */

/** Above this, the oldest rows are dropped — a page that mints an object URL per video frame otherwise grows without limit. */
const MAX_ITEMS = 300

/**
 * How much memory we may hold, until the popup says otherwise.
 *
 * The retained-Blob budget is the more generous of the two: those are handles
 * into the browser's blob store rather than the JS heap, and Chrome spills
 * large ones to disk. Past it, new blobs are tracked but not retained — still
 * saveable while their URL is live, lost once the page revokes it. The row says
 * which, rather than failing at click time.
 *
 * Defaults until the frame's bridge reads the stored settings, a moment after
 * `document_start`. Only the ceiling is affected, so the handful of appends
 * that can land in between are unaffected either way.
 */
let limits: Limits = DEFAULT_LIMITS

/* Captured before anything else can touch them. */
const nativeCreateObjectURL = URL.createObjectURL.bind(URL)
const nativeRevokeObjectURL = URL.revokeObjectURL.bind(URL)

interface BlobEntry {
  id: string
  kind: 'blob' | 'file'
  /** Object URLs still live for this Blob. A page may mint several; empty means fully revoked. */
  liveUrls: Set<string>
  /** Our own reference, so a revoke doesn't take the bytes with it. Null when over budget. */
  blob: Blob | null
  type: string
  size: number
  /** A `File`'s own name — the one case where the page hands us a real filename. */
  original: string | null
  createdAt: number
}

interface TrackEntry {
  id: string
  mime: string
  store: SegmentStore
  createdAt: number
  /**
   * We saw this SourceBuffer created, so we have its first append — the
   * initialisation segment, without which nothing later can be decoded. False
   * means we arrived mid-stream and the file will probably not play.
   */
  sawInit: boolean
  ended: boolean
  /** Removed by the user: no longer listed, and appends are ignored from here on. */
  dropped: boolean
  stream: StreamEntry | null
}

interface StreamEntry {
  id: string
  /** Object URLs pointing at this MediaSource, for matching it to its `<video>`. */
  urls: Set<string>
  source: MediaSource
  tracks: TrackEntry[]
}

/** The authoritative list, by id — what the popup enumerates and what `save` resolves against. */
const blobEntries = new Map<string, BlobEntry>()
/** url → entry, so a revoke can find its entry. */
const blobsByUrl = new Map<string, BlobEntry>()
/** So re-minting a URL for the same Blob updates a row instead of adding one. */
const blobsByObject = new WeakMap<Blob, BlobEntry>()

const tracks = new Map<string, TrackEntry>()
const trackBySourceBuffer = new WeakMap<SourceBuffer, TrackEntry>()
const streamBySource = new WeakMap<MediaSource, StreamEntry>()

let counter = 0
let retainedBytes = 0
let notify: () => void = () => {}

const nextId = (prefix: string) => `${prefix}${++counter}`

/** Called on every change, so the hook can push a fresh inventory. */
export function onChange(fn: () => void): void {
  notify = fn
}

/**
 * Move the memory ceilings, on a page that is already capturing.
 *
 * Applied to what is already here, not just to what arrives next — a limit you
 * have just lowered because the tab is struggling would be no use if it waited
 * for the next blob. Lowering the blob budget evicts down to it at once
 * (live URLs first, as ever); lowering a track's cap keeps the segments already
 * captured, since those are a valid file, and admits nothing more.
 */
export function setLimits(next: Limits): void {
  limits = next
  for (const track of tracks.values()) track.store.setMax(next.trackBytes)
  if (retainedBytes > next.retainedBytes) evict(0)
  notify()
}

/* ---------- real Blobs ---------- */

function release(entry: BlobEntry): void {
  if (entry.blob === null) return
  retainedBytes -= entry.blob.size
  entry.blob = null
}

/**
 * Make room by releasing the references that cost least to lose.
 *
 * An entry with a live URL can still be re-read through that URL, so releasing
 * it only risks the page revoking later. An entry whose URLs are all revoked is
 * held up by our reference alone — release that and the bytes are gone for
 * good. So live URLs are given up first, oldest first within each group.
 */
function evict(needed: number): void {
  const candidates = [...blobEntries.values()]
    .filter((e) => e.blob !== null)
    .sort(
      (a, b) =>
        (a.liveUrls.size > 0 ? 0 : 1) - (b.liveUrls.size > 0 ? 0 : 1) || a.createdAt - b.createdAt,
    )

  for (const entry of candidates) {
    if (retainedBytes + needed <= limits.retainedBytes) return
    release(entry)
  }
}

function retain(entry: BlobEntry, blob: Blob): void {
  if (retainedBytes + blob.size > limits.retainedBytes) evict(blob.size)
  if (retainedBytes + blob.size > limits.retainedBytes) return
  entry.blob = blob
  retainedBytes += blob.size
}

function forget(entry: BlobEntry): void {
  // Before `release`, which drops the only key we have for this. A mapping left
  // pointing at a dead entry would make the next `noteBlob` for the same Blob
  // update a row the popup no longer lists, instead of starting a live one.
  if (entry.blob !== null) blobsByObject.delete(entry.blob)
  release(entry)
  for (const url of entry.liveUrls) blobsByUrl.delete(url)
  blobEntries.delete(entry.id)
}

/** Keep the list to a length a human can read, dropping the oldest. */
function trim(): void {
  if (blobEntries.size <= MAX_ITEMS) return
  const oldestFirst = [...blobEntries.values()].sort((a, b) => a.createdAt - b.createdAt)
  for (const entry of oldestFirst) {
    if (blobEntries.size <= MAX_ITEMS) return
    forget(entry)
  }
}

function noteBlob(url: string, blob: Blob): void {
  const existing = blobsByObject.get(blob)
  // A hit on an entry `trim()` already dropped is stale — for a released Blob
  // there was no key left to unmap with — so it starts again as a new row.
  if (existing && blobEntries.has(existing.id)) {
    existing.liveUrls.add(url)
    blobsByUrl.set(url, existing)
    notify()
    return
  }

  const isFile = typeof File !== 'undefined' && blob instanceof File
  const entry: BlobEntry = {
    id: nextId('b'),
    kind: isFile ? 'file' : 'blob',
    liveUrls: new Set([url]),
    blob: null,
    type: blob.type || 'application/octet-stream',
    size: blob.size,
    original: isFile ? (blob as File).name || null : null,
    createdAt: Date.now(),
  }
  retain(entry, blob)
  blobEntries.set(entry.id, entry)
  blobsByUrl.set(url, entry)
  blobsByObject.set(blob, entry)
  trim()
  notify()
}

function noteRevoke(url: string): void {
  const entry = blobsByUrl.get(url)
  if (!entry) return
  blobsByUrl.delete(url)
  entry.liveUrls.delete(url)
  // Our reference is the whole point — a row survives its URL being revoked, so
  // that bytes the page has already thrown away can still be saved. With no
  // reference and no live URL there is nothing left to offer, so the row goes.
  if (entry.liveUrls.size === 0 && entry.blob === null) forget(entry)
  notify()
}

/* ---------- MediaSource streams ---------- */

function streamFor(source: MediaSource): StreamEntry {
  const existing = streamBySource.get(source)
  if (existing) return existing
  const entry: StreamEntry = { id: nextId('s'), urls: new Set(), source, tracks: [] }
  streamBySource.set(source, entry)
  return entry
}

function noteSourceBuffer(source: MediaSource, buffer: SourceBuffer, mime: string): void {
  const stream = streamFor(source)
  const entry: TrackEntry = {
    id: nextId('t'),
    mime,
    store: new SegmentStore(limits.trackBytes),
    createdAt: Date.now(),
    sawInit: true,
    ended: false,
    dropped: false,
    stream,
  }
  stream.tracks.push(entry)
  tracks.set(entry.id, entry)
  trackBySourceBuffer.set(buffer, entry)
  notify()
}

/**
 * An append on a SourceBuffer we never saw created. Patching the prototype
 * catches these — the patch applies to objects that already exist — but the
 * opening segment went past before we were installed, so the row says so.
 */
function adoptSourceBuffer(buffer: SourceBuffer, mime: string): TrackEntry {
  const entry: TrackEntry = {
    id: nextId('t'),
    mime,
    store: new SegmentStore(limits.trackBytes),
    createdAt: Date.now(),
    sawInit: false,
    ended: false,
    dropped: false,
    stream: null,
  }
  tracks.set(entry.id, entry)
  trackBySourceBuffer.set(buffer, entry)
  notify()
  return entry
}

function noteAppend(buffer: SourceBuffer, data: ArrayBuffer | ArrayBufferView): void {
  const entry =
    trackBySourceBuffer.get(buffer) ??
    adoptSourceBuffer(buffer, (buffer as SourceBuffer & { mimeType?: string }).mimeType ?? '')
  // A deleted track keeps its mapping so the next append doesn't get adopted as
  // a brand-new row that starts growing again — deleting has to actually stop
  // the memory going up.
  if (entry.dropped) return
  const first = entry.store.count === 0
  entry.store.append(data)
  // A playing video appends every few hundred milliseconds, so announcing each
  // one would be a message storm for the length of the film. The first is worth
  // it — that is what turns "detected" into "saveable"; growth after that is
  // picked up by the hook's own poll.
  if (first) notify()
}

/* ---------- what the popup sees ---------- */

/**
 * Which element on the page is using a given blob URL.
 *
 * Built once per inventory rather than once per row: the naive form is a
 * `querySelectorAll` per item, and a page holding a few hundred object URLs
 * would then walk the whole DOM a few hundred times every time the popup asked
 * what it had.
 */
interface UsageIndex {
  byUrl: Map<string, string>
  /** `srcObject` holds the MediaSource itself, so these match by identity, not by string. */
  bySource: { source: unknown; label: string }[]
}

const USAGE_SELECTOR = 'video,audio,img,source,iframe,embed,object,a'

function describe(el: Element): string {
  const tag = `<${el.tagName.toLowerCase()}>`
  if (el instanceof HTMLVideoElement && el.videoWidth > 0) {
    return `${tag} ${el.videoWidth}×${el.videoHeight}`
  }
  return tag
}

function indexUsage(): UsageIndex {
  const byUrl = new Map<string, string>()
  const bySource: { source: unknown; label: string }[] = []

  for (const el of document.querySelectorAll(USAGE_SELECTOR)) {
    const label = describe(el)
    const media = el as HTMLMediaElement
    const candidates = [
      media.currentSrc,
      el.getAttribute('src'),
      el.getAttribute('href'),
      el.getAttribute('data'),
    ]
    for (const candidate of candidates) {
      if (candidate?.startsWith('blob:') && !byUrl.has(candidate)) byUrl.set(candidate, label)
    }
    // `video.srcObject = mediaSource` is the modern spelling and skips
    // `createObjectURL` entirely, so a stream can have no URL at all.
    const provider = media.srcObject as unknown
    if (provider) bySource.push({ source: provider, label })
  }
  return { byUrl, bySource }
}

function labelFor(index: UsageIndex, urls: Set<string>, source: MediaSource | null): string {
  for (const url of urls) {
    const hit = index.byUrl.get(url)
    if (hit) return hit
  }
  if (source !== null) {
    for (const entry of index.bySource) if (entry.source === (source as unknown)) return entry.label
  }
  return ''
}

function blobName(entry: BlobEntry): string {
  return filenameFor({
    hostname: location.hostname,
    label: 'blob',
    id: entry.id,
    mime: entry.type,
    original: entry.original,
  })
}

function blobItem(entry: BlobEntry, index: UsageIndex): Item {
  const revoked = entry.liveUrls.size === 0
  const notes = [labelFor(index, entry.liveUrls, null)]
  const unretained = entry.blob === null
  if (revoked) notes.push('URL revoked; saving from our own reference')
  else if (unretained) {
    notes.push('over the memory budget, not retained — save it before the page revokes the URL')
  }

  return {
    id: entry.id,
    kind: entry.kind,
    type: entry.type,
    size: entry.size,
    filename: blobName(entry),
    note: notes.filter(Boolean).join(' · '),
    concern: unretained,
    saveable: entry.blob !== null || !revoked,
    truncated: false,
    retained: entry.blob !== null,
    revoked,
    createdAt: entry.createdAt,
  }
}

function trackName(entry: TrackEntry): string {
  return filenameFor({
    hostname: location.hostname,
    label: baseType(entry.mime).startsWith('audio') ? 'audio' : 'video',
    id: entry.id,
    mime: entry.mime,
  })
}

function trackItem(entry: TrackEntry, index: UsageIndex): Item {
  const siblings = entry.stream?.tracks.length ?? 1
  const notes = [labelFor(index, entry.stream?.urls ?? new Set(), entry.stream?.source ?? null)]

  if (!entry.sawInit) notes.push('capture began mid-stream — the file may not play')
  if (siblings > 1) {
    const which = (entry.stream?.tracks.indexOf(entry) ?? 0) + 1
    notes.push(`track ${which} of ${siblings} — separate files, mux them with ffmpeg`)
  }
  if (entry.store.size === 0) {
    // Nothing at all, for one of two reasons that need opposite responses. The
    // cap is a setting now, so "press play" would be advice that cannot work.
    notes.push(
      entry.store.truncated
        ? 'the first segment was larger than the size cap — raise it and reload the page'
        : 'nothing captured yet — press play',
    )
  } else {
    if (entry.store.truncated) notes.push('hit the size cap; the file ends early')
    notes.push(entry.ended ? 'stream ended' : 'still recording as it plays')
  }

  return {
    id: entry.id,
    kind: 'stream',
    type: entry.mime,
    size: entry.store.size,
    filename: trackName(entry),
    note: notes.filter(Boolean).join(' · '),
    concern: !entry.sawInit || entry.store.truncated || entry.store.size === 0,
    saveable: entry.store.size > 0,
    truncated: entry.store.truncated,
    retained: entry.store.size > 0,
    revoked: false,
    createdAt: entry.createdAt,
  }
}

/** Everything this frame is holding, oldest first. */
export function inventory(): Item[] {
  const index = indexUsage()
  return [...blobEntries.values()]
    .map((entry) => blobItem(entry, index))
    .concat([...tracks.values()].map((entry) => trackItem(entry, index)))
    .sort((a, b) => a.createdAt - b.createdAt)
}

/**
 * A stream is taking on bytes right now.
 *
 * The hook polls for growth — a playing video's size changes constantly and we
 * deliberately don't announce every segment — and this is what keeps that poll
 * from doing any work on the overwhelming majority of pages, which have no
 * MediaSource at all.
 */
export function isRecording(): boolean {
  for (const track of tracks.values()) {
    if (!track.ended && track.store.size > 0) return true
  }
  return false
}

/* ---------- giving the memory back ---------- */

/**
 * Drop one item and the bytes behind it.
 *
 * Everything this extension can save, it is holding in the page's own
 * memory — a retained `Blob` the page has already forgotten, up to half a
 * gigabyte of segments per stream track — so there has to be a way to hand it
 * back short of reloading.
 *
 * A removed track keeps its `trackBySourceBuffer` mapping and is marked
 * `dropped` rather than forgotten: forgetting it would have the next
 * `appendBuffer` adopt it as a brand-new row and start climbing again, which is
 * the opposite of what was asked for.
 */
export function purge(id: string): void {
  const track = tracks.get(id)
  if (track) {
    track.store.clear()
    track.dropped = true
    tracks.delete(id)
    // Left in `stream.tracks` on purpose: the stream still has the tracks it
    // has, and renumbering the survivor to "1 of 1" would claim otherwise.
    notify()
    return
  }

  const entry = blobEntries.get(id)
  if (!entry) throw new Error('That item is no longer on the page.')
  forget(entry)
  notify()
}

/** The same for everything this frame holds — one button for a page full of rows. */
export function purgeAll(): void {
  for (const entry of [...blobEntries.values()]) forget(entry)
  for (const track of [...tracks.values()]) {
    track.store.clear()
    track.dropped = true
  }
  tracks.clear()
  notify()
}

/* ---------- handing bytes to the downloader ---------- */

/**
 * How long a minted URL is left alive.
 *
 * `chrome.downloads` resolves the URL when the download starts, and the bytes
 * are local, so a download from a blob URL is essentially a copy — seconds even
 * for a large video. Five minutes is far longer than that and costs nothing:
 * the Blob it points at is one we are deliberately holding anyway.
 */
const URL_LIFETIME_MS = 5 * 60 * 1000

/**
 * A URL for the bytes, for the background to hand to `chrome.downloads`.
 *
 * The obvious approach — click an `<a download>` right here, where the bytes
 * already are — was tried first and is wrong, for a reason that only shows up
 * on the second file: a download the page starts without a user gesture trips
 * Chrome's automatic-downloads block, so the first save works, the rest are
 * silently dropped, and the popup has no way to tell. Measured: five saves, one
 * file on disk, and no error anywhere.
 *
 * `chrome.downloads` is exempt from that check, and it accepts a `blob:` URL
 * belonging to the *page* — verified, not assumed. So the bytes never move: the
 * page mints a URL, the background downloads it. That also buys the proper
 * filename and an entry in Chrome's download manager.
 */
export async function prepare(id: string): Promise<{ url: string; filename: string }> {
  const track = tracks.get(id)
  if (track) {
    if (track.store.size === 0) {
      throw new Error('Nothing captured yet. Play the video, then try again.')
    }
    return mint(track.store.assemble(baseType(track.mime)), trackName(track))
  }

  const entry = blobEntries.get(id)
  if (!entry) throw new Error('That blob is no longer on the page. Reopen the popup.')

  let blob = entry.blob
  if (!blob) {
    const url = [...entry.liveUrls][0]
    if (!url) throw new Error('The page revoked this URL and the bytes were not retained.')
    // Same world that minted the URL, so this resolves — where a content script
    // or the service worker would get an opaque failure. It can still lose a
    // race with the page's own revoke, and then the bare `TypeError` says
    // nothing; the reason is always the same one.
    try {
      blob = await (await fetch(url)).blob()
    } catch {
      throw new Error('The page revoked this URL while it was being read.')
    }
  }
  return mint(blob, blobName(entry))
}

/**
 * A fresh URL rather than the page's own, even when the page still has one
 * live: the page may revoke it at any moment, including between this call and
 * the download starting.
 */
function mint(blob: Blob, filename: string): { url: string; filename: string } {
  const url = nativeCreateObjectURL(blob)
  setTimeout(() => nativeRevokeObjectURL(url), URL_LIFETIME_MS)
  return { url, filename }
}

/* ---------- the patches ---------- */

/**
 * Idempotent: a page can be injected into twice (a development reload, or a
 * frame that re-runs content scripts), and patching a patch would double-count
 * every segment.
 */
let installed = false

export function install(): void {
  if (installed) return
  installed = true

  const NativeMediaSource = typeof MediaSource === 'undefined' ? null : MediaSource

  URL.createObjectURL = function createObjectURL(object: Blob | MediaSource): string {
    const url = nativeCreateObjectURL(object as Blob)
    try {
      if (NativeMediaSource !== null && object instanceof NativeMediaSource) {
        // A URL for a MediaSource: no bytes behind it, and nothing to record
        // until the player appends. This only links the stream to its URL, so
        // the row can name the element playing it.
        streamFor(object).urls.add(url)
        notify()
      } else if (object instanceof Blob) {
        noteBlob(url, object)
      }
    } catch {
      // Never let our bookkeeping break the page's own call.
    }
    return url
  }

  URL.revokeObjectURL = function revokeObjectURL(url: string): void {
    try {
      noteRevoke(url)
    } catch {
      /* as above */
    }
    nativeRevokeObjectURL(url)
  }

  if (NativeMediaSource === null || typeof SourceBuffer === 'undefined') return

  const nativeAddSourceBuffer = NativeMediaSource.prototype.addSourceBuffer
  NativeMediaSource.prototype.addSourceBuffer = function addSourceBuffer(
    this: MediaSource,
    mime: string,
  ): SourceBuffer {
    const buffer = nativeAddSourceBuffer.call(this, mime)
    try {
      noteSourceBuffer(this, buffer, mime)
    } catch {
      /* as above */
    }
    return buffer
  }

  const nativeEndOfStream = NativeMediaSource.prototype.endOfStream
  NativeMediaSource.prototype.endOfStream = function endOfStream(
    this: MediaSource,
    reason?: EndOfStreamError,
  ): void {
    try {
      const stream = streamBySource.get(this)
      if (stream) {
        for (const track of stream.tracks) track.ended = true
        notify()
      }
    } catch {
      /* as above */
    }
    return nativeEndOfStream.call(this, reason)
  }

  const nativeAppendBuffer = SourceBuffer.prototype.appendBuffer
  SourceBuffer.prototype.appendBuffer = function appendBuffer(
    this: SourceBuffer,
    data: ArrayBuffer | ArrayBufferView,
  ): void {
    // The page's own call first: an append the browser refuses outright — a
    // SourceBuffer mid-update, a MediaSource already closed — never reaches the
    // file, so recording it would put a segment in the store that no player
    // ever saw.
    nativeAppendBuffer.call(this, data as BufferSource)
    try {
      noteAppend(this, data)
    } catch {
      /* as above */
    }
  }
}
