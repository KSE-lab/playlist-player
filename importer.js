// 유튜브 링크 해석 · 재생목록 가져오기
import * as G from './google.js';
import { loadApi } from './player.js';

const ID_RE = /^[a-zA-Z0-9_-]{11}$/;
const LIST_RE = /^(PL|UU|LL|FL|OL|RD)[a-zA-Z0-9_-]{10,}$/;

// 붙여넣은 글자 → {type:'playlist', list} | {type:'video', id, list} | null
export function parseInput(raw) {
  const v = (raw || '').trim();
  if (!v) return null;
  if (LIST_RE.test(v)) return { type: 'playlist', list: v };
  if (ID_RE.test(v)) return { type: 'video', id: v, list: null };
  let u;
  try { u = new URL(v.startsWith('http') ? v : 'https://' + v); } catch (e) { return null; }
  const host = u.hostname.replace(/^www\.|^m\.|^music\./, '');
  const list = u.searchParams.get('list');
  let id = null;
  if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else if (/^\/(shorts|embed|live)\//.test(u.pathname)) id = u.pathname.split('/')[2];
  } else return null;
  if (u.pathname === '/playlist' && list) return { type: 'playlist', list };
  if (id && ID_RE.test(id)) return { type: 'video', id, list: list || null };
  if (list) return { type: 'playlist', list };
  return null;
}

// 영상 제목 (로그인 없이) — noembed 사용
export async function fetchTitle(id) {
  try {
    const r = await fetch('https://noembed.com/embed?url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + id));
    const d = await r.json();
    return d.title || '';
  } catch (e) { return ''; }
}

// 로그인/API 키 없이: 숨겨진 유튜브 플레이어에 재생목록을 띄워서 영상 ID 목록을 받아요.
async function idsViaPlayer(listId) {
  const YT = await loadApi();
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-9999px;top:0;width:200px;height:120px;opacity:0;pointer-events:none';
  const el = document.createElement('div');
  holder.appendChild(el);
  document.body.appendChild(holder);
  try {
    return await new Promise((resolve, reject) => {
      let done = false;
      const finish = (ids) => { if (!done) { done = true; resolve(ids); } };
      const timer = setTimeout(() => { if (!done) { done = true; reject(new Error('timeout')); } }, 20000);
      const p = new YT.Player(el, {
        width: '200', height: '120',
        playerVars: { listType: 'playlist', list: listId, playsinline: 1, origin: location.origin },
        events: {
          onReady: () => {
            let tries = 0;
            const poll = () => {
              let ids = null;
              try { ids = p.getPlaylist(); } catch (e) {}
              if (ids && ids.length) { clearTimeout(timer); finish(ids); return; }
              if (++tries > 60) { clearTimeout(timer); done = true; reject(new Error('empty')); return; }
              setTimeout(poll, 250);
            };
            try { p.cuePlaylist({ listType: 'playlist', list: listId }); } catch (e) {}
            poll();
          },
          onError: () => { clearTimeout(timer); if (!done) { done = true; reject(new Error('player')); } },
        },
      });
    });
  } finally {
    holder.remove();
  }
}

// 재생목록 전체 가져오기 → {title, tracks, partial}
// onProgress(text) 로 진행 상황을 알려요. onTitles(map) 로 나중에 채워지는 제목을 알려요.
export async function fetchPlaylist(listId, { onProgress, onTitles } = {}) {
  if (G.canUseYouTubeApi()) {
    try {
      onProgress?.('재생목록 정보를 불러오는 중…');
      const title = await G.playlistTitle(listId).catch(() => '');
      const tracks = await G.playlistItems(listId, (n, total) => onProgress?.(`영상 목록 불러오는 중… ${n}${total ? ' / ' + total : ''}`));
      return { title, tracks, partial: false };
    } catch (e) {
      if (!(e instanceof G.AuthError)) throw e;
    }
  }
  onProgress?.('영상 목록 불러오는 중…');
  const ids = await idsViaPlayer(listId);
  const tracks = ids.map(id => ({ id, title: '' }));
  // 제목은 뒤에서 천천히 채워요
  fillTitles(tracks.map(t => t.id), onTitles);
  return { title: '', tracks, partial: true };
}

export async function fillTitles(ids, onTitles) {
  const queue = [...ids];
  let batch = {};
  let flushAt = Date.now();
  const worker = async () => {
    while (queue.length) {
      const id = queue.shift();
      const t = await fetchTitle(id);
      if (t) batch[id] = t;
      if (Date.now() - flushAt > 800) { onTitles?.(batch); batch = {}; flushAt = Date.now(); }
    }
  };
  await Promise.all(Array.from({ length: 5 }, worker));
  onTitles?.(batch);
}
