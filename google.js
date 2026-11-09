// 구글 로그인(OAuth) · 유튜브 API · 구글 드라이브 동기화
import { CONFIG } from './config.js';

const TOKEN_KEY = 'pp-google-token';
const ACCOUNT_KEY = 'pp-google-account';
const OAUTH_STATE_KEY = 'pp-oauth-state';
const SYNC_FILE = 'playlist-player-state.json';
const SCOPES = [
  'openid', 'email',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/drive.appdata',
].join(' ');

export class AuthError extends Error {}

export function isConfigured() { return !!CONFIG.GOOGLE_CLIENT_ID; }

function readJSON(storage, key) { try { return JSON.parse(storage.getItem(key) || 'null'); } catch (e) { return null; } }
function writeJSON(storage, key, v) { try { v == null ? storage.removeItem(key) : storage.setItem(key, JSON.stringify(v)); } catch (e) {} }

export function account() { return readJSON(localStorage, ACCOUNT_KEY); } // {email} — 한 번 로그인했으면 남아 있어요
export function token() {
  const t = readJSON(localStorage, TOKEN_KEY);
  return t && t.exp - 60000 > Date.now() ? t.access : null;
}
export function signedIn() { return !!token(); }

function redirectUri() {
  return location.origin + location.pathname.replace(/index\.html$/, '');
}

// 구글 로그인 페이지로 이동했다가 앱으로 돌아와요. silent=true면 화면 없이 토큰만 다시 받아요.
export function signIn({ silent = false } = {}) {
  if (!isConfigured()) throw new Error('not-configured');
  const st = Math.random().toString(36).slice(2);
  writeJSON(sessionStorage, OAUTH_STATE_KEY, { st, silent });
  try { localStorage.setItem(OAUTH_STATE_KEY, st); } catch (e) {}
  const p = new URLSearchParams({
    client_id: CONFIG.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'token',
    scope: SCOPES,
    include_granted_scopes: 'true',
    state: st,
  });
  const acc = account();
  if (silent) p.set('prompt', 'none');
  if (acc?.email) p.set('login_hint', acc.email);
  location.assign('https://accounts.google.com/o/oauth2/v2/auth?' + p.toString());
}

export function signOut() {
  const t = readJSON(localStorage, TOKEN_KEY);
  writeJSON(localStorage, TOKEN_KEY, null);
  writeJSON(localStorage, ACCOUNT_KEY, null);
  if (t?.access) fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(t.access), { method: 'POST' }).catch(() => {});
}

// 로그인에서 돌아왔을 때 주소의 #access_token=... 처리. 결과: 'ok' | 'need-login' | null
export function handleRedirect() {
  const hash = location.hash.startsWith('#') ? location.hash.slice(1) : '';
  if (!hash || (!hash.includes('access_token=') && !hash.includes('error='))) return null;
  const p = new URLSearchParams(hash);
  history.replaceState(null, '', location.pathname + location.search);
  const saved = readJSON(sessionStorage, OAUTH_STATE_KEY);
  let expected = saved?.st;
  if (!expected) { try { expected = localStorage.getItem(OAUTH_STATE_KEY); } catch (e) {} }
  writeJSON(sessionStorage, OAUTH_STATE_KEY, null);
  try { localStorage.removeItem(OAUTH_STATE_KEY); } catch (e) {}
  if (!expected || p.get('state') !== expected) return null;
  if (p.get('error')) return 'need-login';
  const access = p.get('access_token');
  const sec = parseInt(p.get('expires_in') || '3600', 10);
  writeJSON(localStorage, TOKEN_KEY, { access, exp: Date.now() + sec * 1000 });
  return 'ok';
}

async function api(url, opts = {}) {
  const t = token();
  if (!t) throw new AuthError('no-token');
  const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + t } });
  if (res.status === 401) { writeJSON(localStorage, TOKEN_KEY, null); throw new AuthError('expired'); }
  if (!res.ok) throw new Error('api-' + res.status);
  return res;
}

export async function loadAccount() {
  const r = await api('https://www.googleapis.com/oauth2/v3/userinfo');
  const u = await r.json();
  writeJSON(localStorage, ACCOUNT_KEY, { email: u.email || '', picture: u.picture || '' });
  return account();
}

// ---- 유튜브 ----
const YT = 'https://www.googleapis.com/youtube/v3/';

async function ytGet(path, params) {
  const p = new URLSearchParams(params);
  if (token()) return (await api(YT + path + '?' + p)).json();
  if (CONFIG.YOUTUBE_API_KEY) {
    p.set('key', CONFIG.YOUTUBE_API_KEY);
    const res = await fetch(YT + path + '?' + p);
    if (!res.ok) throw new Error('api-' + res.status);
    return res.json();
  }
  throw new AuthError('no-token');
}

export function canUseYouTubeApi() { return !!token() || !!CONFIG.YOUTUBE_API_KEY; }

export async function myPlaylists() {
  const out = [];
  let pageToken = '';
  do {
    const d = await ytGet('playlists', { part: 'snippet,contentDetails', mine: 'true', maxResults: '50', ...(pageToken ? { pageToken } : {}) });
    (d.items || []).forEach(it => out.push({ id: it.id, title: it.snippet?.title || '재생목록', count: it.contentDetails?.itemCount || 0, thumb: it.snippet?.thumbnails?.medium?.url || '' }));
    pageToken = d.nextPageToken || '';
  } while (pageToken);
  return out;
}

export async function playlistTitle(listId) {
  const d = await ytGet('playlists', { part: 'snippet', id: listId });
  return d.items?.[0]?.snippet?.title || '';
}

export async function playlistItems(listId, onProgress) {
  const tracks = [];
  let pageToken = '';
  do {
    const d = await ytGet('playlistItems', { part: 'snippet,contentDetails,status', playlistId: listId, maxResults: '50', ...(pageToken ? { pageToken } : {}) });
    (d.items || []).forEach(it => {
      const id = it.contentDetails?.videoId || it.snippet?.resourceId?.videoId;
      const title = it.snippet?.title || '';
      if (!id || title === 'Deleted video' || title === 'Private video') return;
      tracks.push({ id, title });
    });
    onProgress?.(tracks.length, d.pageInfo?.totalResults || 0);
    pageToken = d.nextPageToken || '';
  } while (pageToken);
  return tracks;
}

// 영상 길이(초) — 50개씩
function isoSeconds(iso) {
  const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || '');
  if (!m) return 0;
  return (+(m[1] || 0)) * 86400 + (+(m[2] || 0)) * 3600 + (+(m[3] || 0)) * 60 + (+(m[4] || 0));
}
export async function videoDurations(ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += 50) {
    const d = await ytGet('videos', { part: 'contentDetails', id: ids.slice(i, i + 50).join(','), maxResults: '50' });
    (d.items || []).forEach(it => { const sec = isoSeconds(it.contentDetails?.duration); if (sec) out[it.id] = sec; });
  }
  return out;
}

// ---- 구글 드라이브(앱 전용 숨김 폴더)에 상태 저장 ----
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
let fileId = null;

async function findFile() {
  if (fileId) return fileId;
  const q = encodeURIComponent(`name='${SYNC_FILE}'`);
  const d = await (await api(`${DRIVE}?spaces=appDataFolder&q=${q}&fields=files(id,modifiedTime)`)).json();
  fileId = d.files?.[0]?.id || null;
  return fileId;
}

export async function pullState() {
  const id = await findFile();
  if (!id) return null;
  const r = await api(`${DRIVE}/${id}?alt=media`);
  try { return await r.json(); } catch (e) { return null; }
}

export async function pushState(state) {
  const body = JSON.stringify(state);
  const id = await findFile();
  if (id) {
    await api(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body,
    });
    return;
  }
  const boundary = 'pp' + Math.random().toString(36).slice(2);
  const meta = JSON.stringify({ name: SYNC_FILE, parents: ['appDataFolder'] });
  const multipart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
  const r = await api('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body: multipart,
  });
  fileId = (await r.json()).id || null;
}
