# BookmarX

Sort your X bookmarks into folders with a little help from TypeSafe's Jev.

https://github.com/user-attachments/assets/887ea380-d825-4917-bd28-f7c348640635

BookmarX is a small Chrome extension. It scans the bookmarks you already have on X, suggests folders for them, and lets you review or change the results before filing them.

## What it does

- Scans bookmarks from X's **Bookmarks** tab.
- Uses Jev to suggest one of your existing bookmark folders.
- Leaves low-confidence suggestions in **Review** instead of filing them automatically.
- Files accepted results into X through the official X API.
- Lets you move individual bookmarks manually from the popup.

BookmarX does not create or rename X folders. Create those on X first.

## Requirements

- Chrome or another Chromium browser with Manifest V3 support.
- An X account with bookmark folders. X Premium is required for bookmark folders.
- A TypeSafe API key.
- An X developer app configured for user authentication.
- X API access for reading and writing bookmarks.

## Install locally

There is no build step or package manager.

1. Download or clone this repository.
2. Open `chrome://extensions`.
3. Turn on **Developer mode**.
4. Choose **Load unpacked** and select the repository folder.
5. Open BookmarX's **Settings** page.

## First-time setup

### 1. Add your TypeSafe key

Get a key from [console.typesafe.ai](https://console.typesafe.ai), then paste it into BookmarX Settings. It is stored in this browser's extension storage.

### 2. Connect X

1. Create an app at [console.x.com](https://console.x.com) using the **Native App** or **Single-page App** type.
2. In BookmarX Settings, copy the callback URL shown under **X account** and add that exact URL to your X app.
3. Enable these scopes:
   - `tweet.read`
   - `users.read`
   - `bookmark.read`
   - `bookmark.write`
   - `offline.access`
4. Paste the app's client ID into Settings.
5. Choose **Connect X account** and finish the authorization flow.

Create the folders you want to use on [x.com/i/history](https://x.com/i/history) before sorting.

## Use it

1. Open [x.com/i/history](https://x.com/i/history) and select the **Bookmarks** tab.
2. Open the BookmarX popup and choose **Scan bookmarks**.
3. Choose **Auto-sort**.
4. Browse folders or **Review** in the popup.
5. Change a bookmark's folder manually whenever needed.

The confidence threshold and maximum scan size are adjustable in Settings.

## Data and privacy

- Your TypeSafe API key, X client ID, and OAuth tokens are stored in `chrome.storage.local` on your browser.
- Bookmark text, author information, and URLs are sent to `api.typesafe.ai` when Jev classifies bookmarks.
- X folder reads and bookmark writes use X's API.
- The extension has no server of its own.
- **Delete scanned bookmarks** removes BookmarX's local scan cache; it does not delete anything from X.

Review the permissions and the source code before installing an extension from any source.

## Development

Edit the files directly, then reload the unpacked extension from `chrome://extensions`.

For a useful smoke test, connect a test X account, scan a small number of bookmarks, sort them, review one low-confidence result, and manually move one bookmark.

## Project layout

```text
manifest.json       Chrome Manifest V3 entry point
src/background.js   Storage, sorting, and X filing
src/content.js      Reads bookmarks and folder names from the X page
src/jev.js          TypeSafe / Jev client
src/xapi.js         X OAuth and bookmark API client
src/popup.*         Popup UI
src/options.*       Settings UI
icons/              Extension icons and logo assets
```

## License

[MIT](LICENSE)
