# BookmarX

> **Version**: v0.0.1

[![Chrome Web Store — coming soon](https://img.shields.io/badge/Chrome%20Web%20Store-Coming%20soon-4285F4?logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/x-bookmark-sorter/PLACEHOLDER)

## Table of Contents

- [Usage](#usage)
- [How it works](#how-it-works)
- [Key Considerations](#key-considerations)
- [Development Considerations](#development-considerations)
  - [Quick Start](#quick-start)
  - [Testing](#testing)
  - [Versioning](#versioning)
- [Project layout](#project-layout)
- [License](#license)

## Usage

1. Load this directory as an unpacked extension from `chrome://extensions` with
   **Developer mode** enabled.
2. Open the extension's **Settings**. Paste a TypeSafe API key; it is saved in the
   browser when the field changes.
3. Create an X public client at [console.x.com](https://console.x.com). Add the exact
   callback URL shown in Settings, enable these scopes, and paste the client ID:
   `tweet.read users.read bookmark.read bookmark.write offline.access`.
4. Select **Connect X account** and complete OAuth. The X account must have bookmark
   folders, which require X Premium.
5. Open the **Bookmarks** tab at [x.com/i/history](https://x.com/i/history), then use
   **Scan X bookmarks** followed by **Auto-sort with Jev**.
6. Browse results in the popup. Manual folder changes are written to X as well.

## How it works

1. `src/content.js` reads visible bookmarked posts from X's Bookmarks tab and streams
   their text, author, and URL to the background service worker while scrolling.
2. The worker reads folder names from the page and resolves them to X folder IDs through
   the official API. If the page does not expose the folder menu, it uses the API list.
3. Jev receives up to **20 bookmarks per request**, represented as one shared state with
   one independent `choice` question per bookmark. Up to **3 requests** run concurrently.
   Folder names are the criteria, with `unsorted` as a no-match option.
4. Results below the confidence threshold (default `0.60`) stay out of a folder and are
   marked for review. Confident results are filed through X's documented bookmark API.
5. X API writes are chunked to its documented limit of 25 posts per request. The worker
   confirms folder placement and reports failures in the popup.

## Key Considerations

- **Requirements:** Chrome/Chromium with Manifest V3, a TypeSafe API key, an X public
  client, X Premium bookmark folders, and X API access/credits.
- **Published interfaces only:** the extension reads the already-open X page DOM, but
  OAuth, folder lookup, and bookmark writes use documented X API endpoints. See the
  [X bookmark API documentation](https://docs.x.com/x-api/posts/bookmarks).
- **Limits:** X documents 50 bookmark writes and 50 folder reads per 15-minute window.
  Large sorts can stop when the window is exhausted and report when to retry. Bookmark
  folder creation, renaming, and deletion remain X UI operations.
- **Data handling:** TypeSafe receives bookmark text and related metadata for
  classification. API keys and OAuth tokens stay in `chrome.storage.local`; no server
  component is included.
- **Classification policy:** each bookmark gets one narrow Choice judgment. Jev's
  confidence controls filing; it is not a guarantee of correctness.

## Development Considerations

### Quick Start

There is no package manager, build step, or generated bundle. Edit the source files and
reload the unpacked extension from `chrome://extensions`. The extension entry points are
listed in [Project layout](#project-layout).

### Testing

No automated test suite is configured. Run the JavaScript syntax checks:

```bash
for file in src/*.js; do node --check "$file"; done
```

Then smoke-test the actual surface in Chrome: connect an X account, open the Bookmarks
tab, scan a small set, sort it, verify the confidence/review state, and manually move
one result.

### Versioning

This project follows [Semantic Versioning 2.0.0](https://semver.org/). The current
release is tagged **v0.0.1**. Inspect the effective repository version with:

```bash
git describe --tags --always
```

## Project layout

```text
manifest.json          Chrome Manifest V3 extension manifest
src/background.js      storage, Jev batching, and X filing orchestration
src/content.js         X Bookmarks tab scraper and folder-name reader
src/jev.js             TypeSafe HTTP client and batched Choice questions
src/xapi.js            X OAuth 2.0 PKCE and bookmark API client
src/popup.*            browse, scan, sort, and manual reassignment UI
src/options.*          TypeSafe/X credentials and sorting settings UI
icons/                 extension icons
```

## License

MIT — see [LICENSE](LICENSE).
