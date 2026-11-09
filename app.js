import * as S from './store.js';
import * as G from './google.js';
import * as I from './importer.js';
import { Player, STATE } from './player.js';
import { skipSeconds, describeRules, episodeOf, SKIP_RULES } from './skip.js';
import { MJG_PLAYLIST, APP_VERSION } from './config.js';
import { icon } from './icons.js';

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const thumb = id => `https://i.ytimg.com/vi/${encodeURIComponent(id)}/mqdefault.jpg`;
const fmt = sec => { sec = Math.max(0, Math.floor(sec || 0)); const m = Math.floor(sec / 60), s = sec % 60; return `${m}:${String(s).padStart(2, '0')}`; };

let view = { name: 'library' };
let player = null;
let loadToken = 0;       // 영상을 새로 띄울 때마다 +1
let skippedToken = -1;   // 엔딩 스킵을 이미 한 영상(loadToken)
let lastSaveAt = 0;
let lastTickAt = 0;
let importJob = null;    // {listId, text}
let myLists = null;      // 구글 계정의 유튜브 재생목록
let myListsLoading = false;
let sync = { status: 'off', at: 0, msg: '' };
let scrollToCurrent = false;
const pendingTitles = new Map(); // ytListId -> {videoId: title}

// ---------- 공통 ----------
function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), ms);
}

function currentPlaylist() { const c = S.get().current; return c ? S.playlistById(c.playlistId) : null; }
function currentTrack() {
  const c = S.get().current; if (!c) return null;
  const pl = S.playlistById(c.playlistId);
  return pl?.tracks.find(t => t.id === c.videoId) || { id: c.videoId, title: '' };
}
function currentIndex() {
  const c = S.get().current; const pl = currentPlaylist();
  return pl && c ? pl.tracks.findIndex(t => t.id === c.videoId) : -1;
}
function trackTitle(t) { return t?.title || '제목 불러오는 중…'; }

function skipFor(pl, track) {
  if (!S.get().settings.skipEnding) return null;
  const title = track?.title || (player && player.dataId() === track?.id ? player.title() : '');
  return skipSeconds(pl?.ytId, title);
}

// ---------- 재생 ----------
function resumePoint(pl, track) {
  const p = S.get().positions[track.id];
  if (!p || p.done || !p.t) return 0;
  const sk = skipSeconds(pl?.ytId, track.title) || 0;
  if (p.t > 5 && (!p.d || p.t < p.d - sk - 3)) return p.t;
  return 0;
}

function playTrack(playlistId, videoId, { autoplay = true, fromStart = false } = {}) {
  const pl = S.playlistById(playlistId); if (!pl) return;
  const track = pl.tracks.find(t => t.id === videoId); if (!track) return;
  savePosition(true);
  const start = fromStart ? 0 : resumePoint(pl, track);
  const now = Date.now();
  S.update(s => {
    if (s.positions[videoId]?.done) s.positions[videoId] = { ...s.positions[videoId], done: false, t: 0, at: now, seen: true };
    s.current = { playlistId, videoId, at: now };
    s.lastByPlaylist[playlistId] = { videoId, at: now };
    s.history = [{ id: videoId, title: track.title, playlistId, at: now }, ...s.history.filter(h => h.id !== videoId)].slice(0, 100);
  });
  loadToken++;
  player.load(videoId, start, autoplay);
  if (start > 0) toast(`${fmt(start)}부터 이어서 재생해요`);
}

function markDone(id) {
  const d = player?.duration() || 0;
  S.update(s => { s.positions[id] = { t: 0, d, done: true, at: Date.now() }; }, { render: false });
}

// 다음 화로. 넘어갔으면 true
function next({ auto = false } = {}) {
  const pl = currentPlaylist(); const i = currentIndex();
  if (!pl || !pl.tracks.length) return false;
  const st = S.get().settings;
  const n = pl.tracks.length;
  let ni;
  if (st.shuffle && n > 1) { do { ni = Math.floor(Math.random() * n); } while (ni === i); }
  else ni = i + 1;
  if (ni >= n) {
    if (st.repeat) ni = 0;
    else { if (auto) toast('재생목록의 마지막 영상이에요'); return false; }
  }
  if (auto && i >= 0) markDone(pl.tracks[i].id);
  playTrack(pl.id, pl.tracks[ni].id, { autoplay: true });
  return true;
}

function prev() {
  const pl = currentPlaylist(); const i = currentIndex();
  if (!pl) return;
  if (player.time() > 5 || i <= 0) { player.seek(0); return; }
  playTrack(pl.id, pl.tracks[i - 1].id, { autoplay: true, fromStart: true });
}

function togglePlay() {
  if (!S.get().current) { resumeLibraryFirst(); return; }
  if (player.state === STATE.PLAYING || player.state === STATE.BUFFERING) { player.pause(); return; }
  player.play();
  setTimeout(() => {
    if (player.state !== STATE.PLAYING && player.state !== STATE.BUFFERING)
      toast('아이폰·아이패드는 처음 한 번은 영상 화면을 직접 눌러야 재생돼요', 3500);
  }, 1500);
}

function resumeLibraryFirst() {
  const pl = S.livePlaylists()[0];
  if (pl) resumePlaylist(pl.id); else toast('먼저 재생목록을 추가해 주세요');
}

function resumePlaylist(id, { fromStart = false } = {}) {
  const pl = S.playlistById(id); if (!pl || !pl.tracks.length) return;
  if (fromStart) { playTrack(id, pl.tracks[0].id, { fromStart: true }); return; }
  const last = S.get().lastByPlaylist[id];
  let track = last && pl.tracks.find(t => t.id === last.videoId);
  // 마지막 화를 다 봤으면 그다음 화부터
  if (track && S.get().positions[track.id]?.done) {
    const i = pl.tracks.indexOf(track);
    if (i + 1 < pl.tracks.length) track = pl.tracks[i + 1];
  }
  playTrack(id, (track || pl.tracks[0]).id);
}

function savePosition(force = false) {
  const c = S.get().current;
  if (!player?.ready || !c || player.dataId() !== c.videoId) return;
  if (!force && Date.now() - lastSaveAt < 5000) return;
  const t = player.time(), d = player.duration();
  if (!d) return;
  lastSaveAt = Date.now();
  const prevPos = S.get().positions[c.videoId];
  if (prevPos?.done) return; // 다 본 영상은 다시 볼 때 새로 시작하면서 지워져요
  S.update(s => { s.positions[c.videoId] = { t, d, done: false, at: Date.now() }; }, { render: false });
}

// ---------- 엔딩 자동 스킵 ----------
const cover = { on: false };
function showCover() { cover.on = true; $('#cover').classList.add('show'); }
function hideCover() { cover.on = false; $('#cover').classList.remove('show'); }

function tick() {
  if (!player?.ready) return;
  const c = S.get().current; if (!c) return;
  if (player.state === STATE.PLAYING) savePosition();
  if (player.state !== STATE.PLAYING) return;
  if (player.dataId() && player.dataId() !== c.videoId) return;
  const pl = currentPlaylist(); const track = currentTrack();
  const sk = skipFor(pl, track); if (sk == null) return;
  const d = player.duration(); if (!d || d < sk + 5) return;
  // 다음 확인까지 흐를 시간만큼 미리 봐서, 늦지 않게 넘겨요
  const now = performance.now();
  const ahead = lastTickAt ? Math.min(0.1, ((now - lastTickAt) / 1000) * player.rate()) : 0;
  lastTickAt = now;
  const left = d - player.time() - ahead;
  if (left > sk + 1 && skippedToken === loadToken) skippedToken = -1; // 앞으로 되감았으면 다시 작동
  if (left <= sk && skippedToken !== loadToken) {
    skippedToken = loadToken;
    showCover();
    player.pause();
    if (!next({ auto: true })) { hideCover(); markDone(c.videoId); }
  }
}
function loop() { tick(); requestAnimationFrame(loop); }

function onPlayerState(st) {
  if (st === STATE.PLAYING) {
    if (cover.on && skippedToken !== loadToken) hideCover();
    fillTitleFromPlayer();
  }
  if (st === STATE.PAUSED) savePosition(true);
  if (st === STATE.ENDED) {
    hideCover();
    const c = S.get().current;
    if (c) markDone(c.videoId);
    if (S.get().settings.autoplay) next({ auto: true });
  }
  renderNow();
}

function fillTitleFromPlayer() {
  const c = S.get().current; if (!c) return;
  const pl = currentPlaylist(); const t = pl?.tracks.find(x => x.id === c.videoId);
  const title = player.title();
  if (t && !t.title && title && player.dataId() === c.videoId) {
    S.update(s => { const p = s.playlists.find(x => x.id === pl.id); const tr = p?.tracks.find(x => x.id === c.videoId); if (tr) tr.title = title; p.updatedAt = Date.now(); });
  }
}

// ---------- 가져오기 ----------
async function importPlaylist(listId, { startVideo = null } = {}) {
  if (importJob) { toast('지금 다른 재생목록을 가져오는 중이에요'); return; }
  if (!navigator.onLine) { toast('인터넷에 연결된 뒤에 가져올 수 있어요'); return; }
  importJob = { listId, text: '불러오는 중…' };
  pendingTitles.set(listId, {});
  render();
  const applyTitles = (map) => {
    if (!map || !Object.keys(map).length) return;
    const pend = pendingTitles.get(listId) || {};
    Object.assign(pend, map); pendingTitles.set(listId, pend);
    const p = S.get().playlists.find(x => x.ytId === listId && !x.deleted);
    if (!p) return;
    S.update(s => {
      const pp = s.playlists.find(x => x.id === p.id);
      pp.tracks.forEach(t => { if (!t.title && pend[t.id]) t.title = pend[t.id]; });
      pp.updatedAt = Date.now();
    });
  };
  try {
    const res = await I.fetchPlaylist(listId, {
      onProgress: text => { importJob.text = text; renderImportStatus(); },
      onTitles: applyTitles,
    });
    if (!res.tracks.length) throw new Error('empty');
    const existing = S.get().playlists.find(x => x.ytId === listId && !x.deleted);
    const oldTitles = new Map((existing?.tracks || []).map(t => [t.id, t.title]));
    const pend = pendingTitles.get(listId) || {};
    const tracks = res.tracks.map(t => ({ id: t.id, title: t.title || oldTitles.get(t.id) || pend[t.id] || '' }));
    let id;
    S.update(s => {
      if (existing) {
        const p = s.playlists.find(x => x.id === existing.id);
        p.tracks = tracks; p.updatedAt = Date.now(); id = p.id;
      } else {
        id = S.uid();
        const name = res.title || (listId === MJG_PLAYLIST ? '먼작귀 (전편공개)' : '가져온 재생목록');
        s.playlists.push({ id, name, ytId: listId, tracks, updatedAt: Date.now() });
      }
    });
    importJob = null;
    toast(existing ? `업데이트했어요 · 영상 ${tracks.length}개` : `영상 ${tracks.length}개를 가져왔어요${res.partial ? ' · 제목은 조금씩 채워져요' : ''}`, 3200);
    view = { name: 'playlist', id };
    if (startVideo && tracks.some(t => t.id === startVideo)) playTrack(id, startVideo);
    render();
  } catch (e) {
    importJob = null;
    render();
    toast('가져오지 못했어요. 링크가 맞는지, 재생목록이 공개 또는 일부 공개인지 확인해 주세요.', 4200);
  }
}

async function addFromInput() {
  const input = $('#add-input');
  const parsed = I.parseInput(input?.value);
  if (!parsed) { toast('유튜브 영상이나 재생목록 링크를 붙여넣어 주세요'); return; }
  if (parsed.type === 'playlist' || parsed.list) {
    input.value = '';
    await importPlaylist(parsed.list, { startVideo: parsed.type === 'video' ? parsed.id : null });
    return;
  }
  // 영상 하나 → 고른 재생목록에 추가
  const target = $('#add-target')?.value || '__new';
  const title = await I.fetchTitle(parsed.id);
  let pid = target;
  S.update(s => {
    let p = s.playlists.find(x => x.id === target && !x.deleted);
    if (!p) { p = { id: S.uid(), name: '내가 추가한 영상', ytId: null, tracks: [], updatedAt: Date.now() }; s.playlists.push(p); }
    pid = p.id;
    if (!p.tracks.some(t => t.id === parsed.id)) p.tracks.push({ id: parsed.id, title });
    p.updatedAt = Date.now();
  });
  input.value = '';
  toast('영상을 추가했어요');
  view = { name: 'playlist', id: pid };
  render();
}

async function loadMyLists() {
  if (myListsLoading) return;
  myListsLoading = true; render();
  try { myLists = await G.myPlaylists(); }
  catch (e) { handleGoogleError(e); toast('내 유튜브 재생목록을 불러오지 못했어요'); }
  myListsLoading = false; render();
}

// ---------- 구글 로그인 · 동기화 ----------
function handleGoogleError(e) {
  if (e instanceof G.AuthError) { sync = { status: 'need-login', at: sync.at }; renderHeader(); }
}

function login() {
  if (!G.isConfigured()) { toast('구글 로그인은 아직 설정 전이에요 (설정 탭 참고)'); return; }
  savePosition(true); S.flush();
  G.signIn();
}

let pushTimer = null;
function schedulePush() {
  if (!G.signedIn()) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => syncNow({ quiet: true }), 8000);
}

let syncing = false;
async function syncNow({ quiet = false } = {}) {
  if (!G.signedIn() || syncing || !navigator.onLine) { if (!G.signedIn() && G.account()) sync.status = 'need-login'; renderHeader(); return; }
  syncing = true;
  sync.status = 'syncing'; renderHeader();
  try {
    const remote = await G.pullState();
    const local = S.get();
    const merged = S.merge(local, remote);
    const playing = player && (player.state === STATE.PLAYING || player.state === STATE.BUFFERING);
    if (playing) merged.current = local.current; // 보고 있는 영상은 바꾸지 않아요
    const prevCur = local.current;
    if (remote) S.replace(merged);
    await G.pushState(S.get());
    sync = { status: 'ok', at: Date.now() };
    // 다른 기기에서 보던 화가 더 최근이면 그 화로 맞춰 둬요 (재생은 직접 누르기)
    const cur = S.get().current;
    if (!playing && cur && (!prevCur || cur.videoId !== prevCur.videoId)) {
      const pl = S.playlistById(cur.playlistId); const tr = pl?.tracks.find(t => t.id === cur.videoId);
      if (tr) { loadToken++; player?.load(cur.videoId, resumePoint(pl, tr), false); if (!quiet) toast('다른 기기에서 보던 화로 맞췄어요'); }
    }
  } catch (e) {
    if (e instanceof G.AuthError) sync = { status: 'need-login', at: sync.at };
    else sync = { status: 'error', at: sync.at };
  }
  syncing = false;
  render();
}

// ---------- 화면 ----------
function render() { renderHeader(); renderNow(); renderTabs(); renderView(); }

function renderHeader() {
  const el = $('#sync');
  let html = '';
  if (!G.isConfigured()) html = '';
  else if (G.signedIn()) {
    const label = sync.status === 'syncing' ? '동기화 중…' : sync.status === 'error' ? '동기화 실패' : '동기화됨';
    html = `<button class="chip ${sync.status === 'error' ? 'warn' : ''}" data-act="sync">${icon('cloud', 16)}<span>${label}</span></button>`;
  } else if (G.account() || sync.status === 'need-login') {
    html = `<button class="chip warn" data-act="login">${icon('cloudOff', 16)}<span>다시 로그인</span></button>`;
  } else {
    html = `<button class="chip" data-act="login">${icon('google', 16)}<span>구글 로그인</span></button>`;
  }
  el.innerHTML = html;
  $('#offline').hidden = navigator.onLine;
}

function renderNow() {
  const el = $('#now');
  const pl = currentPlaylist(); const track = currentTrack(); const i = currentIndex();
  const st = S.get().settings;
  $('#video-empty').hidden = !!track;
  const playing = player && (player.state === STATE.PLAYING || player.state === STATE.BUFFERING);
  const sk = track ? skipSeconds(pl?.ytId, track.title || '') : null;
  const ep = track ? episodeOf(track.title) : null;
  el.innerHTML = `
    <div class="now-text">
      <div class="now-title">${track ? esc(trackTitle(track)) : '재생할 영상을 골라 주세요'}</div>
      <div class="now-sub">
        ${pl ? `<button class="link" data-act="open" data-id="${esc(pl.id)}">${esc(pl.name)}</button><span>${i + 1} / ${pl.tracks.length}</span>` : '<span>보관함에서 재생목록을 골라요</span>'}
        ${sk != null && st.skipEnding ? `<span class="pill" title="엔딩 자동 스킵">${icon('skip', 13)}엔딩 ${sk}초 스킵${ep != null ? ` · ${ep}화` : ''}</span>` : ''}
      </div>
    </div>
    <div class="controls">
      <button class="ctl ${st.shuffle ? 'on' : ''}" data-act="shuffle" aria-label="셔플">${icon('shuffle')}</button>
      <button class="ctl" data-act="prev" aria-label="이전">${icon('prev', 22)}</button>
      <button class="ctl big" data-act="toggle-play" aria-label="${playing ? '일시정지' : '재생'}">${icon(playing ? 'pause' : 'play', 26)}</button>
      <button class="ctl" data-act="next" aria-label="다음">${icon('next', 22)}</button>
      <button class="ctl ${st.repeat ? 'on' : ''}" data-act="repeat" aria-label="반복">${icon('repeat')}</button>
    </div>`;
  renderUpNext();
}

function renderUpNext() {
  const el = $('#upnext'); if (!el) return;
  const pl = currentPlaylist(); const i = currentIndex();
  if (!pl || i < 0) { el.innerHTML = ''; return; }
  const list = pl.tracks.slice(i + 1, i + 6);
  el.innerHTML = list.length ? `<div class="upnext-head">다음 영상</div>` + list.map((t, k) => trackRow(pl, t, i + 1 + k, { compact: true })).join('') : '';
}

const TABS = [
  ['library', '보관함', 'library'],
  ['add', '추가', 'plus'],
  ['history', '기록', 'clock'],
  ['settings', '설정', 'gear'],
];
function renderTabs() {
  const active = view.name === 'playlist' ? 'library' : view.name;
  $('#tabs').innerHTML = TABS.map(([k, label, ic]) =>
    `<button class="tab ${active === k ? 'active' : ''}" data-act="go" data-view="${k}">${icon(ic, 21)}<span>${label}</span></button>`).join('');
}

function progressOf(id) {
  const p = S.get().positions[id];
  if (!p) return 0;
  if (p.done) return 1;
  return p.d ? Math.min(1, p.t / p.d) : 0;
}

function trackRow(pl, t, idx, { compact = false } = {}) {
  const cur = S.get().current;
  const isCur = cur && cur.playlistId === pl.id && cur.videoId === t.id;
  const pr = progressOf(t.id);
  const done = S.get().positions[t.id]?.done;
  return `<div class="track ${isCur ? 'current' : ''} ${compact ? 'compact' : ''}" data-act="play" data-pl="${esc(pl.id)}" data-id="${esc(t.id)}">
    <span class="num">${isCur ? icon('play', 12) : idx + 1}</span>
    <span class="thumb"><img loading="lazy" src="${thumb(t.id)}" alt=""><i style="width:${Math.round(pr * 100)}%"></i></span>
    <span class="t-text"><span class="t-title">${esc(trackTitle(t))}</span>${done ? `<span class="t-meta done">${icon('check', 12)}다 봤어요</span>` : pr > 0 ? `<span class="t-meta">${Math.round(pr * 100)}% 봤어요</span>` : ''}</span>
  </div>`;
}

function renderImportStatus() {
  const el = $('#import-status');
  if (el) el.textContent = importJob ? importJob.text : '';
}

function renderView() {
  const el = $('#view');
  const v = view.name;
  if (v === 'playlist') el.innerHTML = viewPlaylist();
  else if (v === 'add') el.innerHTML = viewAdd();
  else if (v === 'history') el.innerHTML = viewHistory();
  else if (v === 'settings') el.innerHTML = viewSettings();
  else el.innerHTML = viewLibrary();
  if (scrollToCurrent) {
    scrollToCurrent = false;
    const c = el.querySelector('.track.current');
    if (c) c.scrollIntoView({ block: 'center' });
  }
}

function mjgCard() {
  if (S.get().playlists.some(p => p.ytId === MJG_PLAYLIST && !p.deleted)) return '';
  const busy = importJob?.listId === MJG_PLAYLIST;
  return `<div class="card suggest">
    <div><strong>먼작귀 전편공개 재생목록</strong><p>엔딩 자동 스킵이 켜진 재생목록이에요. ${esc(describeRules(MJG_PLAYLIST))}</p></div>
    <button class="btn primary" data-act="import" data-list="${MJG_PLAYLIST}" ${importJob ? 'disabled' : ''}>${busy ? '가져오는 중…' : '가져오기'}</button>
  </div>`;
}

function viewLibrary() {
  const lists = S.livePlaylists();
  const head = `<div class="view-head"><h2>보관함</h2><button class="btn small" data-act="go" data-view="add">${icon('plus', 16)}추가</button></div>`;
  if (!lists.length) {
    return head + `<div class="empty">${icon('library', 36)}<p>아직 재생목록이 없어요</p><small>유튜브 재생목록 링크로 한 번에 가져올 수 있어요</small></div>` + mjgCard() + importLine();
  }
  return head + lists.map(p => {
    const last = S.get().lastByPlaylist[p.id];
    const lt = last && p.tracks.find(t => t.id === last.videoId);
    const cover = (lt || p.tracks[0])?.id;
    const doneCount = p.tracks.filter(t => S.get().positions[t.id]?.done).length;
    return `<div class="pl-card" data-act="open" data-id="${esc(p.id)}">
      <span class="pl-thumb">${cover ? `<img loading="lazy" src="${thumb(cover)}" alt="">` : icon('youtube', 28)}</span>
      <span class="pl-info">
        <strong>${esc(p.name)}</strong>
        <small>영상 ${p.tracks.length}개 · ${doneCount}개 봤어요${SKIP_RULES[p.ytId] ? ' · 엔딩 스킵' : ''}</small>
        ${lt ? `<small class="resume">최근: ${esc(trackTitle(lt))}</small>` : ''}
      </span>
      <button class="round-btn" data-act="resume" data-id="${esc(p.id)}" aria-label="이어보기">${icon('play', 18)}</button>
    </div>`;
  }).join('') + mjgCard() + importLine();
}

function importLine() {
  return importJob ? `<p class="status" id="import-status">${esc(importJob.text)}</p>` : '';
}

function viewPlaylist() {
  const pl = S.playlistById(view.id);
  if (!pl) { view = { name: 'library' }; return viewLibrary(); }
  const doneCount = pl.tracks.filter(t => S.get().positions[t.id]?.done).length;
  const busy = importJob?.listId === pl.ytId;
  return `<div class="view-head">
      <button class="icon-btn" data-act="go" data-view="library" aria-label="뒤로">${icon('back', 22)}</button>
      <div class="vh-title"><h2>${esc(pl.name)}</h2><small>영상 ${pl.tracks.length}개 · ${doneCount}개 봤어요</small></div>
    </div>
    <div class="actions">
      <button class="btn primary" data-act="resume" data-id="${esc(pl.id)}">${icon('play', 16)}이어보기</button>
      <button class="btn" data-act="from-start" data-id="${esc(pl.id)}">처음부터</button>
      ${pl.ytId ? `<button class="btn" data-act="refresh" data-id="${esc(pl.id)}" ${importJob ? 'disabled' : ''}>${icon('refresh', 16)}${busy ? '업데이트 중…' : '새 영상 확인'}</button>` : ''}
      <button class="icon-btn" data-act="rename" data-id="${esc(pl.id)}" aria-label="이름 바꾸기">${icon('edit', 18)}</button>
      <button class="icon-btn danger" data-act="delete" data-id="${esc(pl.id)}" aria-label="삭제">${icon('trash', 18)}</button>
    </div>
    ${SKIP_RULES[pl.ytId] ? `<p class="note">${icon('skip', 14)}엔딩 자동 스킵: ${esc(describeRules(pl.ytId))}</p>` : ''}
    ${importLine()}
    <div class="tracks">${pl.tracks.map((t, i) => trackRow(pl, t, i)).join('')}</div>`;
}

function viewAdd() {
  const lists = S.livePlaylists();
  let google = '';
  if (G.signedIn()) {
    google = `<div class="card">
      <div class="card-head"><strong>${icon('youtube', 18)}내 유튜브 재생목록</strong>
        <button class="btn small" data-act="my-lists" ${myListsLoading ? 'disabled' : ''}>${myListsLoading ? '불러오는 중…' : myLists ? '새로고침' : '불러오기'}</button></div>
      ${myLists ? (myLists.length ? myLists.map(m => {
        const have = S.get().playlists.some(p => p.ytId === m.id && !p.deleted);
        return `<div class="my-row"><span class="pl-thumb sm">${m.thumb ? `<img loading="lazy" src="${esc(m.thumb)}" alt="">` : icon('youtube', 20)}</span>
          <span class="pl-info"><strong>${esc(m.title)}</strong><small>영상 ${m.count}개</small></span>
          <button class="btn small ${have ? '' : 'primary'}" data-act="import" data-list="${esc(m.id)}" ${importJob ? 'disabled' : ''}>${have ? '업데이트' : '가져오기'}</button></div>`;
      }).join('') : '<p class="muted">재생목록이 없어요</p>') : '<p class="muted">구글 계정의 유튜브 재생목록을 불러와요</p>'}
    </div>`;
  } else if (G.isConfigured()) {
    google = `<div class="card"><div class="card-head"><strong>${icon('youtube', 18)}내 유튜브 재생목록</strong></div>
      <p class="muted">구글로 로그인하면 내 유튜브 재생목록(비공개 포함)을 바로 가져오고, 아이폰·아이패드끼리 이어보기가 연동돼요.</p>
      <button class="btn google" data-act="login">${icon('google', 18)}구글로 로그인</button></div>`;
  }
  return `<div class="view-head"><h2>추가</h2></div>
    <div class="card">
      <div class="card-head"><strong>${icon('link', 18)}유튜브 링크로 추가</strong></div>
      <p class="muted">재생목록 링크를 넣으면 전체를 한 번에 가져와요. 영상 링크는 아래에서 고른 재생목록에 넣어요.</p>
      <div class="input-row">
        <input id="add-input" type="url" inputmode="url" autocomplete="off" placeholder="https://youtube.com/playlist?list=…" enterkeyhint="go">
        <button class="btn primary" data-act="add" ${importJob ? 'disabled' : ''}>가져오기</button>
      </div>
      <label class="target">영상 하나일 때 넣을 곳
        <select id="add-target">${lists.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}<option value="__new">새 재생목록 만들기</option></select>
      </label>
      ${importLine()}
    </div>
    ${mjgCard()}
    ${google}`;
}

function viewHistory() {
  const h = S.get().history;
  const ago = at => { const m = Math.floor((Date.now() - at) / 60000); if (m < 1) return '방금'; if (m < 60) return `${m}분 전`; const hr = Math.floor(m / 60); if (hr < 24) return `${hr}시간 전`; return `${Math.floor(hr / 24)}일 전`; };
  return `<div class="view-head"><h2>시청 기록</h2></div>` + (h.length ? `<div class="tracks">${h.map(x => {
    const pl = S.playlistById(x.playlistId);
    const t = pl?.tracks.find(y => y.id === x.id) || x;
    const pr = progressOf(x.id);
    return `<div class="track" data-act="play-history" data-pl="${esc(x.playlistId)}" data-id="${esc(x.id)}">
      <span class="thumb"><img loading="lazy" src="${thumb(x.id)}" alt=""><i style="width:${Math.round(pr * 100)}%"></i></span>
      <span class="t-text"><span class="t-title">${esc(trackTitle(t))}</span><span class="t-meta">${esc(pl?.name || '삭제된 재생목록')} · ${ago(x.at)}</span></span>
    </div>`;
  }).join('')}</div>` : `<div class="empty">${icon('clock', 36)}<p>아직 본 영상이 없어요</p></div>`);
}

function toggleRow(key, label, desc) {
  const on = !!S.get().settings[key];
  return `<button class="setting" data-act="setting" data-key="${key}" role="switch" aria-checked="${on}">
    <span><strong>${label}</strong>${desc ? `<small>${desc}</small>` : ''}</span><span class="switch ${on ? 'on' : ''}"><i></i></span></button>`;
}

function viewSettings() {
  const acc = G.account();
  let google;
  if (!G.isConfigured()) {
    google = `<p class="muted">구글 로그인은 아직 설정 전이에요. 구글 클라우드에서 클라이언트 ID를 받아 <code>js/config.js</code>에 넣으면 켜져요.</p>`;
  } else if (G.signedIn()) {
    google = `<p class="muted">${esc(acc?.email || '로그인됨')}<br>${sync.at ? `마지막 동기화: ${new Date(sync.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}` : ''}</p>
      <div class="actions"><button class="btn" data-act="sync">${icon('refresh', 16)}지금 동기화</button><button class="btn" data-act="logout">로그아웃</button></div>`;
  } else {
    google = `<p class="muted">${acc?.email ? esc(acc.email) + ' — 로그인이 만료됐어요.' : '로그인하면 아이폰·아이패드끼리 재생목록과 이어보기 위치가 맞춰져요.'}</p>
      <button class="btn google" data-act="login">${icon('google', 18)}구글로 로그인</button>`;
  }
  return `<div class="view-head"><h2>설정</h2></div>
    <div class="card list">
      ${toggleRow('autoplay', '다음 영상 자동 재생', '')}
      ${toggleRow('skipEnding', '엔딩 자동 스킵', `먼작귀 재생목록: ${esc(describeRules(MJG_PLAYLIST))}`)}
      ${toggleRow('shuffle', '셔플', '')}
      ${toggleRow('repeat', '반복', '마지막 영상 다음에 처음으로')}
    </div>
    <div class="card"><div class="card-head"><strong>${icon('google', 18)}구글 계정</strong></div>${google}</div>
    <div class="card">
      <div class="card-head"><strong>앱으로 쓰기</strong></div>
      <p class="muted"><b>아이폰·아이패드</b>: Safari에서 이 페이지를 열고 공유 버튼 → <b>홈 화면에 추가</b><br>
      <b>삼성·안드로이드</b>: 크롬 메뉴(⋮) → <b>홈 화면에 추가</b></p>
      <p class="muted">${icon('wifiOff', 14)} 앱 화면은 인터넷 없이도 열리지만, 유튜브 영상 재생에는 인터넷이 필요해요. 화면을 끄면 영상도 멈춰요.</p>
    </div>
    <div class="card">
      <p class="muted">버전 ${APP_VERSION}</p>
      <button class="btn danger" data-act="reset">이 기기의 데이터 지우기</button>
    </div>`;
}

// ---------- 입력 ----------
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const act = el.dataset.act;
  if (act !== 'resume' && act !== 'delete' && act !== 'rename' && el.closest('[data-act="open"]') && el !== el.closest('[data-act="open"]')) {/* 버튼 안 */}
  e.stopPropagation();
  const id = el.dataset.id;
  switch (act) {
    case 'go': view = { name: el.dataset.view }; render(); window.scrollTo({ top: 0 }); break;
    case 'open': view = { name: 'playlist', id }; scrollToCurrent = true; render(); break;
    case 'resume': resumePlaylist(id); break;
    case 'from-start': resumePlaylist(id, { fromStart: true }); break;
    case 'play': playTrack(el.dataset.pl, id); break;
    case 'play-history': if (S.playlistById(el.dataset.pl)) playTrack(el.dataset.pl, id); else toast('재생목록이 삭제됐어요'); break;
    case 'toggle-play': togglePlay(); break;
    case 'next': next(); break;
    case 'prev': prev(); break;
    case 'shuffle': case 'repeat':
      S.update(s => { s.settings[act] = !s.settings[act]; s.settings.at = Date.now(); });
      toast(`${act === 'shuffle' ? '셔플' : '반복'} ${S.get().settings[act] ? '켬' : '끔'}`); break;
    case 'setting': S.update(s => { s.settings[el.dataset.key] = !s.settings[el.dataset.key]; s.settings.at = Date.now(); }); break;
    case 'import': importPlaylist(el.dataset.list); break;
    case 'refresh': { const pl = S.playlistById(id); if (pl?.ytId) importPlaylist(pl.ytId); break; }
    case 'add': addFromInput(); break;
    case 'rename': {
      const pl = S.playlistById(id); if (!pl) break;
      const name = prompt('재생목록 이름', pl.name);
      if (name && name.trim()) S.update(s => { const p = s.playlists.find(x => x.id === id); p.name = name.trim(); p.updatedAt = Date.now(); });
      break;
    }
    case 'delete': {
      const pl = S.playlistById(id); if (!pl) break;
      if (!confirm(`'${pl.name}' 재생목록을 지울까요?`)) break;
      S.update(s => { const p = s.playlists.find(x => x.id === id); p.deleted = true; p.tracks = []; p.updatedAt = Date.now(); if (s.current?.playlistId === id) s.current = null; });
      view = { name: 'library' }; render(); break;
    }
    case 'login': login(); break;
    case 'logout': G.signOut(); sync = { status: 'off', at: 0 }; myLists = null; render(); break;
    case 'sync': syncNow(); break;
    case 'my-lists': loadMyLists(); break;
    case 'reset': if (confirm('이 기기에 저장된 재생목록과 기록을 모두 지울까요?')) { S.resetAll(); view = { name: 'library' }; render(); } break;
  }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.id === 'add-input') { e.preventDefault(); addFromInput(); }
});

// ---------- 시작 ----------
S.subscribe(({ render: r }) => { schedulePush(); if (r) { renderNow(); renderView(); renderHeader(); } });

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { savePosition(true); S.flush(); if (G.signedIn()) syncNow({ quiet: true }); }
  else if (G.signedIn()) syncNow({ quiet: true });
});
window.addEventListener('pagehide', () => { savePosition(true); S.flush(); });
window.addEventListener('online', () => { renderHeader(); if (G.signedIn()) syncNow({ quiet: true }); });
window.addEventListener('offline', renderHeader);

async function start() {
  const r = G.handleRedirect();
  if (r === 'need-login') sync.status = 'need-login';
  render();

  player = new Player('yt', { onState: onPlayerState, onReady: () => renderNow(), onError: () => toast('이 영상은 재생할 수 없어요. 다음 영상으로 넘어가요') || next({ auto: true }) });
  player.init().catch(() => toast('유튜브 플레이어를 불러오지 못했어요. 인터넷 연결을 확인해 주세요', 4000));

  // 마지막에 보던 화를 띄워 둬요 (재생은 직접)
  const c = S.get().current;
  if (c) {
    const pl = S.playlistById(c.playlistId); const tr = pl?.tracks.find(t => t.id === c.videoId);
    if (tr) { loadToken++; player.load(c.videoId, resumePoint(pl, tr), false); }
  }
  requestAnimationFrame(loop);
  setInterval(tick, 100);

  if (r === 'ok') {
    try { await G.loadAccount(); toast('구글 로그인 완료'); } catch (e) {}
    syncNow();
  } else if (G.signedIn()) {
    syncNow({ quiet: true });
  } else if (G.isConfigured() && G.account() && r !== 'need-login' && navigator.onLine) {
    // 예전에 로그인했으면 화면 없이 조용히 다시 로그인 (세션당 한 번)
    let tried = false; try { tried = sessionStorage.getItem('pp-silent') === '1'; sessionStorage.setItem('pp-silent', '1'); } catch (e) { tried = true; }
    if (!tried) { S.flush(); G.signIn({ silent: true }); return; }
    sync.status = 'need-login'; renderHeader();
  }
  setInterval(() => { if (G.signedIn() && document.visibilityState === 'visible') syncNow({ quiet: true }); }, 180000);
}

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

start();
