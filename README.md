# DOHYEON TECH BRIEF — GitHub Pages 블로그

`https://dohyeontech.github.io` 정적 사이트. 워드프레스에서 이관한 사이트이며, 글 발행은 **마크다운 파일 추가 → `build.py` → git push** 세 단계로 끝난다. 브라우저 에디터도, 외부 CMS도 필요 없다.

## 구조

```
build.py            정적 사이트 생성기 (외부 패키지 의존 없음)
posts/*.md          발행 글 원본 (front matter + 마크다운)
templates/          base.html / index.html / post.html / archive.html / about.html / 404.html
assets/css|js|images
publish.sh          빌드 + 커밋 + 푸시
```

빌드 산출물(생성 파일, 직접 수정 금지): `index.html`, `posts/<slug>/index.html`, `archive/index.html`, `about/index.html`, `404.html`, `feed.xml`, `sitemap.xml`, `robots.txt`, `.nojekyll`

## 글 추가하기

`posts/`에 마크다운 파일을 만든다. 파일명은 `YYYY-MM-DD-슬러그.md`를 권장한다.

```markdown
---
title: "[긴급 분석] 제목"
slug: short-ascii-slug
date: "2026-11-15"
category: "제로데이"
tags: ["CVE-2026-XXXXX", "Apache"]
thumbnail: /assets/images/thumb_example.png
summary: "홈 카드에 2줄로 표시되는 요약."
author: "김도현"
---

본문. `##`는 섹션 제목, ``` 로 감싸면 코드 블록(+복사 버튼 자동 부착).
```

그다음:

```bash
python3 build.py          # HTML/피드/사이트맵 재생성
./publish.sh              # 빌드까지 포함해서 커밋 + 푸시 (권장)
```

푸시 후 GitHub Pages가 30초 안에 자동 반영한다. (Pages 소스: `main` 브랜치 루트)

## 명령

| 명령 | 동작 |
|---|---|
| `python3 build.py` | 전체 재빌드 |
| `python3 build.py --new "제목"` | `posts/`에 빈 글 골격 생성 |
| `./publish.sh "메시지"` | 빌드 + 커밋 + 푸시 |

## 원칙

- 실명·실제 연락처·개인 이메일을 코드·커밋·HTML에 넣지 않는다. 필명은 `김도현`, 연락은 `dohyeon.tech@proton.me`.
- 커밋 author는 `Kim Dohyeon <dohyeon.tech@proton.me>`.
- 디자인 규격은 워크스페이스 `SKILL_BLOG.md`를 따른다(딥 슬레이트 다크, 카드 그리드, AI 상투 문구 금지).
