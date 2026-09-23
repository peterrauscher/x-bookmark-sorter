// Options page: TypeSafe key, X account connection, sorting settings.
import * as xapi from './xapi.js';

const $ = (s) => document.querySelector(s);

document.addEventListener('DOMContentLoaded', () => {
  init().catch((e) => {
    const el = $('#initError');
    if (el) {
      el.textContent = 'Settings failed to load: ' + String((e && e.message) || e);
      el.hidden = false;
    }
  });
});

async function init() {
  const s = await chrome.storage.local.get([
    'typesafeApiKey',
    'xClientId',
    'settings',
    'xAccount',
    'xTokens',
  ]);
  if (s.typesafeApiKey) $('#apiKey').value = s.typesafeApiKey;
  if (s.xClientId) $('#xClientId').value = s.xClientId;

  const st = s.settings || {};
  $('#model').value = st.model || 'jev-latest';
  $('#threshold').value = st.confidenceThreshold != null ? st.confidenceThreshold : 0.2;
  $('#thresholdVal').textContent = Number($('#threshold').value).toFixed(2);
  $('#maxScan').value = st.maxScanTweets || 400;

  const callbackUrl = redirectUrl();
  $('#redirectUrl').textContent = callbackUrl || '(unavailable — reload the extension)';
  if (!identityReady()) {
    setStatus(
      '#xStatus',
      'Reload this extension on chrome://extensions: the identity permission is not in the loaded manifest yet, so Connect will fail.',
      false
    );
  }

  $('#toggleKey').onclick = () => {
    const el = $('#apiKey');
    el.type = el.type === 'password' ? 'text' : 'password';
  };
  $('#apiKey').onchange = async () => {
    await chrome.storage.local.set({ typesafeApiKey: $('#apiKey').value.trim() });
    setStatus('#keyStatus', 'Key saved in this browser.', true);
  };
  $('#copyRedirect').onclick = async () => {
    await navigator.clipboard.writeText(redirectUrl());
    setStatus('#xStatus', 'Callback URL copied — paste it into your X app settings.', true);
  };
  $('#xClientId').onchange = async () => {
    await chrome.storage.local.set({ xClientId: $('#xClientId').value.trim() });
    setStatus('#xStatus', 'Client ID saved.', true);
  };
  $('#connectX').onclick = onConnect;
  $('#disconnectX').onclick = onDisconnect;
  $('#threshold').oninput = () => {
    $('#thresholdVal').textContent = Number($('#threshold').value).toFixed(2);
  };
  $('#saveSettings').onclick = onSaveSettings;
  $('#clearData').onclick = onClearData;

  showAccount(s.xAccount, s.xTokens);
}

function setStatus(sel, msg, ok) {
  const el = $(sel);
  el.textContent = msg;
  el.className = 'status ' + (ok ? 'ok' : 'err');
}

// The `identity` permission only takes effect when the extension is reloaded,
// so a stale manifest leaves chrome.identity undefined. Derive the same URL from
// the extension id rather than showing an empty field.
function redirectUrl() {
  try {
    const url = chrome.identity && chrome.identity.getRedirectURL();
    if (url) return url;
  } catch (_e) {
    /* namespace missing — fall through to the derived URL */
  }
  return chrome.runtime && chrome.runtime.id ? `https://${chrome.runtime.id}.chromiumapp.org/` : '';
}

function identityReady() {
  return !!(chrome.identity && chrome.identity.launchWebAuthFlow);
}

function showAccount(account, tokens) {
  if (account && account.username && tokens && tokens.accessToken) {
    setStatus('#xStatus', `Connected as @${account.username}.`, true);
  }
}

async function onConnect() {
  const clientId = $('#xClientId').value.trim();
  if (!clientId) {
    setStatus('#xStatus', 'Paste your X app client ID first.', false);
    return;
  }
  if (!identityReady()) {
    setStatus('#xStatus', 'Reload this extension on chrome://extensions before connecting — the identity permission is missing.', false);
    return;
  }
  await chrome.storage.local.set({ xClientId: clientId });
  const redirectUri = redirectUrl();
  try {
    const { verifier, challenge } = await xapi.createPkce();
    const state = crypto.randomUUID();
    const authUrl = xapi.buildAuthorizeUrl({ clientId, redirectUri, state, challenge });
    const redirectUrl = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
    const code = xapi.readRedirect(redirectUrl, state);
    const tokens = await xapi.exchangeCodeForTokens({ clientId, code, codeVerifier: verifier, redirectUri });
    const me = await xapi.getMe(tokens.accessToken);
    await chrome.storage.local.set({
      xTokens: tokens,
      xAccount: { id: me.id, username: me.username, name: me.name },
    });
    setStatus('#xStatus', `Connected as @${me.username}.`, true);
  } catch (e) {
    setStatus('#xStatus', 'Connect failed: ' + String((e && e.message) || e), false);
  }
}

async function onDisconnect() {
  await chrome.storage.local.remove(['xTokens', 'xAccount']);
  setStatus('#xStatus', 'Disconnected — revoke access at x.com/settings/connected_apps if you want it gone.', true);
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
  if (!confirm('Delete all scanned bookmarks? Your X account and settings are untouched.')) return;
  await chrome.storage.local.set({ bookmarks: {} });
  alert('Bookmarks cleared.');
}
