// 유튜브 IFrame 플레이어 — 앱 전체에서 플레이어 하나를 계속 써요.
export const STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };

let apiPromise = null;
export function loadApi() {
  if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { if (prev) try { prev(); } catch (e) {} resolve(window.YT); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.async = true;
    s.onerror = () => { apiPromise = null; reject(new Error('youtube-api')); };
    document.head.appendChild(s);
  });
  return apiPromise;
}

export class Player {
  constructor(el, handlers = {}, { inline = true } = {}) {
    this.el = el;
    this.inline = inline;
    this.h = handlers;
    this.yt = null;
    this.ready = false;
    this.state = STATE.UNSTARTED;
    this.videoId = null;
    this._raw = 0; this._stamp = 0;
    this._pending = null;
  }

  async init() {
    const YT = await loadApi();
    await new Promise(resolve => {
      this.yt = new YT.Player(this.el, {
        width: '100%', height: '100%',
        playerVars: { playsinline: this.inline ? 1 : 0, rel: 0, modestbranding: 1, enablejsapi: 1, origin: location.origin },
        events: {
          onReady: () => { this.ready = true; resolve(); if (this._pending) { const p = this._pending; this._pending = null; this.load(p.id, p.start, p.autoplay); } this.h.onReady?.(); },
          onStateChange: e => { this.state = e.data; this._stamp = performance.now(); this.h.onState?.(e.data); },
          onError: e => this.h.onError?.(e.data),
        },
      });
    });
  }

  load(id, start = 0, autoplay = true) {
    this.videoId = id;
    this._raw = start || 0; this._stamp = performance.now();
    if (!this.ready) { this._pending = { id, start, autoplay }; return; }
    const opts = { videoId: id, startSeconds: Math.max(0, Math.floor(start || 0)) };
    if (autoplay) this.yt.loadVideoById(opts); else this.yt.cueVideoById(opts);
  }

  destroy() {
    try { this.yt?.destroy(); } catch (e) {}
    this.ready = false; this.yt = null;
  }

  play() { this.ready && this.yt.playVideo(); }
  pause() { this.ready && this.yt.pauseVideo(); }
  seek(t) { this.ready && this.yt.seekTo(t, true); }

  duration() { try { return this.ready ? (this.yt.getDuration() || 0) : 0; } catch (e) { return 0; } }
  title() { try { return this.ready ? (this.yt.getVideoData()?.title || '') : ''; } catch (e) { return ''; } }
  dataId() { try { return this.ready ? (this.yt.getVideoData()?.video_id || '') : ''; } catch (e) { return ''; } }
  rate() { try { return this.yt.getPlaybackRate() || 1; } catch (e) { return 1; } }

  // 유튜브가 알려주는 재생 시간은 조금씩 늦게 갱신돼요.
  // 마지막으로 바뀐 순간부터 흐른 시간을 더해서 실제 위치를 밀리초 단위로 추정해요.
  time() {
    if (!this.ready) return this._raw;
    let raw = 0;
    try { raw = this.yt.getCurrentTime() || 0; } catch (e) {}
    const now = performance.now();
    if (raw !== this._raw) { this._raw = raw; this._stamp = now; }
    if (this.state === STATE.PLAYING) {
      return Math.min(raw + ((now - this._stamp) / 1000) * this.rate(), raw + 1);
    }
    return raw;
  }
}
