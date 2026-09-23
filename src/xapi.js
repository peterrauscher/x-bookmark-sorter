// X API v2 client for bookmark folders — OAuth 2.0 PKCE + the documented
// bookmark endpoints (docs.x.com/x-api/posts/bookmarks):
//
//   GET    /2/users/:id/bookmarks/folders              list folders (id + name)
//   GET    /2/users/:id/bookmarks/folders/:folder_id   post ids inside a folder
//   POST   /2/users/:id/bookmarks                      { tweet_id | tweet_ids, folder_id? }
//   DELETE /2/users/:id/bookmarks/:tweet_id            remove a bookmark
//
// This module deliberately never touches x.com's private GraphQL: the X Terms
// of Service bar access "other than through the currently available, published
// interfaces", and the Automation Rules attach permanent suspension to
// "non-API-based forms of automation, such as scripting the X website".
// Reading the page DOM is how the user's own view is read; writing goes here.

const AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize';
const TOKEN_URL = 'https://api.x.com/2/oauth2/token';
const API = 'https://api.x.com/2';

// Public client (Native App / Single-page App) — no client secret, PKCE only.
export const SCOPES = [
  'tweet.read',
  'users.read',
  'bookmark.read',
  'bookmark.write',
  'offline.access',
];

// Documented ceilings: writes 50/15min, folder reads 50/15min, bookmark reads
// 180/15min. One POST carries up to 25 post ids, so a full sort costs roughly
// one request per 25 posts per folder.
export const MAX_BATCH = 25;
export const RATE_WINDOW_MS = 15 * 60 * 1000;

export class RateLimitError extends Error {
  constructor(message, resetAt) {
    super(message);
    this.name = 'RateLimitError';
    this.resetAt = resetAt;
  }
}

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

function base64Url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** PKCE verifier + S256 challenge (RFC 7636). */
export async function createPkce() {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

export function buildAuthorizeUrl({ clientId, redirectUri, state, challenge }) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: SCOPES.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `${AUTHORIZE_URL}?${params}`;
}

/** Pull `code` out of the chromiumapp.org redirect and verify our CSRF state. */
export function readRedirect(redirectUrl, expectedState) {
  const url = new URL(redirectUrl);
  const error = url.searchParams.get('error');
  if (error) throw new Error(`X authorization failed: ${error}`);
  if (url.searchParams.get('state') !== expectedState) {
    throw new Error('X authorization state mismatch — start the connection again.');
  }
  const code = url.searchParams.get('code');
  if (!code) throw new Error('X did not return an authorization code.');
  return code;
}

async function postToken(body) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    credentials: 'omit',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const text = await res.text();
  if (!res.ok) throw new ApiError(`X token request failed (${res.status}): ${text.slice(0, 200)}`, res.status, text);
  const data = JSON.parse(text);
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    expiresAt: Date.now() + (data.expires_in || 7200) * 1000,
  };
}

export function exchangeCodeForTokens({ clientId, code, codeVerifier, redirectUri }) {
  return postToken({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
}

export function refreshAccessToken({ clientId, refreshToken }) {
  return postToken({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId });
}

async function apiFetch(path, { token, method = 'GET', body, query } = {}) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(query || {})) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    method,
    credentials: 'omit',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (res.status === 429) {
    const reset = Number(res.headers.get('x-rate-limit-reset'));
    const resetAt = Number.isFinite(reset) && reset > 0 ? reset * 1000 : Date.now() + RATE_WINDOW_MS;
    throw new RateLimitError('X rate limit reached — try again after the window resets.', resetAt);
  }

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_e) {
    /* non-JSON error body — surfaced below via `text` */
  }
  if (!res.ok) {
    const detail = (data && (data.detail || data.title)) || text.slice(0, 200);
    throw new ApiError(`X API ${res.status}: ${detail}`, res.status, data || text);
  }
  return data || {};
}

/** @returns {Promise<{id:string,username:string}>} */
export async function getMe(token) {
  const data = await apiFetch('/users/me', { token });
  if (!data.data || !data.data.id) throw new ApiError('X API returned no user for /users/me', 200, data);
  return data.data;
}

/** Bookmark folders, in X's order. @returns {Promise<Array<{id:string,name:string}>>} */
export async function getBookmarkFolders(token, userId) {
  const folders = [];
  let paginationToken = null;
  for (let page = 0; page < 5; page++) {
    const data = await apiFetch(`/users/${userId}/bookmarks/folders`, {
      token,
      query: { max_results: 100, pagination_token: paginationToken },
    });
    for (const f of data.data || []) folders.push({ id: String(f.id), name: f.name });
    paginationToken = (data.meta && data.meta.next_token) || null;
    if (!paginationToken) break;
  }
  return folders;
}

/** Post ids currently inside one folder (first 500). @returns {Promise<Set<string>>} */
export async function getFolderBookmarkIds(token, userId, folderId) {
  const ids = new Set();
  let paginationToken = null;
  for (let page = 0; page < 5; page++) {
    const data = await apiFetch(`/users/${userId}/bookmarks/folders/${folderId}`, {
      token,
      query: { max_results: 100, pagination_token: paginationToken },
    });
    for (const t of data.data || []) ids.add(String(t.id));
    paginationToken = (data.meta && data.meta.next_token) || null;
    if (!paginationToken) break;
  }
  return ids;
}

/**
 * Add posts to a folder (or to the top-level bookmarks when folderId is null).
 * @returns {Promise<{added:string[], failed:Array<{id:string,detail:string}>}>}
 */
export async function addBookmarks(token, userId, tweetIds, folderId) {
  const body = tweetIds.length === 1 ? { tweet_id: tweetIds[0] } : { tweet_ids: tweetIds };
  if (folderId) body.folder_id = folderId;

  const data = await apiFetch(`/users/${userId}/bookmarks`, { token, method: 'POST', body });
  const failed = (data.errors || []).map((e) => ({
    id: String(e.tweet_id || e.value || ''),
    detail: e.detail || e.title || 'unknown error',
  }));
  const failedIds = new Set(failed.map((f) => f.id));
  const added = Array.isArray(data.data)
    ? data.data.map((d) => String(d.tweet_id)).filter((id) => id && !failedIds.has(id))
    : tweetIds.filter((id) => !failedIds.has(id));
  return { added, failed };
}

export async function removeBookmark(token, userId, tweetId) {
  await apiFetch(`/users/${userId}/bookmarks/${tweetId}`, { token, method: 'DELETE' });
}
