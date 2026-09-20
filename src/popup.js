// Popup: browse bookmarks by folder, trigger scans and Jev auto-sort.
const $ = (s) => document.querySelector(s);
let S = { bookmarks: {}, folders: [], settings: {} };
let activeTab = 'all';

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
    };
  }
  renderTabs();
  renderList();
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
      const st = await chrome.storage.local.get(['bookmarks']);
      const bm = st.bookmarks || {};
      if (bm[b.id]) {
        bm[b.id].folderId = sel.value;
        bm[b.id].needsReview = false;
        await chrome.storage.local.set({ bookmarks: bm });
      }
      await refresh();
    };
    list.appendChild(el);
  }
}

async function doScan() {
  setStatus('Looking for your X bookmarks tab…');
  const tabs = await chrome.tabs.query({
    url: ['https://x.com/i/bookmarks*', 'https://twitter.com/i/bookmarks*'],
  });
  let tab = tabs[0];
  if (!tab) {
    tab = await chrome.tabs.create({ url: 'https://x.com/i/bookmarks', active: true });
    setStatus('Opened X bookmarks — waiting for the page to load…');
    await new Promise((r) => setTimeout(r, 6000));
  } else {
    await chrome.tabs.update(tab.id, { active: true });
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
  setStatus('Asking Jev to file your bookmarks…');
  let resp;
  try {
    resp = await chrome.runtime.sendMessage({ type: 'START_SORT' });
  } catch (e) {
    resp = { ok: false, error: String((e && e.message) || e) };
  }
  if (resp && resp.ok) {
    setStatus(`Done — ${resp.sorted} filed, ${resp.review} need review, ${resp.errors} errors.`);
  } else {
    setStatus('Sort failed: ' + ((resp && resp.error) || 'unknown error'));
  }
  await refresh();
}
