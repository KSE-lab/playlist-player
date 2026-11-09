// 앱 상태 저장소 — 이 기기(localStorage)에 저장하고, 구글 로그인 시 기기끼리 합쳐요.
const KEY = 'pp-state-v2';

function fresh() {
  const now = Date.now();
  return {
    version: 2,
    updatedAt: 0,
    playlists: [],          // {id, name, ytId, tracks:[{id,title}], updatedAt, deleted?}
    current: null,          // {playlistId, videoId, at}
    positions: {},          // videoId -> {t, d, done, at}
    lastByPlaylist: {},     // playlistId -> {videoId, at}
    history: [],            // {id, title, playlistId, at}
    settings: { autoplay: true, shuffle: false, repeat: false, skipEnding: true, at: now },
  };
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw);
      const base = fresh();
      return { ...base, ...s, settings: { ...base.settings, ...(s.settings || {}) } };
    }
  } catch (e) { /* 저장소를 못 쓰는 환경 */ }
  return fresh();
}

let state = load();
const listeners = new Set();
let saveTimer = null;

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
  }, 150);
}

export function flush() {
  clearTimeout(saveTimer);
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
}

export function get() { return state; }

// changed: 기기 간 동기화가 필요한 변경인지 (재생 위치 같은 잦은 변경도 true)
export function update(fn, { render = true } = {}) {
  fn(state);
  state.updatedAt = Date.now();
  persist();
  listeners.forEach(l => l({ render }));
}

export function replace(next) {
  state = next;
  persist();
  listeners.forEach(l => l({ render: true, replaced: true }));
}

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function livePlaylists() { return state.playlists.filter(p => !p.deleted); }
export function playlistById(id) { return state.playlists.find(p => p.id === id && !p.deleted) || null; }

export function resetAll() { replace(fresh()); flush(); }

// 두 기기의 상태 합치기 — 항목마다 더 최근에 바뀐 쪽을 써요.
export function merge(a, b) {
  if (!b) return a;
  if (!a) return b;
  const out = fresh();
  out.updatedAt = Math.max(a.updatedAt || 0, b.updatedAt || 0);

  const pl = new Map();
  [...(a.playlists || []), ...(b.playlists || [])].forEach(p => {
    const prev = pl.get(p.id);
    if (!prev || (p.updatedAt || 0) > (prev.updatedAt || 0)) pl.set(p.id, p);
  });
  // 원래 순서(a 기준)를 최대한 유지
  const order = [...(a.playlists || []).map(p => p.id), ...(b.playlists || []).map(p => p.id)];
  out.playlists = [...new Set(order)].map(id => pl.get(id));

  const newest = (x, y) => {
    const r = { ...(x || {}) };
    Object.entries(y || {}).forEach(([k, v]) => {
      if (!r[k] || (v && (v.at || 0) > (r[k].at || 0))) r[k] = v;
    });
    return r;
  };
  out.positions = newest(a.positions, b.positions);
  out.lastByPlaylist = newest(a.lastByPlaylist, b.lastByPlaylist);

  const hist = [...(a.history || []), ...(b.history || [])].sort((x, y) => y.at - x.at);
  const seen = new Set();
  out.history = hist.filter(h => (seen.has(h.id) ? false : seen.add(h.id))).slice(0, 100);

  out.settings = ((b.settings?.at || 0) > (a.settings?.at || 0)) ? { ...out.settings, ...b.settings } : { ...out.settings, ...a.settings };
  out.current = ((b.current?.at || 0) > (a.current?.at || 0)) ? b.current : a.current;
  return out;
}
