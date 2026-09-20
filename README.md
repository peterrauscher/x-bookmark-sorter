# X Bookmark Sorter (Jev)

A Google Chrome extension (Manifest V3) that automatically sorts your X bookmarks
into folders you create — using [TypeSafe](https://typesafe.ai)'s **Jev** System One
model to decide where each bookmarked post belongs.

Built with the [TypeSafe skill](https://github.com/typesafe-ai/skills/blob/main/skills/typesafe-ai/SKILL.md):
instead of an LLM prompt-and-parse step, filing is a single typed **Choice** question
per bookmark, grouped into batched Jev requests — Jev returns the winning folder plus a
probability distribution and confidence, and the extension files anything below your
confidence threshold as "needs review" rather than guessing.

## How it works

1. **Scan** — the content script reads your `x.com/i/bookmarks` page (auto-scrolls to
   load more) and stores each bookmark's text, author, and URL locally.
2. **Sort** — the background worker sends up to 20 unsorted bookmarks to Jev as one
   state, with one Choice question per bookmark. Up to three such requests run
   concurrently. Your folders become the criteria, plus an explicit `unsorted`
   no-match option.
3. **File** — if Jev's pick clears your confidence threshold (default 0.60), the
   bookmark is filed; otherwise it lands in Unsorted flagged for review.
4. **Browse** — the popup shows bookmarks per folder with manual re-assignment.

X has no public API for bookmark folders, so folders live in the extension
(`chrome.storage.local`). The extension only *reads* the bookmarks page DOM.

## Setup

1. Get a TypeSafe API key at [console.typesafe.ai](https://console.typesafe.ai).
2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**,
   and select this folder.
3. Open the extension's **Settings** (⚙ in the popup), paste your API key, then create
   your folders. Give each folder a one-or-two-sentence description — that's what Jev
   classifies against.
4. Go to [x.com/i/bookmarks](https://x.com/i/bookmarks), open the popup, hit
   **Scan X bookmarks**, then **Auto-sort with Jev**.

## Project layout

```
manifest.json          MV3 manifest
src/
  background.js        service worker: storage + auto-sort orchestration
  jev.js               TypeSafe HTTP API client (batched Choice classification)
  content.js           bookmarks-page scraper (x.com/i/bookmarks)
  popup.html/js/css    browse-by-folder UI, scan & sort triggers
  options.html/js/css  API key, folder CRUD, threshold/model settings
icons/                 extension icons
```

## Design notes (from the TypeSafe skill)

- **One narrow Choice per bookmark.** Each question is a single coherent judgment
  ("which folder fits best"), and independent bookmark questions are batched into
  fewer Jev requests.
- **Criteria carry the meaning.** Folder descriptions are sent to the model, so
  write ones that separate the folders from each other.
- **No-match outcome included.** An `unsorted` option lets the model decline to
  force a fit.
- **Confidence gates action.** Low-confidence filings go to a human (you) instead
  of silently misfiling — confidence summarizes distribution concentration.
- **API key stays client-side.** It's stored in `chrome.storage.local` and only
  ever sent to `api.typesafe.ai`. Bookmark text is sent to TypeSafe for
  classification; nothing else leaves the browser.

## Limitations / roadmap

- Bookmark scraping reads X's page DOM, which X can change without notice. If
  scanning breaks, the selectors in `src/content.js` need updating.
- Filing happens inside the extension, not in X's native (Premium) bookmark
  folders — X offers no public API for those.
- Possible next steps: auto-sort on a schedule, per-folder Jev descriptions
  learned from corrections, bulk import/export.

## License

MIT — see [LICENSE](LICENSE).
