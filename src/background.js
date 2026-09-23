// Background service worker: bookmark storage, Jev classification, X API filing.
import { classifyBookmarks } from './jev.js';
import * as xapi from './xapi.js';

const DEFAULT_SETTINGS = {
  model: 'jev-latest',
  confidenceThreshold: 0.2,
  maxScanTweets: 400,
};

// Each Jev request carries this many bookmark-specific Choice questions.
const CLASSIFICATION_BATCH_SIZE = 20;
const CLASSIFICATION_CONCURRENCY = 3;


export function selectBestFolder(result, targetFolderIds, threshold = 0.2) {
  if (!result) return null;
  const known = targetFolderIds instanceof Set ? targetFolderIds : new Set(targetFolderIds);
  let bestId = null;
  let bestScore = -1;

  const probs = result.probabilities || {};
  for (const id of known) {
    const p = typeof probs[id] === 'number' ? probs[id] : 0;
    const c = result.choice === id && typeof result.confidence === 'number' ? result.confidence : 0;
    const score = Math.max(p, c);
    if (score > bestScore) {
      bestScore = score;
      bestId = id;
    }
  }

  if ((bestScore <= 0 || !bestId) && result.choice && known.has(result.choice)) {
    bestId = result.choice;
    bestScore = typeof result.confidence === 'number' ? result.confidence : 0;
  }

  if (bestId && bestScore >= threshold) {
    return { folderId: bestId, confidence: bestScore };
  }
  return null;
}
// Bookmark record:
// { id, text, authorName, authorHandle, url, replyTo, quote, linkCard,
//   folderId: null | 'unsorted' | <X bookmark folder id>, confidence, needsReview,
//   scannedAt, sortedAt, sortError }

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg.type === 'BOOKMARKS_SCRAPED') {
      const added = await mergeBookmarks(msg.bookmarks || []);
      notify({ type: 'BOOKMARKS_UPDATED', added, done: !!msg.done });
      sendResponse({ ok: true, added });
    } else if (msg.type === 'START_SORT') {
      const result = await autoSort(
        (done, total) => notify({ type: 'SORT_PROGRESS', done, total }),
        msg.folderNames || []
      );
      sendResponse({ ok: true, ...result });
    } else if (msg.type === 'FILE_BOOKMARK') {
      const result = await fileOne(msg.id, msg.folderId);
      notify({ type: 'BOOKMARKS_UPDATED', added: 0, done: true });
      sendResponse({ ok: true, ...result });
    } else if (msg.type === 'GET_STATE') {
      const state = await chrome.storage.local.get([
        'bookmarks',
        'folders',
        'settings',
        'xAccount',
      ]);
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
        replyTo: b.replyTo || null,
        quote: b.quote || null,
        linkCard: b.linkCard || null,
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
      if (b.replyTo) bookmarks[b.id].replyTo = b.replyTo;
      if (b.quote) bookmarks[b.id].quote = b.quote;
      if (b.linkCard) bookmarks[b.id].linkCard = b.linkCard;
    }
  }
  await chrome.storage.local.set({ bookmarks });
  return added;
}

/** Fresh access token, refreshing the 2-hour OAuth token when it is close to expiry. */
async function ensureAccessToken() {
  const { xTokens, xClientId } = await chrome.storage.local.get(['xTokens', 'xClientId']);
  if (!xTokens || !xTokens.accessToken) {
    throw new Error('Connect your X account in Settings before sorting.');
  }
  if (xTokens.expiresAt && xTokens.expiresAt - 60000 > Date.now()) return xTokens.accessToken;
  if (!xTokens.refreshToken || !xClientId) {
    throw new Error('X session expired — reconnect your X account in Settings.');
  }
  const fresh = await xapi.refreshAccessToken({ clientId: xClientId, refreshToken: xTokens.refreshToken });
  const next = {
    ...xTokens,
    ...fresh,
    refreshToken: fresh.refreshToken || xTokens.refreshToken,
  };
  await chrome.storage.local.set({ xTokens: next });
  return next.accessToken;
}

async function xAccountId() {
  const { xAccount } = await chrome.storage.local.get(['xAccount']);
  if (xAccount && xAccount.id) return xAccount.id;
  const me = await xapi.getMe(await ensureAccessToken());
  await chrome.storage.local.set({ xAccount: me });
  return me.id;
}

/**
 * Put posts into one X folder, then confirm they actually landed. X documents
 * `folder_id` only as "add the Post(s) to the folder" and says nothing about
 * posts that are already bookmarked, so a post that does not show up in the
 * folder is removed and re-added once before it is reported as a failure.
 *
 * @returns {Promise<{filed:string[], failed:Array<{id:string,detail:string}>}>}
 */
async function fileIntoFolder(token, accountId, ids, folderId) {
  const failed = new Map();
  const postErrors = new Map();

  const res = await xapi.addBookmarks(token, accountId, ids, folderId);
  for (const f of res.failed) {
    if (f.id) postErrors.set(f.id, f.detail);
  }

  const inFolder = await xapi.getFolderBookmarkIds(token, accountId, folderId);
  const filed = res.added.filter((id) => inFolder.has(id));
  const unplaced = ids.filter((id) => !filed.includes(id));

  // Already bookmarked elsewhere: DELETE clears the old placement, re-add files it.
  for (const id of unplaced) {
    try {
      await xapi.removeBookmark(token, accountId, id);
      await xapi.addBookmarks(token, accountId, [id], folderId);
    } catch (e) {
      if (e instanceof xapi.RateLimitError) throw e;
      failed.set(id, String((e && e.message) || e));
    }
  }

  if (unplaced.length) {
    const after = await xapi.getFolderBookmarkIds(token, accountId, folderId);
    for (const id of unplaced) {
      if (failed.has(id)) continue;
      if (after.has(id)) filed.push(id);
      else failed.set(id, postErrors.get(id) || 'X did not place this post in the folder.');
    }
  }

  return { filed, failed: [...failed].map(([id, detail]) => ({ id, detail })) };
}

async function autoSort(onProgress, folderNames) {
  const {
    typesafeApiKey,
    settings = {},
    bookmarks = {},
  } = await chrome.storage.local.get(['typesafeApiKey', 'settings', 'bookmarks']);

  if (!typesafeApiKey) {
    throw new Error('Missing TypeSafe API key — set it in the extension options first.');
  }

  const token = await ensureAccessToken();
  const accountId = await xAccountId();
  const xFolders = await xapi.getBookmarkFolders(token, accountId);
  if (!xFolders.length) {
    throw new Error('No bookmark folders on your X account yet — create one on x.com/i/history first.');
  }

  // Folder names come from the page the user is looking at; the API supplies the
  // ids, because X's folder markup carries names only.
  const byName = new Map(xFolders.map((f) => [f.name, f.id]));
  const fromPage = folderNames.filter(Boolean);
  let targets = xFolders;
  if (fromPage.length) {
    const unknown = fromPage.filter((name) => !byName.has(name));
    if (unknown.length) {
      throw new Error(`Your X account has no folder named: ${unknown.join(', ')}. Reload the bookmarks page and try again.`);
    }
    targets = fromPage.map((name) => ({ id: byName.get(name), name }));
  }

  const cfg = { ...DEFAULT_SETTINGS, ...settings };
  const known = new Set(xFolders.map((f) => f.id));
  const targetIds = new Set(targets.map((f) => f.id));
  const all = Object.values(bookmarks);
  const pending = all.filter((b) => !b.folderId || b.folderId === 'unsorted' || !known.has(b.folderId));
  if (!pending.length) return { total: 0, sorted: 0, review: 0, errors: 0, folders: targets.length };

  let sorted = 0;
  let review = 0;
  let errors = 0;
  const filed = {};

  let processed = 0;
  for (let i = 0; i < pending.length; i += CLASSIFICATION_BATCH_SIZE * CLASSIFICATION_CONCURRENCY) {
    const batches = [];
    for (let j = 0; j < CLASSIFICATION_CONCURRENCY; j++) {
      const start = i + j * CLASSIFICATION_BATCH_SIZE;
      const batch = pending.slice(start, start + CLASSIFICATION_BATCH_SIZE);
      if (batch.length) batches.push(batch);
    }

    const outcomes = await Promise.all(
      batches.map(async (batch) => {
        try {
          return { batch, results: await classifyBookmarks(typesafeApiKey, batch, targets, cfg.model) };
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
        const match = selectBestFolder(r, targetIds, cfg.confidenceThreshold);
        if (match) {
          b.folderId = match.folderId;
          b.confidence = match.confidence;
          b.needsReview = false;
          sorted++;
          (filed[match.folderId] = filed[match.folderId] || []).push(b.id);
        } else {
          b.folderId = 'unsorted';
          b.confidence = (r && typeof r.confidence === 'number') ? r.confidence : 0;
          b.needsReview = true;
          review++;
        }
        b.sortedAt = Date.now();
        delete b.sortError;
      }
    }

    processed += batches.reduce((count, batch) => count + batch.length, 0);
    await chrome.storage.local.set({ bookmarks, folders: targets });
    onProgress(processed, pending.length);
  }

  // File into X, one request per 25 posts per folder, then confirm placement.
  const assigned = new Set(Object.values(filed).flat());
  const confirmed = new Set();
  const details = new Map();
  let abortMessage = null;

  for (const [folderId, ids] of Object.entries(filed)) {
    for (let i = 0; i < ids.length; i += xapi.MAX_BATCH) {
      const chunk = ids.slice(i, i + xapi.MAX_BATCH);
      try {
        const outcome = await fileIntoFolder(token, accountId, chunk, folderId);
        for (const id of outcome.filed) confirmed.add(id);
        for (const f of outcome.failed) details.set(f.id, f.detail);
      } catch (e) {
        if (e instanceof xapi.RateLimitError) {
          const mins = Math.max(1, Math.ceil((e.resetAt - Date.now()) / 60000));
          abortMessage = `X rate limit reached — ${confirmed.size} of ${assigned.size} filed. Run the sort again in ~${mins} min.`;
          break;
        }
        for (const id of chunk) details.set(id, String((e && e.message) || e));
      }
    }
    if (abortMessage) break;
    onProgress(pending.length, pending.length);
  }

  // Jev picked a folder but X did not take the post: send it back to review so
  // the next run retries it instead of believing it is filed.
  for (const id of assigned) {
    if (confirmed.has(id)) continue;
    const b = bookmarks[id];
    if (!b) continue;
    b.folderId = 'unsorted';
    b.needsReview = true;
    b.sortError = details.get(id) || 'not filed into X yet';
    sorted--;
    review++;
    errors++;
  }
  await chrome.storage.local.set({ bookmarks, folders: targets });
  if (abortMessage) throw new Error(abortMessage);

  return { total: pending.length, sorted, review, errors, folders: targets.length };
}

/** Manual reassignment from the popup: move one bookmark into a folder. */
async function fileOne(id, folderId) {
  const { bookmarks = {} } = await chrome.storage.local.get(['bookmarks']);
  const b = bookmarks[id];
  if (!b) throw new Error('Unknown bookmark — rescan the page.');

  if (!folderId || folderId === 'unsorted') {
    b.folderId = 'unsorted';
    b.needsReview = true;
    delete b.sortError;
    await chrome.storage.local.set({ bookmarks });
    return { folderId: 'unsorted' };
  }

  const token = await ensureAccessToken();
  const accountId = await xAccountId();
  const outcome = await fileIntoFolder(token, accountId, [id], folderId);
  if (outcome.failed.length) {
    b.sortError = outcome.failed[0].detail;
    b.needsReview = true;
    await chrome.storage.local.set({ bookmarks });
    throw new Error(outcome.failed[0].detail);
  }
  b.folderId = folderId;
  b.needsReview = false;
  b.sortedAt = Date.now();
  delete b.sortError;
  await chrome.storage.local.set({ bookmarks });
  return { folderId };
}
