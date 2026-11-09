# 재생목록 플레이어

유튜브 재생목록을 이어보고, 엔딩을 자동으로 건너뛰는 개인용 웹 앱이에요.
빌드 과정 없이 GitHub Pages에 그대로 올려서 써요.

주소: https://kse-lab.github.io/playlist-player/

## 기능
- 유튜브 재생목록 링크 하나로 전체 가져오기 (구글 로그인 시 내 비공개 재생목록도)
- 다음 화 자동 재생, 셔플, 반복
- 엔딩 자동 스킵 — 먼작귀 재생목록: 160화까지 30.1초, 161화부터 35.1초 (`skip.js`)
- 이어보기 — 영상마다 본 위치, 재생목록마다 마지막 화 기억
- 구글 로그인 시 아이폰·아이패드끼리 동기화 (구글 드라이브의 앱 전용 숨김 폴더에 저장)
- 홈 화면에 추가하면 앱처럼 실행, 앱 화면은 오프라인에서도 열림 (영상 재생은 인터넷 필요)

## 파일
| 파일 | 내용 |
|---|---|
| `index.html`, `style.css` | 화면 |
| `app.js` | 화면 그리기, 재생, 엔딩 스킵, 동기화 흐름 |
| `player.js` | 유튜브 IFrame 플레이어 |
| `importer.js` | 링크 해석, 재생목록 가져오기 |
| `google.js` | 구글 로그인, 유튜브 API, 드라이브 동기화 |
| `store.js` | 저장과 기기 간 합치기 |
| `skip.js` | 엔딩 스킵 규칙 |
| `config.js` | 구글 클라이언트 ID 설정 |
| `sw.js`, `manifest.webmanifest` | 홈 화면 앱(PWA) |

## 구글 로그인 켜기
1. Google Cloud Console에서 프로젝트 생성
2. YouTube Data API v3, Google Drive API 사용 설정
3. OAuth 동의 화면: 외부, 테스트 사용자에 본인 이메일 추가
4. 사용자 인증 정보 → OAuth 클라이언트 ID → 웹 애플리케이션
   - 승인된 자바스크립트 원본: `https://kse-lab.github.io`
   - 승인된 리디렉션 URI: `https://kse-lab.github.io/playlist-player/`
5. 받은 클라이언트 ID를 `config.js`의 `GOOGLE_CLIENT_ID`에 넣기

## 엔딩 스킵 규칙 바꾸기
`skip.js`의 `SKIP_RULES`에 `{ from: 화 번호, skip: 초 }`를 추가해요. 위에서부터 먼저 맞는 규칙을 써요.
