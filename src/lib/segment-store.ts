/**
 * The bytes a MediaSource player appends, kept so they can be written out.
 *
 * A `blob:` URL made from a MediaSource is not a Blob and cannot be fetched —
 * there is nothing behind it but a JavaScript object the page feeds by hand.
 * So the only way to obtain a streaming video is to copy each segment as it
 * goes past, in `SourceBuffer.appendBuffer`.
 *
 * Two things about the result, both of which the popup has to admit to:
 *
 * - **Append order, not timeline order.** Segments are stored in the order the
 *   player asked for them. Watched from the start that is the timeline; seek
 *   backwards and forwards and it is not, and the file will stutter or refuse
 *   to play. The fix is a fresh page and a straight play-through.
 * - **The first segment matters most.** For fragmented MP4 and WebM the
 *   opening append is the initialisation segment — the moov/EBML header that
 *   makes every later fragment interpretable. Miss it and no player can read
 *   the file, however many megabytes follow. This is why the hook runs at
 *   `document_start`.
 */

/**
 * Per-track ceiling. A 4K stream can run to gigabytes, and every byte here is
 * held in the page's own heap where it competes with the page. Half a gigabyte
 * is roughly an hour of 1080p and still leaves the tab usable.
 *
 * Overshoot is discarded from the *end*, never the start: a truncated file that
 * begins with its init segment plays up to the cut, whereas one missing its
 * header plays nowhere.
 */
export const DEFAULT_MAX_BYTES = 512 * 1024 * 1024

export class SegmentStore {
  private readonly chunks: Uint8Array[] = []
  private bytes = 0
  private droppedBytes = 0
  /** Sticky once the cap is hit; see `append`. */
  private stopped = false

  constructor(private readonly maxBytes: number = DEFAULT_MAX_BYTES) {}

  /** Bytes retained, which is what the saved file will weigh. */
  get size(): number {
    return this.bytes
  }

  /** Bytes refused after the cap. Non-zero means the file stops early. */
  get dropped(): number {
    return this.droppedBytes
  }

  get truncated(): boolean {
    return this.droppedBytes > 0
  }

  get count(): number {
    return this.chunks.length
  }

  /**
   * Copy one appended segment.
   *
   * The copy is not optional: players reuse a single scratch buffer for every
   * fetch, so keeping the caller's view would leave us holding whichever
   * segment happened to be last.
   */
  append(data: ArrayBuffer | ArrayBufferView): void {
    const view =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)

    if (view.byteLength === 0) return
    // The first segment that doesn't fit ends the capture for good, rather than
    // being skipped so a smaller later one can take its place. What is kept has
    // to be a contiguous prefix: a file cut short plays up to the cut, whereas
    // one with a hole in the middle hands the decoder fragments at timestamps it
    // has no header for. Not "ran out of room" — deliberately stopped.
    if (this.stopped || this.bytes + view.byteLength > this.maxBytes) {
      this.stopped = true
      this.droppedBytes += view.byteLength
      return
    }

    this.chunks.push(new Uint8Array(view))
    this.bytes += view.byteLength
  }

  /** One file out of every segment, in append order. */
  assemble(type: string): Blob {
    return new Blob(this.chunks as BlobPart[], { type })
  }

  /** Release the bytes; used when a stream's page navigates away under us. */
  clear(): void {
    this.chunks.length = 0
    this.bytes = 0
    this.droppedBytes = 0
    this.stopped = false
  }
}
