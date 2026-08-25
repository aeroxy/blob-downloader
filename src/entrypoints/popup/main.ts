import { humanSize } from '@/lib/format'
import type { FrameInventory, Item, ListResult, Request, SaveResult } from '@/types/messages'

/**
 * The list.
 *
 * It polls rather than subscribing. A stream's size changes every few hundred
 * milliseconds while it plays, so something has to refresh anyway, and a poll
 * costs one message a second for as long as a popup is open — which is seconds.
 * The alternative is a port plus an update broadcast, for the same result.
 */
const POLL_MS = 1000

const summary = document.getElementById('summary')!
const list = document.getElementById('list')!

/** Re-rendering under a click would replace the button mid-save — of which there can be more than one. */
let saving = 0
let lastRendered = ''

function empty(): HTMLElement {
  const div = document.createElement('div')
  div.className = 'empty'
  div.innerHTML = `
    <p>Nothing yet.</p>
    <p><strong>Files</strong> appear the moment the page makes a
       <code>blob:</code> URL — an export, a generated image, a decrypted
       attachment.</p>
    <p><strong>Streaming video</strong> has to be played to be captured: its
       bytes don't exist until the player asks for them. Start it from the
       beginning, and let it run.</p>
    <p>If the page was already open when this extension was installed or
       reloaded, reload the page — the capture has to be in place before the
       page's own scripts run.</p>
  `
  return div
}

function row(item: Item, frameId: number, tabId: number): HTMLElement {
  const el = document.createElement('div')
  el.className = 'row'

  const body = document.createElement('div')

  const name = document.createElement('div')
  name.className = 'name'
  name.textContent = item.filename
  name.title = item.filename

  const meta = document.createElement('div')
  meta.className = 'meta'
  const kind = document.createElement('span')
  kind.className = 'kind'
  kind.textContent = item.kind === 'stream' ? 'stream' : item.kind
  meta.append(kind, document.createTextNode(`${item.type || 'unknown type'} · ${humanSize(item.size)}`))

  body.append(name, meta)

  if (item.note) {
    const note = document.createElement('div')
    // `concern` is decided where the note is written, not sniffed out of the
    // prose here. A revoked URL whose bytes we still hold reads as a warning
    // and is the opposite of one.
    note.className = item.concern || !item.saveable ? 'note warn' : 'note'
    note.textContent = item.note
    body.append(note)
  }

  const button = document.createElement('button')
  button.textContent = 'Save'
  button.disabled = !item.saveable

  // One line for whatever went wrong, reused: a row that fails twice should say
  // why once, not stack a second copy under the first.
  let failure: HTMLElement | null = null
  const failed = (message: string): void => {
    if (failure === null) {
      failure = document.createElement('div')
      failure.className = 'note warn'
      body.append(failure)
    }
    failure.textContent = message
    button.disabled = false
    button.textContent = 'Retry'
  }

  button.addEventListener('click', async () => {
    saving++
    button.disabled = true
    button.textContent = 'Saving…'
    try {
      const result = (await chrome.runtime.sendMessage({
        type: 'SAVE',
        tabId,
        frameId,
        id: item.id,
      } satisfies Request)) as SaveResult
      if (result.ok) button.textContent = 'Saved'
      else failed(result.error)
    } catch (e) {
      failed(`Extension not reachable: ${(e as Error).message}`)
    } finally {
      saving--
    }
  })

  el.append(body, button)
  return el
}

function render(frames: FrameInventory[], tabId: number): void {
  const withItems = frames.filter((frame) => frame.items.length > 0)
  const total = withItems.reduce((n, frame) => n + frame.items.length, 0)
  const bytes = withItems.reduce(
    (n, frame) => n + frame.items.reduce((m, item) => m + item.size, 0),
    0,
  )

  summary.textContent =
    total === 0
      ? 'No blobs detected.'
      : `${total} item${total === 1 ? '' : 's'} · ${humanSize(bytes)} available`

  list.textContent = ''
  if (total === 0) {
    list.append(empty())
    return
  }

  for (const frame of withItems) {
    // Only worth naming when there is more than one source; on a single-frame
    // page the origin is just the address bar repeated.
    if (withItems.length > 1) {
      const heading = document.createElement('div')
      heading.className = 'origin'
      heading.textContent = frame.frameId === 0 ? frame.origin : `${frame.origin} (frame)`
      list.append(heading)
    }
    for (const item of frame.items) list.append(row(item, frame.frameId, tabId))
  }
}

async function main(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (tab?.id === undefined) {
    summary.textContent = 'No page here.'
    return
  }
  const tabId = tab.id

  const tick = async (): Promise<void> => {
    if (saving > 0) return
    let result: ListResult
    try {
      result = (await chrome.runtime.sendMessage({ type: 'LIST', tabId } satisfies Request)) as ListResult
    } catch {
      // The worker is starting up, or was replaced mid-call. Next tick.
      return
    }
    const key = JSON.stringify(result.frames)
    if (key === lastRendered) return
    lastRendered = key
    render(result.frames, tabId)
  }

  await tick()
  setInterval(() => void tick(), POLL_MS)
}

void main()
