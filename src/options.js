// Options page: API key, folders, sorting settings.

const $ = (s) => document.querySelector(s);

document.addEventListener('DOMContentLoaded', init);

async function init() {
  const s = await chrome.storage.local.get(['typesafeApiKey', 'folders', 'settings']);
  if (s.typesafeApiKey) $('#apiKey').value = s.typesafeApiKey;
  const st = s.settings || {};
  $('#model').value = st.model || 'jev-latest';
  $('#threshold').value = st.confidenceThreshold != null ? st.confidenceThreshold : 0.6;
  $('#thresholdVal').textContent = Number($('#threshold').value).toFixed(2);
  $('#maxScan').value = st.maxScanTweets || 400;

  $('#toggleKey').onclick = () => {
    const el = $('#apiKey');
    el.type = el.type === 'password' ? 'text' : 'password';
  };
  $('#apiKey').onchange = async () => {
    await chrome.storage.local.set({ typesafeApiKey: $('#apiKey').value.trim() });
    setStatus('#keyStatus', 'Key saved in this browser.', true);
  };
  $('#threshold').oninput = () => {
    $('#thresholdVal').textContent = Number($('#threshold').value).toFixed(2);
  };
  $('#saveSettings').onclick = onSaveSettings;
  $('#addFolder').onclick = onAddFolder;
  $('#clearData').onclick = onClearData;

  renderFolders(s.folders || []);
}

function setStatus(sel, msg, ok) {
  const el = $(sel);
  el.textContent = msg;
  el.className = 'status ' + (ok ? 'ok' : 'err');
}


function newId() {
  return 'f_' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
}

async function getFolders() {
  const { folders = [] } = await chrome.storage.local.get(['folders']);
  return folders;
}

async function renderFolders(folders) {
  const box = $('#folders');
  box.innerHTML = '';
  if (!folders.length) box.innerHTML = '<p class="hint">No folders yet — add your first one below.</p>';
  for (const f of folders) {
    const row = document.createElement('div');
    row.className = 'folder';
    row.innerHTML = `<input value="" data-k="name" maxlength="60"><input value="" data-k="desc" maxlength="200" placeholder="Description for Jev">`;
    const [nameEl, descEl] = row.querySelectorAll('input');
    nameEl.value = f.name;
    descEl.value = f.description || '';
    descEl.placeholder = 'Description for Jev (e.g. "AI papers, LLM tooling, ML news")';
    const save = async () => {
      const all = await getFolders();
      const ix = all.findIndex((x) => x.id === f.id);
      if (ix >= 0) {
        all[ix].name = nameEl.value.trim() || all[ix].name;
        all[ix].description = descEl.value.trim();
        await chrome.storage.local.set({ folders: all });
      }
    };
    nameEl.onchange = save;
    descEl.onchange = save;
    const del = document.createElement('button');
    del.textContent = 'Delete';
    del.onclick = async () => {
      if (!confirm(`Delete folder "${f.name}"? Its bookmarks go back to Unsorted.`)) return;
      const all = (await getFolders()).filter((x) => x.id !== f.id);
      await chrome.storage.local.set({ folders: all });
      const { bookmarks = {} } = await chrome.storage.local.get(['bookmarks']);
      for (const b of Object.values(bookmarks)) {
        if (b.folderId === f.id) {
          b.folderId = 'unsorted';
          b.needsReview = true;
        }
      }
      await chrome.storage.local.set({ bookmarks });
      renderFolders(all);
    };
    row.appendChild(del);
    box.appendChild(row);
  }
}

async function onAddFolder() {
  const name = $('#newFolderName').value.trim();
  const description = $('#newFolderDesc').value.trim();
  if (!name) return;
  const folders = await getFolders();
  folders.push({ id: newId(), name, description, createdAt: Date.now() });
  await chrome.storage.local.set({ folders });
  $('#newFolderName').value = '';
  $('#newFolderDesc').value = '';
  renderFolders(folders);
}

async function onSaveSettings() {
  await chrome.storage.local.set({
    settings: {
      model: $('#model').value.trim() || 'jev-latest',
      confidenceThreshold: Number($('#threshold').value),
      maxScanTweets: Math.max(50, Number($('#maxScan').value) || 400),
    },
  });
  setStatus('#settingsStatus', 'Settings saved.', true);
}

async function onClearData() {
  if (!confirm('Delete all scanned bookmarks? Folders and settings are kept.')) return;
  await chrome.storage.local.set({ bookmarks: {} });
  alert('Bookmarks cleared.');
}
