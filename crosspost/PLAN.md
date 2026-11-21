# 영문 크로스포스팅 파이프라인 연계안 (2026-11-21 작성)

원본: `https://dohyeontech.github.io` (GitHub Pages, 한국어 테크브리프)
대상: Dev.to `@dohyeontech`, Hashnode `dohyeontech.hashnode.dev`
원칙: 두 곳 모두 `canonical_url`을 원본 포스트로 지정하고, 본문 첫머리·끝머리에 원문 링크를 남긴다.
영문판은 번역이 아니라 **영문권 리서처 톤으로 다시 쓰는 각색**이다(`SKILL_BLOG.md` 4단계 구조·상투어 금지 규칙 유지).

## 1. 현재 상태

| 항목 | Dev.to | Hashnode |
|---|---|---|
| 계정 | `dohyeontech` (GitHub OAuth, 무번호) | `dohyeontech` / 블로그 `Dohyeon Tech Brief` |
| API | 공식 REST API 사용 가능(무료) | **GraphQL API는 Pro 전용** (무료 플랜 폐지, 2026-05-13 공지) |
| 키 위치 | `/workspace/.secrets/devto_api_key` (600) | `/workspace/.secrets/hashnode_token` (600) — 무료 플랜에서는 쓰이지 않음 |
| 발행 방식 | `crosspost.py devto <파일>` (자동) | 웹 에디터 Markdown 탭 붙여넣기 (수동) 또는 Pro 업그레이드 후 API |
| 비용 | 0원 | Pro $5/월 per seat |

발행 스크립트: `/workspace/dohyeontech-blog/crosspost/crosspost.py`
- 프런트매터(`title`, `subtitle`, `cover_image`, `tags`, `canonical_url`, `source_ko`)를 읽어 Dev.to에 게시한다.
- Cloudflare 때문에 기본 urllib UA는 403이 난다. 스크립트가 브라우저 UA를 넣는다(지우지 말 것).
- Hashnode 분기는 Pro 전환 시 바로 쓸 수 있게 남겨 두었다(`hashnode_publication_id` 파일만 추가로 채우면 된다).

영문 원고 위치: `crosspost/<slug>-en.md` (예: `chrome-mirror-dimension-en.md`)

## 2. 09:00 액션에 붙이는 순서

`daily-ai-security-briefing`이 `./publish.sh`로 원본을 올린 직후, 같은 실행에서 아래를 이어 붙인다.

1. 발행된 포스트의 `slug`·`title`·`summary`·`thumbnail`을 확보한다.
2. 영문 각색 원고를 `crosspost/<slug>-en.md`로 쓴다. 프런트매터의 `canonical_url`은 **반드시** `https://dohyeontech.github.io/posts/<slug>/`.
3. 영문 썸네일이 필요하면 `scripts/generate_mirror_dimension_thumbnail_en.py` 같은 변형 스크립트로 만들고, GitHub API로 `assets/images/thumb_<slug>_en.png`만 단독 커밋한다(블로그 전체 재빌드 없이 Pages가 서빙).
4. `python3 crosspost/crosspost.py devto crosspost/<slug>-en.md` 실행 → 반환된 `url`을 검증한다.
5. 검증: `curl -o /dev/null -w '%{http_code}' <url>`이 200, 페이지 HTML에 `<link rel="canonical" href="https://dohyeontech.github.io/posts/<slug>/">`가 있어야 한다. 실패하면 아침 보고에 실패로 적고 재시도하지 않는다(중복 게시 위험).
6. Hashnode는 무료 플랜이면 자동화하지 않는다. 대신 아침 보고에 "Hashnode 수동 게시 대기: <영문 원고 경로>"를 한 줄 남긴다.

## 3. 자동화 가능 여부 판단

- **Dev.to: 가능.** API 키·스크립트·canonical 검증까지 실제 발행으로 확인했다. 남은 결정은 "매일 자동 게시"를 켤지 여부다(공개 글이 매일 하나씩 늘어나는 일이라 순대주인님 승인 사항).
- **Hashnode: 무료 플랜에서는 불가.** GraphQL API가 Pro 전용으로 바뀌었고, CLI·에이전트 MCP·gql skill도 같은 API를 쓰므로 함께 막힌다. Pro는 $5/월 per seat. 승인 없이는 결제하지 않는다.
  - 대안 A: 무료 유지 + 수동 게시(주 1~2회 묶어서).
  - 대안 B: Pro 결제 후 `crosspost.py hashnode` 활성화(발행 ID만 채우면 됨).
- 두 곳 모두 공개 발행 자체는 무료이며, canonical 덕분에 검색 순위는 원본으로 모인다.

## 4. 리스크·주의

- **계정 제재**: 무료 신규 계정에서 짧은 시간에 대량 게시하면 스팸 필터에 걸린다. 하루 1건, 본문 밀도 유지가 안전하다(구글 계정 정지 사건과 같은 계열의 위험).
- **중복 게시**: API가 200을 못 돌려줘도 실제로는 게시됐을 수 있다. 재시도 전에 `GET /api/articles/me/all`로 확인한다.
- **canonical 누락**: Dev.to는 `canonical_url`, Hashnode는 'Are you republishing?' 체크 + URL 입력이 그 역할을 한다. 이걸 빠뜨리면 원본이 중복 콘텐츠로 밀린다.
- **이미지**: 영문 글에는 영문 썸네일을 쓴다(한글 썸네일은 글로벌 독자에게 어색하다).
