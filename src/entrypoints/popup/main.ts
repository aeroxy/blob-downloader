import { humanSize } from '@/lib/format'
import { BOUNDS, LIMITS_KEY, fromMB, normalise, toMB } from '@/lib/limits'
import {
  allows,
  capture,
  hostOf,
  listKey,
  normaliseHost,
  normalisePolicy,
  POLICY_KEY,
  remove as removeRule,
  toggle as toggleRule,
  type Policy,
  type Site,
} from '@/lib/policy'
import type {
  FrameInventory,
  Item,
  ListResult,
  PurgeResult,
  Request,
  SaveResult,
} from '@/types/messages'

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
const trouble = document.getElementById('trouble')!
const list = document.getElementById('list')!
const clearAll = document.getElementById('clear-all') as HTMLButtonElement
const trackInput = document.getElementById('track') as HTMLInputElement
const retainedInput = document.getElementById('retained') as HTMLInputElement
const applyButton = document.getElementById('apply') as HTMLButtonElement
const limitsNote = document.getElementById('limits-note')!
const site = document.getElementById('site')!
const siteOn = document.getElementById('site-on') as HTMLInputElement
const siteLabel = document.getElementById('site-label')!
const rules = document.getElementById('rules')!
const ruleHost = document.getElementById('rule-host') as HTMLInputElement
const ruleAdd = document.getElementById('rule-add') as HTMLButtonElement
const rulesNote = document.getElementById('rules-note')!

/** Re-rendering under a click would replace the button mid-request — of which there can be more than one. */
let busy = 0
let lastRendered = ''
/**
 * Whether the site rules cover the tab this popup is over.
 *
 * The list looks identical either way — empty — so the empty state has to be
 * the thing that distinguishes "nothing here yet, play the video" from "this
 * site is switched off", which is otherwise indistinguishable from broken.
 */
let capturingHere = true

/**
 * The host in the address bar, or null on a page that has none. Separate from
 * `capturingHere` because the two empty states differ: a site that is switched
 * off has a checkbox to tick, a page with no host has nothing to name.
 */
let hereHost: string | null = null

function empty(): HTMLElement {
  const div = document.createElement('div')
  div.className = 'empty'
  // Before the capture check, because it outranks it: under **Everywhere** a
  // page with no host counts as covered, and would otherwise be told to reload
  // — advice that can never work on a page no content script reaches.
  if (hereHost === null) {
    div.innerHTML = `
      <p><strong>No site here.</strong> This page has no http(s) address, so no
         site rule matches it — which is why there is no switch for it above.</p>
      <p>A browser page — <code>chrome://</code>, the extensions list, a PDF
         viewer — is out of reach of any extension's content scripts. A local
         <code>file://</code> page needs <em>Allow access to file URLs</em> on
         this extension's details page.</p>
    `
    return div
  }

  if (!capturingHere) {
    div.innerHTML = `
      <p><strong>Not capturing on this site.</strong> Nothing here is being
         detected, and nothing is being held in the page's memory.</p>
      <p>Tick the box above to capture here. New blobs are picked up straight
         away; a video that is already playing has to be reloaded first,
         because the opening segment that makes the file playable has gone
         past.</p>
    `
    return div
  }
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
  body.className = 'body'

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

  const save = document.createElement('button')
  save.textContent = 'Save'
  save.disabled = !item.saveable

  const remove = document.createElement('button')
  remove.className = 'ghost'
  remove.textContent = 'Remove'
  remove.title =
    'Drop this row and free the bytes behind it. Not undoable: a stream stops recording for good, and anything the page has already revoked is gone.'

  const buttons = [save, remove]

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
  }

  /**
   * A click, with the polling held off for its duration.
   *
   * `busy` matters more than it looks: the list re-renders from scratch, so a
   * refresh landing mid-request would swap out the very button being waited on
   * and the reply would land on a detached node. Released as soon as the reply
   * is in, which is what makes a purge look immediate — the inventory really
   * has changed, so the next tick rebuilds the row (or drops it).
   */
  const act = async (
    button: HTMLButtonElement,
    pending: string,
    done: string,
    message: Request,
  ): Promise<void> => {
    busy++
    const labels = buttons.map((b) => b.textContent)
    const disabled = buttons.map((b) => b.disabled)
    const restore = (): void => {
      for (const [i, b] of buttons.entries()) {
        b.textContent = labels[i] ?? ''
        b.disabled = disabled[i] ?? false
      }
    }

    for (const b of buttons) b.disabled = true
    button.textContent = pending
    try {
      const result = (await chrome.runtime.sendMessage(message)) as SaveResult | PurgeResult
      restore()
      if (result.ok) {
        // The note belonged to an attempt that failed; this one didn't. Nothing
        // else will clear it on a save: the row is unchanged, so the inventory
        // is unchanged, so the poll has nothing to re-render — and the row
        // would sit there reading `Saved` under a red failure.
        failure?.remove()
        failure = null
        button.textContent = done
        // Whatever this button did has been done; the refresh a moment later
        // decides what the row can do next.
        button.disabled = true
        return
      }
      // A failure leaves the row as it was, so the click can be repeated once
      // the reason has been read.
      failed(result.error)
      if (button === save) button.textContent = 'Retry'
      button.disabled = false
    } catch (e) {
      restore()
      failed(`Extension not reachable: ${(e as Error).message}`)
      button.disabled = false
    } finally {
      busy--
    }
  }

  save.addEventListener('click', () => {
    void act(save, 'Saving…', 'Saved', { type: 'SAVE', tabId, frameId, id: item.id })
  })

  remove.addEventListener('click', () => {
    void act(remove, 'Removing…', 'Removed', { type: 'PURGE', tabId, frameId, id: item.id })
  })

  const actions = document.createElement('div')
  actions.className = 'actions'
  actions.append(save, remove)

  el.append(body, actions)
  return el
}

function render(frames: FrameInventory[], tabId: number): void {
  const withItems = frames.filter((frame) => frame.items.length > 0)
  const total = withItems.reduce((n, frame) => n + frame.items.length, 0)
  const bytes = withItems.reduce(
    (n, frame) => n + frame.items.reduce((m, item) => m + item.size, 0),
    0,
  )

  // What `Clear` and `Del` give back, which is the only way to see that they
  // did: `available` counts bytes we can hand over, `held` the subset of those
  // sitting in the page's memory because of us.
  const held = withItems.reduce(
    (n, frame) => n + frame.items.reduce((m, item) => m + (item.retained ? item.size : 0), 0),
    0,
  )

  summary.textContent =
    total === 0
      ? hereHost === null
        ? 'No site here to switch on.'
        : capturingHere
          ? 'No blobs detected.'
          : 'Switched off for this site.'
      : `${total} item${total === 1 ? '' : 's'} · ${humanSize(bytes)} available` +
        (held > 0 ? ` · ${humanSize(held)} held` : '')
  clearAll.disabled = total === 0

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

function say(problem: string): void {
  trouble.textContent = problem
  trouble.hidden = false
}

/**
 * Empty the page, on the second click.
 *
 * One button that frees every byte on the page is worth a confirmation where a
 * single row is not: there is no undo, and a stream that has been playing for
 * an hour can only be got back by playing it again.
 */
function wireClearAll(tabId: number): void {
  let armed = 0
  const disarm = (): void => {
    clearTimeout(armed)
    armed = 0
    clearAll.textContent = 'Clear all'
  }

  clearAll.addEventListener('click', () => {
    if (armed === 0) {
      clearAll.textContent = 'Everything?'
      armed = window.setTimeout(disarm, 4000)
      return
    }
    disarm()
    void (async () => {
      busy++
      clearAll.disabled = true
      clearAll.textContent = 'Clearing…'
      trouble.hidden = true
      try {
        const result = (await chrome.runtime.sendMessage({
          type: 'PURGE_ALL',
          tabId,
        } satisfies Request)) as PurgeResult
        if (!result.ok) say(result.error)
      } catch (e) {
        say(`Extension not reachable: ${(e as Error).message}`)
      } finally {
        clearAll.textContent = 'Clear all'
        clearAll.disabled = false
        busy--
      }
    })()
  })
}

/**
 * Where this extension runs.
 *
 * Written to `chrome.storage.local` and nothing else, like the limits: every
 * frame's bridge is watching for the change and re-asks the background whether
 * its tab is still covered. Nothing here has to reach the tab itself.
 *
 * `here` is the host in the address bar, or null on a page that has none — a
 * `chrome://` page, the Web Store, a PDF. The rules are extension-wide, so
 * they are editable from there too; only the per-site checkbox is not.
 */
async function wireSites(here: string | null): Promise<void> {
  const modeRadios = [...document.querySelectorAll<HTMLInputElement>('input[name="mode"]')]

  const stored = (await chrome.storage.local.get(POLICY_KEY).catch(() => ({}))) as Record<
    string,
    unknown
  >
  let policy = normalisePolicy(stored[POLICY_KEY])

  /**
   * Drawn from `policy` and persisted after, rather than waiting for the write:
   * a checkbox that lags a storage round-trip reads as a click that missed.
   */
  const write = (next: Policy): void => {
    policy = next
    rulesNote.textContent = ''
    draw()
    void chrome.storage.local.set({ [POLICY_KEY]: next }).catch((e: unknown) => {
      rulesNote.textContent = `Could not save: ${(e as Error).message}`
    })
  }

  const ruleRow = (key: 'allow' | 'deny', entry: Site): HTMLElement => {
    const el = document.createElement('div')
    el.className = 'rule'

    const label = document.createElement('label')
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = entry.on
    const host = document.createElement('span')
    host.textContent = entry.host
    host.title = `${entry.host} and its subdomains`
    label.append(box, host)
    box.addEventListener('change', () => {
      write(toggleRule(policy, key, entry.host, box.checked))
    })

    // Unchecking suspends a rule; this forgets it. Both are worth having — a
    // list you cannot prune grows until it is unreadable.
    const drop = document.createElement('button')
    drop.className = 'ghost'
    drop.textContent = '×'
    drop.title = `Forget the rule for ${entry.host}`
    drop.addEventListener('click', () => {
      write(removeRule(policy, key, entry.host))
    })

    el.append(label, drop)
    return el
  }

  function draw(): void {
    for (const radio of modeRadios) radio.checked = radio.value === policy.mode

    const on = allows(policy, here)
    if (on !== capturingHere) {
      capturingHere = on
      // The list itself does not change shape, so the poll's own
      // did-anything-change check would leave the stale empty state up.
      lastRendered = ''
    }
    site.hidden = here === null
    if (here !== null) {
      siteOn.checked = on
      siteLabel.textContent = on ? `Capturing on ${here}` : `Not capturing on ${here}`
    }

    const key = listKey(policy.mode)
    rules.textContent = ''
    ruleHost.disabled = key === null
    ruleAdd.disabled = key === null

    if (key === null) {
      const note = document.createElement('p')
      note.className = 'hint'
      note.textContent = 'Running everywhere. Pick one of the other two to keep a list.'
      rules.append(note)
      return
    }
    if (policy[key].length === 0) {
      const note = document.createElement('p')
      note.className = 'hint'
      note.textContent =
        policy.mode === 'allowlist'
          ? 'No sites listed, so nothing is captured anywhere.'
          : 'No sites listed, so everything is captured.'
      rules.append(note)
      return
    }
    for (const entry of policy[key]) rules.append(ruleRow(key, entry))
  }

  siteOn.addEventListener('change', () => {
    if (here === null) return
    // Unticking on a page where the mode is still `all` is what starts a
    // denylist — see `capture` in `src/lib/policy.ts`.
    write(capture(policy, here, siteOn.checked))
  })

  for (const radio of modeRadios) {
    radio.addEventListener('change', () => {
      if (!radio.checked) return
      write({ ...policy, mode: radio.value as Policy['mode'] })
    })
  }

  const add = (): void => {
    const key = listKey(policy.mode)
    if (key === null) return
    const host = normaliseHost(ruleHost.value)
    if (host === null) {
      rulesNote.textContent = 'Not a hostname.'
      return
    }
    ruleHost.value = ''
    // Re-adding a host it already has moves it to the end switched on, rather
    // than leaving a second row claiming to control the same site.
    write({ ...policy, [key]: [...policy[key].filter((s) => s.host !== host), { host, on: true }] })
  }

  ruleAdd.addEventListener('click', add)
  ruleHost.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') add()
  })

  draw()
}

/**
 * The two memory ceilings.
 *
 * Written to `chrome.storage.local` and nothing else: every frame's bridge is
 * listening for the change and forwards it into the page world, including on
 * pages that are capturing right now — which is the case the setting exists
 * for. Nothing here has to reach the tab itself.
 */
async function wireLimits(): Promise<void> {
  const show = (limits: { trackBytes: number; retainedBytes: number }): void => {
    trackInput.value = String(toMB(limits.trackBytes))
    retainedInput.value = String(toMB(limits.retainedBytes))
  }

  for (const [input, bound] of [
    [trackInput, BOUNDS.trackBytes],
    [retainedInput, BOUNDS.retainedBytes],
  ] as const) {
    input.min = String(toMB(bound.min))
    input.max = String(toMB(bound.max))
    input.step = '16'
  }

  const stored = (await chrome.storage.local.get(LIMITS_KEY).catch(() => ({}))) as Record<
    string,
    unknown
  >
  show(normalise(stored[LIMITS_KEY]))

  applyButton.addEventListener('click', () => {
    void (async () => {
      // An empty or nonsensical box means the default, not the floor: `normalise`
      // falls back for anything it cannot use, and 16 MB is a surprising thing to
      // get for having typed nothing.
      const typed = (input: HTMLInputElement): number | undefined => {
        const mb = Number(input.value)
        return Number.isFinite(mb) && mb > 0 ? fromMB(mb) : undefined
      }
      const limits = normalise({
        trackBytes: typed(trackInput),
        retainedBytes: typed(retainedInput),
      })
      applyButton.disabled = true
      try {
        await chrome.storage.local.set({ [LIMITS_KEY]: limits })
        const clamped =
          String(toMB(limits.trackBytes)) !== trackInput.value ||
          String(toMB(limits.retainedBytes)) !== retainedInput.value
        show(limits)
        limitsNote.textContent = clamped ? 'Applied, within range.' : 'Applied.'
      } catch (e) {
        limitsNote.textContent = `Could not save: ${(e as Error).message}`
      } finally {
        applyButton.disabled = false
      }
    })()
  })
}

async function main(): Promise<void> {
  // Before the tab check: the limits are extension-wide, and a popup opened over
  // a chrome:// page is a perfectly good place to change them.
  void wireLimits()

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  // Before the tab check too, for the same reason: the rules are extension-wide
  // and worth reaching from a `chrome://` tab. The per-site checkbox hides
  // itself when there is no host to name.
  hereHost = hostOf(tab?.url)
  await wireSites(hereHost)

  if (tab?.id === undefined) {
    summary.textContent = 'No page here.'
    return
  }
  const tabId = tab.id
  wireClearAll(tabId)

  const tick = async (): Promise<void> => {
    if (busy > 0) return
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
