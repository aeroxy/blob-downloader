import { describe, expect, test } from 'bun:test'
import {
  allows,
  capture,
  covers,
  DEFAULT_POLICY,
  hostOf,
  normaliseHost,
  normalisePolicy,
  remove,
  toggle,
  type Policy,
} from '@/lib/policy'

const on = (host: string) => ({ host, on: true })

describe('normaliseHost', () => {
  test('takes a pasted address bar apart', () => {
    expect(normaliseHost('https://www.Example.com:8443/watch?v=1#t')).toBe('www.example.com')
  })

  test('drops a subdomain wildcard, which a bare host already means', () => {
    expect(normaliseHost('*.example.com')).toBe('example.com')
    expect(normaliseHost('.example.com')).toBe('example.com')
  })

  test('keeps a single label', () => {
    expect(normaliseHost('localhost')).toBe('localhost')
  })

  test('refuses what is not a hostname', () => {
    for (const typed of ['', '   ', 'two words', 'exam ple.com', 'https://', '-x.com', 'a..b'])
      expect(normaliseHost(typed)).toBeNull()
  })
})

describe('hostOf', () => {
  test('reads the hostname of a page URL', () => {
    expect(hostOf('https://Site.com/a/b')).toBe('site.com')
  })

  test('is null for a URL with no host, and for none at all', () => {
    expect(hostOf('about:blank')).toBeNull()
    expect(hostOf('chrome://extensions')).toBeNull()
    expect(hostOf(undefined)).toBeNull()
    expect(hostOf('not a url')).toBeNull()
  })
})

describe('covers', () => {
  test('a rule covers itself and its subdomains', () => {
    expect(covers('example.com', 'example.com')).toBe(true)
    expect(covers('example.com', 'www.example.com')).toBe(true)
    expect(covers('example.com', 'a.b.example.com')).toBe(true)
  })

  test('and nothing that merely ends the same way', () => {
    expect(covers('example.com', 'notexample.com')).toBe(false)
    expect(covers('www.example.com', 'example.com')).toBe(false)
  })
})

describe('allows', () => {
  test('everything, under the default', () => {
    expect(allows(DEFAULT_POLICY, 'example.com')).toBe(true)
    expect(allows(DEFAULT_POLICY, null)).toBe(true)
  })

  test('only the list, under an allowlist', () => {
    const policy: Policy = { mode: 'allowlist', allow: [on('example.com')], deny: [] }
    expect(allows(policy, 'www.example.com')).toBe(true)
    expect(allows(policy, 'other.com')).toBe(false)
    // A page whose host we cannot name can be on no list.
    expect(allows(policy, null)).toBe(false)
  })

  test('everything but the list, under a denylist', () => {
    const policy: Policy = { mode: 'denylist', allow: [], deny: [on('example.com')] }
    expect(allows(policy, 'www.example.com')).toBe(false)
    expect(allows(policy, 'other.com')).toBe(true)
    expect(allows(policy, null)).toBe(true)
  })

  test('ignores a rule that is switched off', () => {
    expect(allows({ mode: 'denylist', allow: [], deny: [{ host: 'x.com', on: false }] }, 'x.com')).toBe(
      true,
    )
    expect(
      allows({ mode: 'allowlist', allow: [{ host: 'x.com', on: false }], deny: [] }, 'x.com'),
    ).toBe(false)
  })
})

describe('capture', () => {
  test('switching a site off under `all` starts a denylist', () => {
    const next = capture(DEFAULT_POLICY, 'example.com', false)
    expect(next.mode).toBe('denylist')
    expect(allows(next, 'example.com')).toBe(false)
    expect(allows(next, 'other.com')).toBe(true)
  })

  test('switching one on under `all` changes nothing — it already was', () => {
    expect(capture(DEFAULT_POLICY, 'example.com', true)).toEqual(DEFAULT_POLICY)
  })

  test('round-trips under either mode', () => {
    for (const mode of ['allowlist', 'denylist'] as const) {
      let policy: Policy = { mode, allow: [], deny: [] }
      policy = capture(policy, 'example.com', true)
      expect(allows(policy, 'example.com')).toBe(true)
      policy = capture(policy, 'example.com', false)
      expect(allows(policy, 'example.com')).toBe(false)
      expect(policy.mode).toBe(mode)
    }
  })

  test('switching a site on clears the parent rule that was excluding it', () => {
    const policy = capture(
      { mode: 'denylist', allow: [], deny: [on('example.com')] },
      'www.example.com',
      true,
    )
    // The parent had to go: leaving it on and adding an inert child entry would
    // leave the site still excluded by the rule above it.
    expect(allows(policy, 'www.example.com')).toBe(true)
    expect(policy.deny).toEqual([{ host: 'example.com', on: false }])
  })

  test('switching a site on writes the exact host, not the parent it sits under', () => {
    const policy = capture(
      { mode: 'allowlist', allow: [{ host: 'example.com', on: false }], deny: [] },
      'www.example.com',
      true,
    )
    expect(policy.allow).toEqual([
      { host: 'example.com', on: false },
      { host: 'www.example.com', on: true },
    ])
    expect(allows(policy, 'other.example.com')).toBe(false)
  })

  test('keeps the list the mode is not reading', () => {
    const policy = capture({ mode: 'denylist', allow: [on('kept.com')], deny: [] }, 'x.com', false)
    expect(policy.allow).toEqual([on('kept.com')])
  })
})

describe('remove and toggle', () => {
  const policy: Policy = { mode: 'denylist', allow: [], deny: [on('a.com'), on('b.com')] }

  test('remove drops one rule', () => {
    expect(remove(policy, 'deny', 'a.com').deny).toEqual([on('b.com')])
  })

  test('toggle suspends one without losing it', () => {
    expect(toggle(policy, 'deny', 'a.com', false).deny).toEqual([
      { host: 'a.com', on: false },
      on('b.com'),
    ])
  })
})

describe('normalisePolicy', () => {
  test('anything unreadable is the default', () => {
    for (const stored of [undefined, null, 42, 'x', {}, { mode: 'nonsense' }])
      expect(normalisePolicy(stored)).toEqual(DEFAULT_POLICY)
  })

  test('cleans hosts, drops what can never match, and keeps each host once', () => {
    expect(
      normalisePolicy({
        mode: 'allowlist',
        allow: [
          { host: 'https://WWW.Example.com/x' },
          { host: 'two words', on: true },
          'a.com',
          { host: 'www.example.com', on: false },
        ],
        deny: 'not a list',
      }),
    ).toEqual({
      mode: 'allowlist',
      // Last write for a host wins, and a missing `on` means in effect.
      allow: [{ host: 'www.example.com', on: false }],
      deny: [],
    })
  })
})
