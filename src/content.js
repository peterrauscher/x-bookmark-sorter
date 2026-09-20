// Content script: runs on x.com/i/bookmarks (and twitter.com equivalent).
// Scrapes visible bookmarked posts and streams them to the background worker.
// X has no public bookmarks-folder API, so folders live in the extension;
// this script only *reads* the bookmarks page DOM.

(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    if (msg.type === 'START_SCAN') {
      scan(msg.maxTweets || 400)
        .then((b) => sendResponse({ ok: true, count: b.length }))
        .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
      return true;
    }
    return false;
  });
})();
