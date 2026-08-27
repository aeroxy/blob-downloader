/**
 * How much of the page's memory this extension is allowed to hold.
 *
 * Both numbers are a trade rather than a safety rail: the retained `Blob` is
 * what makes a revoked URL recoverable, and the segment store is what makes a
 * stream saveable at all, so raising them buys longer captures and costs the
 * page exactly that much heap. They are settings because the right answer is a
 * property of the machine and the video, not of this code — 512 MB is about an
 * hour of 1080p, and nothing here can know whether that is the whole film.
 */
export interface Limits {
  /** Per SourceBuffer track. Overshoot is dropped from the end; see `segment-store.ts`. */
  trackBytes: number
  /** Total retained Blobs in one frame. Past it, blobs are tracked but not held. */
  retainedBytes: number
}

const MB = 1024 * 1024

export const DEFAULT_LIMITS: Limits = { trackBytes: 512 * MB, retainedBytes: 1024 * MB }

/**
 * The floor is not a formality: a cap below one segment would stop a capture on
 * its first append, and the row would report a truncation the user could not
 * explain. The ceilings are the point past which the tab is the thing at risk.
 */
export const BOUNDS = {
  trackBytes: { min: 16 * MB, max: 8192 * MB },
  retainedBytes: { min: 16 * MB, max: 8192 * MB },
} as const

/** Where the popup writes them and every frame's bridge reads them. */
export const LIMITS_KEY = 'limits'

const clamp = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback

/**
 * Anything at all into a usable pair.
 *
 * Storage outlives the code that wrote it — an older version's shape, a
 * half-written value, a key that has never been set — and the caller is a
 * capture that has already started, so there is no useful way to fail here.
 */
export function normalise(stored: unknown): Limits {
  const raw = (stored ?? {}) as Partial<Limits>
  return {
    trackBytes: clamp(
      raw.trackBytes,
      DEFAULT_LIMITS.trackBytes,
      BOUNDS.trackBytes.min,
      BOUNDS.trackBytes.max,
    ),
    retainedBytes: clamp(
      raw.retainedBytes,
      DEFAULT_LIMITS.retainedBytes,
      BOUNDS.retainedBytes.min,
      BOUNDS.retainedBytes.max,
    ),
  }
}

export const toMB = (bytes: number): number => Math.round(bytes / MB)
export const fromMB = (mb: number): number => Math.round(mb * MB)
