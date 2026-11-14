#!/bin/bash
# 빌드 + GitHub API 푸시. 사용법: ./publish.sh ["커밋 메시지"]
# (git push 대신 REST API로 올린다 — 별도 자격증명 설정 불필요, 토큰은 워크스페이스 .secrets에 둔다)
set -e
cd "$(dirname "$0")"
MSG="${1:-post: $(date '+%Y-%m-%d %H:%M') update}"
python3 publish.py "$MSG"
