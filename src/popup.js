// Popup: browse bookmarks by folder, trigger scans and Jev auto-sort.
const $ = (s) => document.querySelector(s);
let S = { bookmarks: {}, folders: [], settings: {}, xAccount: null };
let activeTab = 'all';

// X moved bookmarks to the History page's "Bookmarks" tab; x.com/i/bookmarks is
// the pre-2026 path and now redirects there. Its sibling tab (/i/history/likes)
// is not bookmarks, so match either path exactly — never the Likes tab.
const BOOKMARKS_PAGE = 'https://x.com/i/history';
const BOOKMARKS_TAB_URL = /^https?:\/\/(?:x|twitter)\.com\/i\/(?:history|bookmarks)\/?(?:[?#]|$)/;

document.addEventListener('DOMContentLoaded', init);

async function init() {
  await refresh();
  $('#scanBtn').addEventListener('click', doScan);
  $('#sortBtn').addEventListener('click', doSort);
  $('#settingsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());
  chrome.runtime.onMessage.addListener((m) => {
    if (m.type === 'SORT_PROGRESS') setStatus(`Sorting… ${m.done}/${m.total}`);
    if (m.type === 'BOOKMARKS_UPDATED') refresh();
  });
}

async function refresh() {
  const res = await chrome.runtime.sendMessage({ type: 'GET_STATE' }).catch(() => null);
  if (res && res.ok) {
    S = {
      bookmarks: res.state.bookmarks || {},
      folders: res.state.folders || [],
      settings: res.state.settings || {},
      xAccount: res.state.xAccount || null,
    };
  }
  renderTabs();
  renderList();
  if (!S.xAccount && !$('#status').textContent) {
    setStatus('Connect your X account in Settings (⚙) before sorting.');
  }
}

function setStatus(t) {
  $('#status').textContent = t || '';
}

function counts() {
  const all = Object.values(S.bookmarks);
  return {
    all: all.length,
    unsorted: all.filter((b) => !b.folderId || b.folderId === 'unsorted').length,
    review: all.filter((b) => b.needsReview).length,
  };
}

function renderTabs() {
  const c = counts();
  const tabs = [
    { id: 'all', label: `All (${c.all})` },
    { id: 'unsorted', label: `Unsorted (${c.unsorted})` },
    { id: 'review', label: `Review (${c.review})` },
    ...S.folders.map((f) => ({
      id: f.id,
      label: `${f.name} (${Object.values(S.bookmarks).filter((b) => b.folderId === f.id).length})`,
    })),
  ];
  const nav = $('#tabs');
  nav.innerHTML = '';
  for (const t of tabs) {
    const b = document.createElement('button');
    b.textContent = t.label;
    b.className = t.id === activeTab ? 'tab active' : 'tab';
    b.onclick = () => {
      activeTab = t.id;
      renderTabs();
      renderList();
    };
    nav.appendChild(b);
  }
}

function filtered() {
  const all = Object.values(S.bookmarks).sort((a, b) => (b.scannedAt || 0) - (a.scannedAt || 0));
  if (activeTab === 'all') return all;
  if (activeTab === 'unsorted') return all.filter((b) => !b.folderId || b.folderId === 'unsorted');
  if (activeTab === 'review') return all.filter((b) => b.needsReview);
  return all.filter((b) => b.folderId === activeTab);
}

function esc(s) {
  return String(s == null ? '' : s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function renderList() {
  const list = $('#list');
  const items = filtered();
  list.innerHTML = '';
  if (!items.length) {
    list.innerHTML =
      '<p class="empty">Nothing here yet. Open your X bookmarks page, hit “Scan X bookmarks”, then “Auto-sort with Jev”.</p>';
    return;
  }
  for (const b of items.slice(0, 300)) {
    const el = document.createElement('div');
    el.className = 'card' + (b.needsReview ? ' review' : '');
    const conf =
      typeof b.confidence === 'number'
        ? `<span class="conf" title="Jev confidence">${Math.round(b.confidence * 100)}%</span>`
        : '';
    el.innerHTML = `
      <div class="meta"><strong>${esc(b.authorName || b.authorHandle || 'Unknown')}</strong>${conf}
        ${b.needsReview ? '<span class="badge">needs review</span>' : ''}</div>
      <div class="text">${esc((b.text || '(no text — media post)').slice(0, 220))}</div>
      <div class="row"><select class="folderSel" title="Folder"></select>
      <a class="open" target="_blank" rel="noopener">Open ↗</a></div>`;
    el.querySelector('.open').href = b.url;
    const sel = el.querySelector('.folderSel');
    for (const o of [{ id: 'unsorted', name: 'Unsorted' }, ...S.folders]) {
      const op = document.createElement('option');
      op.value = o.id;
      op.textContent = o.name;
      if ((b.folderId || 'unsorted') === o.id) op.selected = true;
      sel.appendChild(op);
    }
    sel.onchange = async () => {
      sel.disabled = true;
      const res = await chrome.runtime
        .sendMessage({ type: 'FILE_BOOKMARK', id: b.id, folderId: sel.value })
        .catch(() => null);
      sel.disabled = false;
      if (!res || !res.ok) setStatus('Could not move that bookmark: ' + ((res && res.error) || 'unknown error'));
      else setStatus(res.folderId === 'unsorted' ? 'Moved to Unsorted.' : 'Moved in X.');
      await refresh();
    };
    list.appendChild(el);
  }
}

/** The user's bookmarks tab, opening one if needed. */
async function bookmarksTab() {
  const tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
  const existing = tabs.find((t) => BOOKMARKS_TAB_URL.test(t.url || ''));
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    return existing;
  }
  return null;
}

async function doScan() {
  setStatus('Looking for your X bookmarks tab…');
  let tab = await bookmarksTab();
  if (!tab) {
    tab = await chrome.tabs.create({ url: BOOKMARKS_PAGE, active: true });
    setStatus('Opened x.com/i/history — waiting for the page to load…');
    await new Promise((r) => setTimeout(r, 6000));
  }
  setStatus('Scanning — scrolling through your bookmarks…');
  const max = (S.settings && S.settings.maxScanTweets) || 400;
  let resp;
  try {
    resp = await chrome.tabs.sendMessage(tab.id, { type: 'START_SCAN', maxTweets: max });
  } catch (e) {
    resp = { ok: false, error: 'content script unreachable — reload the X tab and try again' };
  }
  if (resp && resp.ok) {
    setStatus(`Scan complete — ${resp.count} bookmarks saved.`);
  } else {
    setStatus('Scan failed: ' + ((resp && resp.error) || 'unknown error'));
  }
  await refresh();
}

async function doSort() {
  // Folder options come from the page the user is looking at; the background
  // worker resolves them to X folder ids for filing.
  setStatus('Reading your X folders…');
  const tab = await bookmarksTab();
  let folderNames = [];
  if (tab) {
    const page = await chrome.tabs
      .sendMessage(tab.id, { type: 'READ_FOLDERS' })
      .catch(() => null);
    folderNames = (page && page.ok && page.folders) || [];
  }
  setStatus('Asking Jev to file your bookmarks…');
  let resp;
  try {
    resp = await chrome.runtime.sendMessage({ type: 'START_SORT', folderNames });
  } catch (e) {
    resp = { ok: false, error: String((e && e.message) || e) };
  }
  if (resp && resp.ok) {
    setStatus(`Done — ${resp.sorted} filed into X, ${resp.review} need review, ${resp.errors} errors.`);
  } else {
    setStatus('Sort failed: ' + ((resp && resp.error) || 'unknown error'));
  }
  await refresh();
}
