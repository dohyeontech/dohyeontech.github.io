# Dev.to 백로그 큐 (2026-11-21 준비)

신규 Dev.to 계정(`dohyeontech`)에 하루에 여러 편을 올리면 스팸 필터에 걸린다. 그래서 vCenter 한 편만 2026-11-21에 라이브 발행했고, 나머지 두 편은 여기서 **하루 1편**씩 꺼내 쓴다.

| 순서 | 파일 | 원본(한국어) | 영문 커버 |
|---|---|---|---|
| 1 | `01-litellm-cve-2026-40217-en.md` | https://dohyeontech.github.io/posts/litellm-cve-2026-40217/ | `assets/images/thumb_litellm_cve_2026_40217_en.png` |
| 2 | `02-puppet-enterprise-cve-2026-115731-en.md` | https://dohyeontech.github.io/posts/puppet-enterprise-cve-2026-115731/ | `assets/images/thumb_puppet_enterprise_cve_2026_115731_en.png` |

## 발행 방법 (편당 1회)

```bash
cd /workspace/dohyeontech-blog
python3 crosspost/crosspost.py devto crosspost/queue/01-litellm-cve-2026-40217-en.md
```

- 프런트매터의 `canonical_url`은 원본 포스트로 고정돼 있다. 손대지 않는다.
- 커버 이미지는 이미 GitHub Pages에 올라가 있다(커밋 `57797180`, HTTP 200 확인).
- 발행 후 검증: 반환된 `url`에 `curl -o /dev/null -w '%{http_code}'`가 200, HTML에
  `<link rel="canonical" href="<원본 URL>" />`가 있는지 확인한다.
- **실패해도 재시도하지 않는다.** API가 오류를 돌려줘도 실제로는 게시됐을 수 있으니,
  먼저 `GET /api/articles/me/all`로 확인한다(중복 게시 방지).
- 발행한 파일은 `crosspost/queue/archive/`로 옮기고, 위 표에서 순서를 갱신한다.

## 태그

`cve`, `vmware` 같은 태그는 Dev.to 태그 목록(`GET /api/tags`)에 없어서 쓰지 않았다. 실제로 존재하는 태그만 넣는다: `security`, `devops`, `infrastructure`, `cloud`, `ai`, `python`, `opensource`, `ruby`.

## Hashnode

무료 플랜은 GraphQL API가 막혀 있어(Pro 전용) 자동 발행이 안 된다. 필요하면 같은 원고를 웹 에디터에 붙여넣고 'Are you republishing?'에 원본 URL을 넣어 수동 게시한다(`crosspost/PLAN.md` 3절).
