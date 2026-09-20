// Background service worker: bookmark storage + Jev auto-sort orchestration.
import { classifyBookmarks } from './jev.js';

const DEFAULT_SETTINGS = {
  model: 'jev-latest',
  confidenceThreshold: 0.6,
  maxScanTweets: 400,
};

// Each Jev request carries this many bookmark-specific Choice questions.
const CLASSIFICATION_BATCH_SIZE = 20;
const CLASSIFICATION_CONCURRENCY = 3;

// Bookmark record:
// { id, text, authorName, authorHandle, url,
//   folderId: null | 'unsorted' | <folderId>, confidence, needsReview,
//   scannedAt, sortedAt, sortError }

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg.type === 'BOOKMARKS_SCRAPED') {
      const added = await mergeBookmarks(msg.bookmarks || []);
      notify({ type: 'BOOKMARKS_UPDATED', added, done: !!msg.done });
      sendResponse({ ok: true, added });
    } else if (msg.type === 'START_SORT') {
      const result = await autoSort((done, total) => notify({ type: 'SORT_PROGRESS', done, total }));
      sendResponse({ ok: true, ...result });
    } else if (msg.type === 'GET_STATE') {
      const state = await chrome.storage.local.get(['bookmarks', 'folders', 'settings']);
      sendResponse({ ok: true, state });
    } else {
      sendResponse({ ok: false, error: 'unknown message' });
    }
  })().catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true; // async response
});

function notify(msg) {
  try {
    chrome.runtime.sendMessage(msg).catch(() => {});
  } catch (_e) {
    /* no listeners (popup closed) — fine */
  }
}

async function mergeBookmarks(list) {
  const { bookmarks = {} } = await chrome.storage.local.get(['bookmarks']);
  let added = 0;
  for (const b of list) {
    if (!b || !b.id) continue;
    if (!bookmarks[b.id]) {
      bookmarks[b.id] = {
        id: b.id,
        text: b.text || '',
        authorName: b.authorName || '',
        authorHandle: b.authorHandle || '',
        url: b.url || `https://x.com/i/status/${b.id}`,
        folderId: null,
        confidence: null,
        needsReview: false,
        scannedAt: Date.now(),
      };
      added++;
    } else {
      // Refresh content, keep the user's/filing assignment.
      if (b.text) bookmarks[b.id].text = b.text;
      if (b.url) bookmarks[b.id].url = b.url;
      if (b.authorName) bookmarks[b.id].authorName = b.authorName;
      if (b.authorHandle) bookmarks[b.id].authorHandle = b.authorHandle;
    }
  }
  await chrome.storage.local.set({ bookmarks });
  return added;
}

async function autoSort(onProgress) {
  const { typesafeApiKey, folders = [], settings = {}, bookmarks = {} } =
    await chrome.storage.local.get(['typesafeApiKey', 'folders', 'settings', 'bookmarks']);

  if (!typesafeApiKey) {
    throw new Error('Missing TypeSafe API key — set it in the extension options first.');
  }
  if (!folders.length) {
    throw new Error('Create at least one folder in the extension options first.');
  }

  const cfg = { ...DEFAULT_SETTINGS, ...settings };
  const targets = Object.values(bookmarks).filter((b) => !b.folderId || b.folderId === 'unsorted');
  if (!targets.length) return { total: 0, sorted: 0, review: 0, errors: 0 };

  let sorted = 0;
  let review = 0;
  let errors = 0;

  let processed = 0;
  for (
    let i = 0;
    i < targets.length;
    i += CLASSIFICATION_BATCH_SIZE * CLASSIFICATION_CONCURRENCY
  ) {
    const batches = [];
    for (let j = 0; j < CLASSIFICATION_CONCURRENCY; j++) {
      const start = i + j * CLASSIFICATION_BATCH_SIZE;
      const batch = targets.slice(start, start + CLASSIFICATION_BATCH_SIZE);
      if (batch.length) batches.push(batch);
    }

    const outcomes = await Promise.all(
      batches.map(async (batch) => {
        try {
          return {
            batch,
            results: await classifyBookmarks(typesafeApiKey, batch, folders, cfg.model),
          };
        } catch (error) {
          return { batch, error };
        }
      })
    );

    for (const { batch, results, error } of outcomes) {
      if (error) {
        const message = String((error && error.message) || error);
        for (const b of batch) {
          errors++;
          b.sortError = message;
        }
        continue;
      }

      for (let j = 0; j < batch.length; j++) {
        const b = batch[j];
        const r = results[j];
        if (r.choice !== 'unsorted' && r.confidence >= cfg.confidenceThreshold) {
          b.folderId = r.choice;
          b.confidence = r.confidence;
          b.needsReview = false;
          sorted++;
        } else {
          b.folderId = 'unsorted';
          b.confidence = r.confidence;
          b.needsReview = true;
          review++;
        }
        b.sortedAt = Date.now();
        delete b.sortError;
      }
    }

    processed += batches.reduce((count, batch) => count + batch.length, 0);
    await chrome.storage.local.set({ bookmarks });
    onProgress(processed, targets.length);
  }

  return { total: targets.length, sorted, review, errors };
}
