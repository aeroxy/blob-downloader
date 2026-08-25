/**
 * Naming a file for bytes that arrived without one.
 *
 * A blob URL carries no filename — that is rather the point of it — so the
 * name has to be constructed from the only two things the page told us: the
 * MIME type, and (for a `File`) whatever name it already had.
 */

/**
 * MIME → extension, for the types that actually turn up behind a blob URL.
 * Deliberately short: the fallback below handles the long tail, and a wrong
 * guess from a big table is worse than a plain one, because the extension is
 * what decides which application opens the file.
 */
const EXTENSIONS: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/ogg': 'ogv',
  'video/x-matroska': 'mkv',
  'video/mp2t': 'ts',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/webm': 'weba',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/flac': 'flac',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/json': 'json',
  'application/octet-stream': 'bin',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'text/html': 'html',
}

/** The type without its parameters: `video/mp4; codecs="avc1.4d401f"` → `video/mp4`. */
export function baseType(mime: string): string {
  return (mime.split(';')[0] ?? '').trim().toLowerCase()
}

/**
 * A file extension for a MIME type, without the dot.
 *
 * Unknown types fall back to the subtype's own last word — `image/x-foo` gives
 * `foo`, which is usually right and never misleading — and anything that
 * doesn't reduce to a plausible extension gives `bin`.
 */
export function extensionFor(mime: string): string {
  const base = baseType(mime)
  const known = EXTENSIONS[base]
  if (known) return known

  const subtype = base.split('/')[1] ?? ''
  const word = subtype
    .replace(/\+.*$/, '') // `svg+xml` → `svg`
    .split('.')
    .pop()!
    .replace(/^x-/, '')
    .replace(/[^a-z0-9]/g, '')
  return word.length >= 1 && word.length <= 8 ? word : 'bin'
}

/**
 * Anything the browser's download machinery would rather not be handed:
 * separators, control characters, and the leading dots that make a file
 * invisible. Chrome sanitises `a.download` itself, but it silently substitutes
 * — better to produce the name we intend than to find out what it chose.
 */
export function safeFilename(name: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim()
  return cleaned.slice(0, 120) || 'download'
}

/** A hostname reduced to a filename-safe stub: `www.example.co.uk` → `example`. */
export function hostLabel(hostname: string): string {
  const parts = hostname.replace(/^www\./, '').split('.')
  return safeFilename(parts[0] || 'page').toLowerCase()
}

export interface NameParts {
  hostname: string
  /** What this is, in one word: `blob`, `video`, `audio`. */
  label: string
  /** Disambiguates two of the same kind on one page. */
  id: string
  mime: string
  /** A `File`'s own name, when there was one. It wins if it already has an extension. */
  original?: string | null
}

/** `example-video-t3.mp4`, or the File's own name when it brought one. */
export function filenameFor({ hostname, label, id, mime, original }: NameParts): string {
  if (original) {
    const name = safeFilename(original)
    if (/\.[a-z0-9]{1,8}$/i.test(name)) return name
    return `${name}.${extensionFor(mime)}`
  }
  return `${hostLabel(hostname)}-${safeFilename(label)}-${safeFilename(id)}.${extensionFor(mime)}`
}

/** Sizes for humans. Binary units, because that is what a byte cap is expressed in. */
export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}
