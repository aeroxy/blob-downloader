<p align="center">
  <img src="public/assets/icon-128.png" width="96" height="96" alt="">
</p>

<h1 align="center">Blob Downloader</h1>

<p align="center">
  Finds every <code>blob:</code> URL a page makes — and every MediaSource
  stream, which is the one you actually wanted — and saves it.
</p>

<p align="center">
  <em>No account, no API key, nothing to sign into.</em>
</p>

## Why

Right-clicking a `blob:` URL and choosing Save fails, and the reason is that
"blob URL" means two unrelated things.

Sometimes there is a real `Blob` behind it — a canvas export, a generated file,
a decrypted attachment. That one can be read, but only from inside the page that
made it, and only until the page calls `revokeObjectURL`, which well-behaved
pages do on the very next line.

Sometimes there is a **MediaSource** behind it. That is nearly every streaming
video on the web. There is no Blob, `fetch()` on the URL fails, and the data
does not exist yet — it arrives later, in pieces, as the player appends it. No
amount of copying the URL will ever get you the file.

This handles both.

## How it works

**Getting into the right world.** A page's `Blob` objects live in the page's own
JavaScript world, and a `blob:` URL is scoped to the origin that minted it, so an
ordinary content script sees the URL string and nothing behind it. The capture
runs as a `world: "MAIN"` content script at `document_start` — before the page's
own scripts can take a reference to `URL.createObjectURL` and slip past a later
patch. The price is that `chrome.*` does not exist there at all, so a second,
ordinary content script acts as a bridge.

**Real Blobs.** `URL.createObjectURL` is wrapped, and the `Blob` is kept, not
just its URL. Keeping it is the whole trick: a page that revokes the URL
immediately has destroyed the only public handle to its own data, and our
reference is what is left. Those rows say `URL revoked; saving from our own
reference`.

**Streams.** `MediaSource.prototype.addSourceBuffer` and
`SourceBuffer.prototype.appendBuffer` are wrapped, and every appended segment is
copied — copied, because players reuse one scratch buffer for every fetch, so
keeping the caller's view leaves you holding whichever segment was last. Saving
concatenates them in append order.

**Saving.** The first design clicked an `<a download>` in the page, where the
bytes already are, and needed no permissions at all. It works exactly once: a
download a page starts without a user gesture trips Chrome's automatic-downloads
block, and every file after the first is dropped silently. Measured — five
saves, one file on disk, no error anywhere.

So the page hands over a freshly minted URL instead, and `chrome.downloads`
fetches it. It is exempt from that block, and it resolves a URL belonging to the
page perfectly well. The bytes still never move: nothing is base64'd through the
service worker, and there is no offscreen document.

| File | Role |
| --- | --- |
| `src/entrypoints/hook.content.ts` | MAIN world: installs the patches, answers for the page |
| `src/entrypoints/bridge.content.ts` | The pipe between the page's world and the extension |
| `src/entrypoints/background.ts` | Aggregates frames, drives `chrome.downloads`, paints the badge |
| `src/entrypoints/popup/` | The list, and the Save / Clear / Del buttons |
| `src/lib/blob-registry.ts` | The patches and everything they record |
| `src/lib/segment-store.ts` | MediaSource segments, and the cap on them |
| `src/lib/format.ts` | Naming a file for bytes that arrived without a name |

## Setup

```bash
bun install
bun run build
```

Load `.output/chrome-mv3` unpacked. There is nothing to configure. The toolbar
badge counts what the current page is holding; the popup lists it.

For development, `bun run dev` launches a browser with the extension loaded.

`test/blob-test.html` exercises every case — a kept blob, a revoked one, a named
`File`, a PNG in an `<img>`, and a hand-driven MediaSource. Serve it over HTTP
rather than opening the file directly, since content scripts do not run on
`file://` without the file-access opt-in:

```bash
python3 -m http.server 8765 --directory test
```

## Reading what the popup tells you

Rows carry a one-line qualification, and the ones in orange are the ones that
affect whether the file will be usable:

- **capture began mid-stream — the file may not play.** The extension was
  installed or reloaded while the video was already running, so the
  initialisation segment — the header that makes every later fragment
  interpretable — went past before we were watching. Reload the page and play it
  again.
- **track N of M — separate files, mux them with ffmpeg.** Streaming video
  usually arrives as one SourceBuffer for video and another for audio. They save
  as two files: `ffmpeg -i video.mp4 -i audio.mp4 -c copy out.mp4`.
- **hit the size cap; the file ends early.** 512 MB per track by default,
  discarded from the end so that what you get still starts with its header and
  plays up to the cut. Raise it under **Memory limits** if the film is longer
  than the cap.
- **nothing captured yet — press play.** A MediaSource exists but the player has
  not asked for any data. There is nothing to save until it does.

## Giving the memory back

Everything the extension can save, it is holding in the page's own memory — that
is what makes a revoked blob recoverable and a stream saveable at all. The header
says how much (`… held`), and there are two ways to hand it back:

- **Remove**, on a row: drops that row and frees the bytes behind it. A removed
  stream stops recording for good, rather than starting a fresh row on the next
  segment and climbing straight back up.
- **Clear all**, in the header: the same for every item in every frame of the
  page. It asks first — one click arms it, the second empties the page — because
  there is no undo and a stream that has been playing for an hour can only be got
  back by playing it again.

Neither stops the extension watching: a blob the page mints afterwards, or a
video started afterwards, is captured as usual.

**Memory limits**, at the foot of the popup, sets the two ceilings: 512 MB per
stream track and 1 GB of retained blobs per frame, by default. They take effect
immediately, on pages that are already capturing — lowering the blob budget lets
go of what is over it there and then, which is the point of changing it on a tab
that is struggling. One thing they cannot do is undo: raising a cap will not
restart a stream that has already stopped, because what is kept has to be one
unbroken run from the first segment, and resuming after a gap would hand the
decoder fragments it has no header for. Reload and play it again.

## Limits

- **Segments are stored in append order, not timeline order.** Watch a video
  through from the start and those are the same thing. Seek backwards and
  forwards and they are not, and the file will stutter or refuse to play
  entirely. For a clean capture: fresh page, press play, leave it alone.
- **A stream is held in the page's memory while it records**, up to 512 MB per
  track, and retained Blobs up to 1 GB per frame — both adjustable in the popup,
  between 16 MB and 8 GB. Past whichever is set, the row says so rather than
  failing at the click.
- **`video.srcObject = mediaSource` streams are captured but harder to label** —
  they never mint a URL, so the `<video>` is matched by object identity instead.
- **`SourceBuffer.changeType` is not tracked.** A stream that switches container
  mid-playback would produce a file with two different headers spliced together.
  Codec switches within one container — the common case — are fine.
- Blobs are page-lifetime. Reloading the page loses everything it was holding,
  which is also why the inventory is kept in session storage and not on disk.
