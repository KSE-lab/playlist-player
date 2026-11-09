// 엔딩 자동 스킵 규칙
// 재생목록(유튜브 재생목록 ID)별로, 제목의 'OOO화' 번호에 따라 마지막 몇 초를 건너뛸지 정해요.
// 위에서부터 먼저 맞는 규칙을 써요.
import { MJG_PLAYLIST } from './config.js';

export const SKIP_RULES = {
  [MJG_PLAYLIST]: {
    label: '먼작귀',
    rules: [
      { from: 161, skip: 35.1 }, // 161화부터
      { from: 0, skip: 30.1 },   // 그 전
    ],
    fallback: 30.1, // 제목에서 화 번호를 못 찾았을 때
  },
};

export function episodeOf(title) {
  const m = title && String(title).match(/(\d+)\s*화/);
  return m ? parseInt(m[1], 10) : null;
}

// 이 영상에서 건너뛸 엔딩 길이(초). 규칙이 없는 재생목록이면 null.
export function skipSeconds(ytListId, title) {
  const cfg = ytListId ? SKIP_RULES[ytListId] : null;
  if (!cfg) return null;
  const ep = episodeOf(title);
  if (ep == null) return cfg.fallback;
  for (const r of cfg.rules) if (ep >= r.from) return r.skip;
  return cfg.fallback;
}

export function describeRules(ytListId) {
  const cfg = SKIP_RULES[ytListId];
  if (!cfg) return '';
  const parts = [];
  const sorted = [...cfg.rules].sort((a, b) => a.from - b.from);
  sorted.forEach((r, i) => {
    const next = sorted[i + 1];
    const range = next ? (r.from === 0 ? `${next.from - 1}화까지` : `${r.from}~${next.from - 1}화`) : `${r.from}화부터`;
    parts.push(`${range} ${r.skip}초`);
  });
  return parts.join(' · ');
}
