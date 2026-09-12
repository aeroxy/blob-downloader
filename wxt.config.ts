import { mkdirSync, readFileSync } from 'node:fs'
import { defineConfig } from 'wxt'

const chromeProfile = '.wxt/chrome-data'
mkdirSync(chromeProfile, { recursive: true })

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'))

export default defineConfig({
  srcDir: 'src',
  webExt: {
    chromiumProfile: chromeProfile,
    keepProfileChanges: true,
    chromiumArgs: ['--hide-crash-restore-bubble'],
  },
  vite: () => ({
    define: {
      __VERSION__: JSON.stringify(pkg.version),
      __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    },
    build: {
      // Loaded unpacked, never from the Web Store, so bundle size buys nothing
      // — and this extension holds on to page media, so readable output means
      // what it retains and where it sends it stays auditable.
      minify: false,
    },
  }),
  manifest: {
    name: 'Blob Downloader',
    description: 'Detect every blob: URL and MediaSource stream on a page, and save it',
    // `storage` holds only `chrome.storage.session` — the per-tab inventory, so
    // the popup still has something to show after Chrome has terminated the
    // service worker.
    //
    // `downloads` is not for convenience. Saving from the page directly, with an
    // `<a download>` where the bytes already are, works exactly once: a download
    // a page starts without a user gesture trips Chrome's automatic-downloads
    // block, and every file after the first is dropped with no error anywhere.
    // `chrome.downloads` is exempt, and it resolves a `blob:` URL belonging to
    // the page — so the bytes still never leave the page, and nothing is copied
    // through the service worker.
    //
    // Note what is absent: no `webRequest`, because blobs never touch the
    // network, and no `tabs`, which is the broader of the two ways to see a
    // tab's URL.
    permissions: ['storage', 'downloads'],
    // Only for `tab.url`, which the site policy needs and the content scripts'
    // own `<all_urls>` match does not grant. It has to be the *tab's* host: a
    // cross-origin player iframe cannot see the address bar it is embedded
    // under, so matching each frame's own host would have an allowlist miss the
    // one frame holding the media. Nothing here fetches cross-origin.
    host_permissions: ['<all_urls>'],
    action: {
      default_title: 'Blob Downloader',
    },
    icons: {
      16: 'assets/icon-16.png',
      32: 'assets/icon-32.png',
      48: 'assets/icon-48.png',
      128: 'assets/icon-128.png',
    },
  },
})
