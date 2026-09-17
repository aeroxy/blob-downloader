/**
 * Where this extension is allowed to run.
 *
 * The content scripts match `<all_urls>` and cannot do otherwise: the patches
 * have to be installed at `document_start`, before the page's own scripts take
 * a reference to `URL.createObjectURL`, and a decision read out of
 * `chrome.storage` — which is async, and not reachable from the page world at
 * all — arrives after that. So this does not gate injection. It gates
 * *recording*: on a site that is not covered the patches stay in place as
 * pass-throughs, nothing is kept, and whatever landed in the moment before the
 * decision arrived is handed straight back (`setCapturing` in
 * `src/lib/blob-registry.ts`).
 *
 * Matched against the **tab's** hostname rather than each frame's. A blog that
 * embeds a player from another origin holds its media in that frame, and
 * "capture on this site" has to mean the site in the address bar, or an
 * allowlist would silently miss the one frame that mattered.
 */

export type Mode =
  /** Everywhere. The default, and what the extension did before this existed. */
  | 'all'
  /** Only the sites in `allow`. */
  | 'allowlist'
  /** Everywhere except the sites in `deny`. */
  | 'denylist'

export interface Site {
  /** A hostname, lowercased, without scheme, port or path. Covers itself and its subdomains. */
  host: string
  /**
   * In effect. A rule is unchecked rather than deleted so it can be suspended
   * for one page and got back without retyping — the reason the popup shows a
   * checkbox next to each entry and not only a remove.
   */
  on: boolean
}

export interface Policy {
  mode: Mode
  /** Read under `allowlist`. */
  allow: Site[]
  /** Read under `denylist`. */
  deny: Site[]
  /*
   * Two lists rather than one read differently by the mode: a list of sites to
   * keep this off is the exact inverse of a list of sites to keep it on, so one
   * list would silently invert its meaning on a mode change. Both are kept
   * across a switch, so going back and forth loses nothing.
   */
}

export const DEFAULT_POLICY: Policy = { mode: 'all', allow: [], deny: [] }

/** Where the popup writes it, and every frame's bridge watches for changes. */
export const POLICY_KEY = 'policy'

/** Which list a mode reads. `all` reads neither. */
export const listKey = (mode: Mode): 'allow' | 'deny' | null =>
  mode === 'allowlist' ? 'allow' : mode === 'denylist' ? 'deny' : null

/** Labels, no dots required — `localhost` is a site someone tests on. */
const HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/

/**
 * A hostname out of whatever was typed.
 *
 * People paste the address bar, so a scheme, a path, a port and a `www.` are
 * all expected; a leading `*.` is expected too, because that is how everything
 * else spells "and its subdomains" — which is what a bare host already means
 * here. Returns null for anything that isn't a hostname, which is what the
 * popup shows as a refusal rather than storing a rule that can never match.
 */
export function normaliseHost(typed: string): string | null {
  let host = typed.trim().toLowerCase()
  if (host === '') return null
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  host = host.replace(/[/?#].*$/, '')
  host = host.replace(/:\d+$/, '')
  host = host.replace(/^\*?\./, '')
  // `example.com.` is the absolute form of `example.com`, and pastes out of an
  // address bar that way. One dot: `example.com..` is a typo, not a host.
  host = host.replace(/\.$/, '')
  return HOST.test(host) ? host : null
}

/**
 * The hostname a policy is matched against, or null for a page that has none.
 *
 * Restricted to http(s) because a policy is about sites: `chrome://extensions`
 * parses with a hostname of `extensions`, and a rule someone wrote for a site
 * has no business matching a browser page by accident.
 */
export function hostOf(url: string | undefined): string | null {
  if (!url) return null
  try {
    const { protocol, hostname } = new URL(url)
    if (protocol !== 'http:' && protocol !== 'https:') return null
    // Trailing dot dropped here too, so the two sides agree on one spelling:
    // a rule stored from this host is read back through `normaliseHost`, and
    // a host that came out of it would stop matching the tab it was written for.
    const host = hostname.toLowerCase().replace(/\.$/, '')
    return host === '' ? null : host
  } catch {
    return null
  }
}

/** A rule covers its own host and every subdomain of it, and nothing else. */
export const covers = (rule: string, host: string): boolean =>
  host === rule || host.endsWith(`.${rule}`)

/**
 * Anything at all into a usable policy.
 *
 * Storage outlives the code that wrote it, and this decides whether a page's
 * media is held in its memory, so there is no useful way to fail: an
 * unreadable value means the default, which is the behaviour from before the
 * setting existed. Entries that can never match are dropped rather than shown,
 * and a host is kept once — two rows for one site would each claim to be the
 * control for it.
 */
export function normalisePolicy(stored: unknown): Policy {
  const raw = (stored ?? {}) as Partial<Policy>
  const mode: Mode =
    raw.mode === 'allowlist' || raw.mode === 'denylist' || raw.mode === 'all' ? raw.mode : 'all'

  const list = (value: unknown): Site[] => {
    const byHost = new Map<string, Site>()
    if (!Array.isArray(value)) return []
    for (const entry of value) {
      if (typeof entry !== 'object' || entry === null) continue
      const { host, on } = entry as Partial<Site>
      const clean = typeof host === 'string' ? normaliseHost(host) : null
      if (clean === null) continue
      // A missing `on` is in effect: an entry someone added by hand meant to do
      // something, and an inert rule is the surprising reading.
      byHost.set(clean, { host: clean, on: on !== false })
    }
    return [...byHost.values()]
  }

  return { mode, allow: list(raw.allow), deny: list(raw.deny) }
}

/** Whether this extension records anything on a tab at this host. */
export function allows(policy: Policy, host: string | null): boolean {
  const key = listKey(policy.mode)
  if (key === null) return true
  const listed =
    host !== null && policy[key].some((site) => site.on && covers(site.host, host))
  // A host we cannot name — `about:blank`, a `chrome://` page — is on no list.
  // Under an allowlist that means off, which is the mode's whole premise.
  return policy.mode === 'allowlist' ? listed : !listed
}

/**
 * Put `host` on the mode's list, or take it off.
 *
 * Asymmetric on purpose. Adding writes the exact host: a rule for
 * `example.com` that happens to be switched off is not this host's rule, and
 * turning it back on would cover the whole domain rather than the one site
 * asked for. Removing has to clear *every* rule that covers the host, parents
 * included — deactivating only an exact entry would leave the site still
 * matched by its parent, and a checkbox that visibly changes nothing is worse
 * than no checkbox.
 */
function set(list: Site[], host: string, on: boolean): Site[] {
  if (!on) return list.map((site) => (covers(site.host, host) ? { ...site, on: false } : site))
  const exact = list.some((site) => site.host === host)
  const next = list.map((site) => (site.host === host ? { ...site, on: true } : site))
  return exact ? next : [...next, { host, on: true }]
}

/**
 * What the popup's per-site checkbox does: capture here, or don't.
 *
 * Under `all` there is no list to edit, so switching a site off is what turns
 * the denylist on — otherwise the only way to exclude one site would be to
 * pick a mode first, and the mode is the part nobody wants to think about.
 */
export function capture(policy: Policy, host: string, on: boolean): Policy {
  const mode: Mode = policy.mode === 'all' && !on ? 'denylist' : policy.mode
  const key = listKey(mode)
  if (key === null) return policy
  // Listed means captured under an allowlist and excluded under a denylist.
  return { ...policy, mode, [key]: set(policy[key], host, mode === 'allowlist' ? on : !on) }
}

/** Drop a rule outright, from the popup's list. */
export function remove(policy: Policy, key: 'allow' | 'deny', host: string): Policy {
  return { ...policy, [key]: policy[key].filter((site) => site.host !== host) }
}

/** Switch one rule on or off without losing it. */
export function toggle(policy: Policy, key: 'allow' | 'deny', host: string, on: boolean): Policy {
  return {
    ...policy,
    [key]: policy[key].map((site) => (site.host === host ? { ...site, on } : site)),
  }
}
