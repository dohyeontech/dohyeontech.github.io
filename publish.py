#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Build + publish to GitHub Pages through the GitHub REST API (no git push needed).

    python3 publish.py ["커밋 메시지"]

Token lookup order:
  1. $GITHUB_TOKEN
  2. /workspace/.secrets/gh_dohyeontech_token
  3. ../.secrets/gh_dohyeontech_token

Only changed blobs are uploaded; deletions in the working tree are mirrored.
"""
import os
import sys
import json
import base64
import hashlib
import subprocess
import urllib.request
import urllib.error

REPO = 'dohyeontech/dohyeontech.github.io'
SITE = 'https://dohyeontech.github.io'
INDEXNOW_KEY = 'b53ff27590364a6e9d68824be2be0975'
BRANCH = 'main'
AUTHOR = {'name': 'Kim Dohyeon', 'email': 'dohyeon.tech@proton.me'}
ROOT = os.path.dirname(os.path.abspath(__file__))
SKIP_DIRS = {'.git', '__pycache__', '.cache', 'node_modules'}
SKIP_FILES = {'.DS_Store'}


def token():
    t = os.environ.get('GITHUB_TOKEN')
    if t:
        return t.strip()
    for p in ('/workspace/.secrets/gh_dohyeontech_token',
              os.path.join(ROOT, '..', '.secrets', 'gh_dohyeontech_token'),
              os.path.join(ROOT, '.secrets', 'gh_dohyeontech_token')):
        if os.path.isfile(p):
            with open(p) as f:
                return f.read().strip()
    sys.exit('GITHUB_TOKEN not found (env or /workspace/.secrets/gh_dohyeontech_token)')


TOKEN = token()


def api(method, path, payload=None):
    url = 'https://api.github.com' + path
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header('Authorization', 'token %s' % TOKEN)
    req.add_header('Accept', 'application/vnd.github+json')
    req.add_header('User-Agent', 'dohyeontech-publisher')
    if data:
        req.add_header('Content-Type', 'application/json')
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            body = r.read().decode()
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        if e.code == 404 or (e.code == 409 and 'empty' in body.lower()):
            return {'_status': 404}
        raise SystemExit('GitHub API %s %s -> %s %s' % (method, path, e.code, body[:400]))


def indexnow(paths):
    """Bing/IndexNow 즉시 색인 요청 (실패해도 발행은 끝난 상태로 둔다)."""
    urls = set()
    for p in paths:
        if p == 'index.html':
            urls.add(SITE + '/')
        elif p.endswith('/index.html'):
            urls.add('%s/%s/' % (SITE, p[:-len('/index.html')]))
        elif p == 'sitemap.xml':
            urls.add(SITE + '/sitemap.xml')
    if not urls:
        return
    payload = {
        'host': 'dohyeontech.github.io',
        'key': INDEXNOW_KEY,
        'keyLocation': '%s/%s.txt' % (SITE, INDEXNOW_KEY),
        'urlList': sorted(urls),
    }
    req = urllib.request.Request(
        'https://api.indexnow.org/indexnow',
        data=json.dumps(payload).encode(), method='POST')
    req.add_header('Content-Type', 'application/json; charset=utf-8')
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            print('indexnow: %s (%d urls)' % (r.status, len(urls)))
    except Exception as e:
        print('indexnow skipped: %s' % e)


def blob_sha(data):
    h = hashlib.sha1()
    h.update(b'blob %d\0' % len(data))
    h.update(data)
    return h.hexdigest()


def local_files():
    out = {}
    for base, dirs, files in os.walk(ROOT):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for fn in files:
            if fn in SKIP_FILES:
                continue
            full = os.path.join(base, fn)
            rel = os.path.relpath(full, ROOT).replace(os.sep, '/')
            with open(full, 'rb') as f:
                out[rel] = f.read()
    return out


def main():
    msg = sys.argv[1] if len(sys.argv) > 1 else 'publish: %s' % __import__('datetime').datetime.now().strftime('%Y-%m-%d %H:%M')

    print('building...')
    subprocess.run([sys.executable, os.path.join(ROOT, 'build.py')], check=True, cwd=ROOT)

    files = local_files()
    print('%d files in working tree' % len(files))

    ref = api('GET', '/repos/%s/git/ref/heads/%s' % (REPO, BRANCH))
    if ref.get('_status') == 404:
        # 빈 저장소는 Git Data API를 거부하므로 최초 1회만 Contents API로 커밋을 만든다.
        print('bootstrapping empty repository...')
        seed = files.get('README.md', b'# site\n')
        api('PUT', '/repos/%s/contents/README.md' % REPO, {
            'message': msg,
            'content': base64.b64encode(seed).decode(),
            'branch': BRANCH,
            'author': AUTHOR, 'committer': AUTHOR})
        ref = api('GET', '/repos/%s/git/ref/heads/%s' % (REPO, BRANCH))
    parent = None
    remote = {}
    if ref.get('_status') != 404:
        parent = ref['object']['sha']
        tree = api('GET', '/repos/%s/git/trees/%s?recursive=1' % (REPO, parent))
        for e in tree.get('tree', []):
            if e['type'] == 'blob':
                remote[e['path']] = e['sha']

    entries, added, removed = [], 0, 0
    for path, data in sorted(files.items()):
        sha = blob_sha(data)
        if remote.get(path) == sha:
            continue
        blob = api('POST', '/repos/%s/git/blobs' % REPO, {
            'content': base64.b64encode(data).decode(), 'encoding': 'base64'})
        entries.append({'path': path, 'mode': '100755' if path.endswith('.sh') else '100644',
                        'type': 'blob', 'sha': blob['sha']})
        added += 1
    for path in remote:
        if path not in files:
            entries.append({'path': path, 'mode': '100644', 'type': 'blob', 'sha': None})
            removed += 1

    if not entries:
        print('no changes')
        return

    payload = {'tree': entries}
    if parent:
        payload['base_tree'] = parent
    new_tree = api('POST', '/repos/%s/git/trees' % REPO, payload)

    commit = api('POST', '/repos/%s/git/commits' % REPO, {
        'message': msg, 'tree': new_tree['sha'],
        'parents': [parent] if parent else [],
        'author': AUTHOR, 'committer': AUTHOR})

    if parent:
        api('PATCH', '/repos/%s/git/refs/heads/%s' % (REPO, BRANCH), {'sha': commit['sha'], 'force': False})
    else:
        api('POST', '/repos/%s/git/refs' % REPO, {'ref': 'refs/heads/%s' % BRANCH, 'sha': commit['sha']})

    print('pushed %d changed, %d removed -> %s' % (added, removed, commit['sha'][:7]))
    print('https://github.com/%s/commit/%s' % (REPO, commit['sha']))
    indexnow([e['path'] for e in entries])


if __name__ == '__main__':
    main()
