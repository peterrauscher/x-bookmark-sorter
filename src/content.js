// Content script: runs on the X bookmarks page — x.com/i/history, whose
// "Bookmarks" tab is what x.com/i/bookmarks now redirects to (twitter.com
// equivalent included).
// Scrapes visible bookmarked posts and streams them to the background worker.
// X has no public bookmarks-folder API, so folders live in the extension;
// this script only *reads* the bookmarks page DOM.

(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // x.com/i/history is tabbed (Bookmarks | Likes | …). Only the Bookmarks tab
  // holds saved posts, so never scrape whichever tab happens to be open.
  const BOOKMARKS_TABS = new Set(['/i/history', '/i/bookmarks']);

  function bookmarksTabActive() {
    const selected = document.querySelector('[role="tab"][aria-selected="true"]');
    const href = selected && selected.getAttribute('href');
    if (href) return BOOKMARKS_TABS.has(href.replace(/\/+$/, ''));
    // Older layout: the bookmarks timeline was the whole page, no tab strip.
    return /^\/i\/bookmarks\/?$/.test(location.pathname);
  }

  // The bookmarks header exposes folders through a collapsed dropdown: the
  // trigger is the "More" menu button in the same row as "Create Folder", and
  // the list only mounts once opened. Items are role=menuitemradio whose text is
  // the folder name; "All Bookmarks" is the unfiltered pseudo-entry. The markup
  // carries no folder ids, so `xapi.js` resolves names to ids for filing.
  const ALL_BOOKMARKS = 'All Bookmarks';

  function folderMenu() {
    for (const menu of document.querySelectorAll('[data-testid="Dropdown"]')) {
      const items = [...menu.querySelectorAll('[role="menuitemradio"]')];
      if (items.length) return items;
    }
    return null;
  }

  function foldersMenuTrigger() {
    const create = document.querySelector('button[aria-label="Create Folder"]');
    if (!create) return null;
    // The header row also holds the folder menu's "More" button. Pick the More
    // button whose common ancestor with it is smallest (= same row); page-wide
    // More buttons (sidebar, post menus) share only far larger ancestors.
    let best = null;
    let bestSize = Infinity;
    for (const button of document.querySelectorAll('button[aria-label="More"][aria-haspopup="menu"]')) {
      if (!button.getBoundingClientRect().width) continue;
      let node = create.parentElement;
      while (node && !node.contains(button)) node = node.parentElement;
      if (!node) continue;
      const size = node.querySelectorAll('*').length;
      if (size < bestSize) {
        bestSize = size;
        best = button;
      }
    }
    return best;
  }

  function closeFolderMenu(trigger) {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    if (!folderMenu()) return;
    // X menus also dismiss on an outside press; Escape alone is not guaranteed.
    const outside = document.querySelector('[data-testid="primaryColumn"]') || document.body;
    outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    outside.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    outside.click();
    if (folderMenu() && trigger) trigger.click();
  }

  /** Folder names as X renders them, or null when the page offers no folder UI. */
  async function readFolderNames() {
    let items = folderMenu();
    const trigger = items ? null : foldersMenuTrigger();
    if (!trigger && !items) return null;
    if (trigger) {
      trigger.click();
      for (let i = 0; i < 20 && !items; i++) {
        await sleep(150);
        items = folderMenu();
      }
      if (!items) return null;
      closeFolderMenu(trigger);
    }
    return items
      .map((el) => (el.innerText || '').trim())
      .filter((name) => name && name !== ALL_BOOKMARKS);
  }

  function scrapeVisible() {
    const out = [];
    document.querySelectorAll('article[data-testid="tweet"]').forEach((article) => {
      const link = article.querySelector('a[href*="/status/"]');
      if (!link) return;
      const m = link.getAttribute('href').match(/\/status\/(\d+)/);
      if (!m) return;
      const id = m[1];

      const textEl = article.querySelector('[data-testid="tweetText"]');
      const text = textEl ? textEl.innerText.trim() : '';

      let authorName = '';
      let authorHandle = '';
      const userNameEl = article.querySelector('[data-testid="User-Name"]');
      if (userNameEl) {
        const spans = [...userNameEl.querySelectorAll('span')]
          .map((s) => s.innerText.trim())
          .filter(Boolean);
        authorName = spans[0] || '';
        const handle = spans.find((s) => s.startsWith('@'));
        if (handle) authorHandle = handle;
      }

      out.push({ id, text, authorName, authorHandle, url: `https://x.com/i/status/${id}` });
    });
    return out;
  }

  async function scan(maxTweets) {
    if (!bookmarksTabActive()) {
      throw new Error('Open the Bookmarks tab at x.com/i/history first — this tab is not bookmarks.');
    }
    const seen = new Map();
    let stableRounds = 0;
    while (seen.size < maxTweets && stableRounds < 6) {
      const before = seen.size;
      for (const b of scrapeVisible()) {
        if (!seen.has(b.id)) seen.set(b.id, b);
      }
      send({ type: 'BOOKMARKS_SCRAPED', bookmarks: [...seen.values()], done: false });
      stableRounds = seen.size === before ? stableRounds + 1 : 0;
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(1800);
    }
    send({ type: 'BOOKMARKS_SCRAPED', bookmarks: [...seen.values()], done: true });
    window.scrollTo(0, 0);
    return [...seen.values()];
  }

  function send(msg) {
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch (_e) {
      /* extension reloaded mid-scan — ignore */
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'READ_FOLDERS') {
      readFolderNames()
        .then((names) => sendResponse({ ok: true, folders: names || [] }))
        .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
      return true;
    }
    if (msg.type === 'START_SCAN') {
      scan(msg.maxTweets || 400)
        .then((b) => sendResponse({ ok: true, count: b.length }))
        .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
      return true;
    }
    return false;
  });
})();
