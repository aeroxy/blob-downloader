use bun for package management

use bun typecheck

be concise

### Threat model

This is a **personal tool**. It runs in the user's browser, on pages the user is
already looking at, and saves data those pages already handed to the browser.
There is no untrusted-model boundary and no multi-tenant server.

Do not flag as security issues: the `<all_urls>` content-script match, patching
page globals, retaining a page's `Blob` after it revoked the URL, or reading a
MediaSource's segments. Those are the mechanism, not a lapse.

Do flag the one real cost: **the extension holds media in the page's memory** —
up to 512 MB per stream track and 1 GB of retained Blobs per frame. That is a
deliberate trade (it is what makes a revoked blob recoverable and a stream
saveable at all) and the caps and their notes should stay honest in the popup.

### Saving: do not re-propose the anchor click

The page-world `<a download>` was the first design and it is wrong. It needs no
permissions, copies no bytes, and **works exactly once per page**: a download a
page starts without a user gesture trips Chrome's automatic-downloads block, and
subsequent ones are dropped with no error anywhere — not in the page, not in the
popup, not in the service worker. Measured: five saves issued, all reporting
`ok`, one file on disk.

What replaced it, and why it is not the obvious alternative either:

- The bytes are **not** sent to the background. `chrome.runtime` messaging is
  JSON, so a video would cross as base64 at a third again its size, and an MV3
  service worker has no `URL.createObjectURL` to rebuild it with.
- There is **no offscreen document**. It would only exist to mint a blob URL.
- Instead the page mints a fresh object URL and the background hands *that* to
  `chrome.downloads`. Verified against Chrome 151: the downloads API resolves a
  `blob:` URL owned by a web page. This is the load-bearing fact — if a future
  Chrome closes it, the fallback is base64 chunks to an offscreen document, not
  the anchor.

The URL is minted fresh even when the page still has a live one, because the
page may revoke between the prepare and the download starting.

### MediaSource capture

Segments are copied on `appendBuffer` because players reuse one scratch buffer
per fetch; keeping the caller's view yields whichever segment was last.

Stored in **append order**, which is timeline order only for a straight
play-through. Seeking scrambles it. Not worth trying to reorder from the parsed
timestamps — that means demuxing fMP4 and WebM in the content script.

Overshoot past the cap is dropped from the **end**, never the start: the first
append is the initialisation segment, and a file without it plays nowhere.

`sawInit` is false when the first `appendBuffer` arrives on a SourceBuffer we
never saw created — prototype patching catches objects that already exist, but
their header is already gone. The row must say so; a silently unplayable file is
worse than a refusal.

Known gap: `SourceBuffer.changeType` is not tracked, so a mid-stream container
switch would splice two headers. Codec switches within one container are fine.

### Remove / Clear all

`Remove` on a row, `Clear all` in the header — the same operation, one item or
every item in every frame. Both are `purge`; there is deliberately no
free-the-bytes-but-keep-the-row variant, because clearing a stream's segments
takes its initialisation segment with them and what accumulated afterwards would
play nowhere.

- A removed track keeps its `trackBySourceBuffer` mapping and sets `dropped`.
  Forgetting the SourceBuffer instead would have the next `appendBuffer` adopt
  it as a fresh row and climb straight back up — the opposite of purging.
- A removed track stays in `stream.tracks`: the stream still has the tracks it
  has, and renumbering the survivor to "1 of 1" would claim otherwise.
- `Clear all` fans out per frame in the background rather than sending one
  frameless message, which reaches every frame but returns only the first reply.
  A frame that cannot be reached has navigated away, so its stale rows are
  dropped from session storage instead of being reported as a failure.
- `Clear all` arms on the first click. A single row does not need that; a button
  that frees a whole page of bytes does.

### Testing it in a browser

`test/blob-test.html`, served over HTTP (content scripts do not run on `file://`
without the file-access opt-in). Its MediaSource appends non-media bytes on
purpose — the demuxer rejects them, which is irrelevant, because the capture
happens before the decoder ever sees them.

Driving it from a script, the hard-won parts:

- **`--load-extension` is dead.** Chrome 151 refuses it, and — worse — its mere
  presence on the command line makes Chrome block extension loading wholesale,
  so `Extensions.loadUnpacked` then reports success while the extension stays
  disabled and its pages answer `ERR_BLOCKED_BY_CLIENT`. Drop the flag entirely.
- Load over CDP instead: `Extensions.loadUnpacked`, with
  `--enable-unsafe-extension-debugging` and `extensions.ui.developer_mode` seeded
  into the profile's `Preferences`. This is what `web-ext` (so `wxt dev`) does.
- Headless refuses to load unpacked extensions at all. Run headed.
- `sourceopen` does not fire in a background tab — Chrome defers media loading.
  Foreground the tab first or `addSourceBuffer` never happens.
- The hook is observable from the page: listen for `blobdl:event` on `document`
  and read the inventory it pushes. That is the cheapest end-to-end assertion.
