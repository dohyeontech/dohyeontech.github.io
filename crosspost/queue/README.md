# Dev.to 백로그 큐

신규 Dev.to 계정(`dohyeontech`)에 하루에 여러 편을 올리면 스팸 필터에 걸린다. 그래서 발행은 **하루 1편 안팎**으로 끊어서 한다.

## 발행 완료 (2026-11-23)

| 파일 | Dev.to 글 | canonical 검증 |
|---|---|---|
| `archive/01-litellm-cve-2026-40217-en.md` | https://dev.to/dohyeontech/a-regex-was-guarding-a-compiler-inside-litellms-cve-2026-40217-sandbox-escape-68 (id 5094557) | HTTP 200 · `<link rel="canonical">` = 원본 일치 |
| `archive/02-puppet-enterprise-cve-2026-115731-en.md` | https://dev.to/dohyeontech/a-type-name-in-a-report-body-puppet-enterprises-cve-2026-115731-deserialization-rce-265p (id 5094559) | HTTP 200 · `<link rel="canonical">` = 원본 일치 |

두 편 모두 2026-11-23 00:30~00:31 KST에 66초 간격으로 발행했고, 스팸 차단·중복 게시는 없었다.

## 대기 중인 원고

없음. (Hashnode가 Pro 전용이라 웹 에디터 발행 대상. 남은 영문 원고는 `crosspost/` 루트의 `chrome-mirror-dimension-en.md`, `vcenter-…-en.md`, `monai-label-…-en.md`로 모두 발행됨.)

## 발행 방법 (편당 1회)

```bash
cd /workspace/dohyeontech-blog
python3 crosspost/crosspost.py devto crosspost/queue/<파일>.md
```

- 프런트매터의 `canonical_url`은 원본 포스트로 고정돼 있다. 손대지 않는다.
- 커버 이미지는 GitHub Pages에 올라가 있어야 한다(발행 전에 `curl -o /dev/null -w '%{http_code}'`로 200 확인).
- 발행 후 검증: 반환된 `url`에 `curl -o /dev/null -w '%{http_code}'`가 200, HTML에
  `<link rel="canonical" href="<원본 URL>" />`가 있는지 확인한다.
- **실패해도 재시도하지 않는다.** API가 오류를 돌려줘도 실제로는 게시됐을 수 있으니,
  먼저 `GET /api/articles/me/all`로 확인한다(중복 게시 방지).
- 발행한 파일은 `crosspost/queue/archive/`로 옮기고, 위 표를 갱신한다.

## 태그

`cve`, `vmware` 같은 태그는 Dev.to 태그 목록(`GET /api/tags`)에 없어서 쓰지 않았다. 실제로 존재하는 태그만 넣는다: `security`, `devops`, `infrastructure`, `cloud`, `ai`, `python`, `opensource`, `ruby`.

## Hashnode

무료 플랜은 GraphQL API가 막혀 있어(Pro 전용) 자동 발행이 안 된다. 필요하면 같은 원고를 웹 에디터에 붙여넣고 'Are you republishing?'에 원본 URL을 넣어 수동 게시한다(`crosspost/PLAN.md` 3절).
