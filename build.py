#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
DOHYEON TECH BRIEF — static site builder for GitHub Pages.

Usage:
    python3 build.py                 # posts/*.md -> HTML, index, archive, feed, sitemap
    python3 build.py --new "제목"     # (optional) create a new post skeleton

No third-party dependencies. Add a Markdown file to posts/, run this, push.
"""

import os
import re
import hashlib
import sys
import html
import json
import datetime
import shutil

ROOT = os.path.dirname(os.path.abspath(__file__))
POSTS_DIR = os.path.join(ROOT, 'posts')
TPL_DIR = os.path.join(ROOT, 'templates')

SITE = {
    'url': 'https://dohyeontech.github.io',
    'title': 'DOHYEON TECH BRIEF',
    'tagline': 'CYBERSECURITY & AI JOURNAL',
    'name': '도현의 테크브리프',
    'desc': '제로데이·공급망 공격·AI 보안을 소스 레벨에서 분석하는 엔지니어링 저널.',
    'author': '김도현',
    'email': 'dohyeon.tech@proton.me',
    'lang': 'ko',
}

# ---------------------------------------------------------------- 후원(Crypto Tip) 설정
# 지갑 주소가 준비되면 아래 값만 채우고 다시 배포하면 포스트 하단과 /about/에 후원 블록이 켜진다.
# 빈 문자열이면 블록 자체를 렌더하지 않는다 — 가짜 주소는 절대 넣지 않는다.
TIP_WALLETS = [
    ('BTC (Bitcoin · Native SegWit)', 'bc1qlug0gunjlm84suekyz5wu6c8uu4zml0zvyjmnv'),
    ('ETH / USDT / USDC (ERC-20 · Base · Arbitrum)', '0x1f84BB57A4aFdD3FD92362516C3c9E6626968E0F'),
]
TIP_NOTE = ('ETH · USDT · USDC는 ERC-20 계열 네트워크(Ethereum · Base · Arbitrum 등)에서만 보내 주세요. '
            '다른 네트워크로 보낸 자산은 복구되지 않습니다.')

SUBSCRIBE_MAIL_SUBJECT = '구독 신청'
SUBSCRIBE_MAIL_BODY = '이 주소로 도현의 테크브리프 새 글 알림을 받고 싶습니다.'


# ---------------------------------------------------------------- front matter
def parse_front_matter(text):
    meta, body = {}, text
    if text.startswith('---'):
        parts = text.split('---', 2)
        if len(parts) >= 3:
            raw, body = parts[1], parts[2]
            for line in raw.strip().splitlines():
                if not line.strip() or ':' not in line:
                    continue
                k, v = line.split(':', 1)
                k, v = k.strip(), v.strip()
                if v.startswith('"') and v.endswith('"'):
                    v = v[1:-1].replace('\\"', '"')
                elif v.startswith('[') and v.endswith(']'):
                    inner = v[1:-1].strip()
                    v = [x.strip().strip('"').strip("'") for x in inner.split(',') if x.strip()]
                meta[k] = v
    return meta, body.strip()


# ---------------------------------------------------------------- markdown (self-contained)
RE_FENCE = re.compile(r'^(```)([a-zA-Z0-9_+-]*)\s*$')


def esc(t):
    return html.escape(t, quote=False)


def inline(text):
    """Inline markdown -> HTML. Input is plain (unescaped) text."""
    # protect inline code first
    codes = []

    def stash(m):
        codes.append(m.group(1))
        return '\x00%d\x00' % (len(codes) - 1)

    text = re.sub(r'`([^`]+)`', stash, text)
    text = esc(text)
    text = re.sub(r'!\[([^\]]*)\]\(([^)\s]+)\)',
                  lambda m: '<img src="%s" alt="%s" loading="lazy">' % (m.group(2), m.group(1)), text)
    text = re.sub(r'\[([^\]]+)\]\(([^)\s]+)\)',
                  lambda m: '<a href="%s">%s</a>' % (m.group(2), m.group(1)), text)
    text = re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', text)
    text = re.sub(r'(?<![\w*])\*([^*\n]+)\*(?![\w*])', r'<em>\1</em>', text)
    text = re.sub(r'~~([^~]+)~~', r'<del>\1</del>', text)

    def restore(m):
        return '<code>%s</code>' % esc(codes[int(m.group(1))])

    text = re.sub(r'\x00(\d+)\x00', restore, text)
    return text


def render_md(md):
    lines = md.replace('\r\n', '\n').split('\n')
    out, i, n = [], 0, len(lines)
    para = []

    def flush():
        if para:
            out.append('<p>%s</p>' % inline(' '.join(para).strip()))
            para.clear()

    while i < n:
        line = lines[i]
        s = line.rstrip()

        m = RE_FENCE.match(s.strip())
        if m:
            flush()
            lang = m.group(2)
            i += 1
            buf = []
            while i < n and lines[i].strip() != '```':
                buf.append(lines[i])
                i += 1
            i += 1
            cls = ' class="language-%s"' % lang if lang else ''
            out.append('<div class="codeblock"><pre><code%s>%s</code></pre>'
                       '<button class="copy" type="button" aria-label="코드 복사">COPY</button></div>'
                       % (cls, esc('\n'.join(buf))))
            continue

        if not s.strip():
            flush()
            i += 1
            continue

        if re.match(r'^(---+|\*\*\*+)$', s.strip()):
            flush()
            out.append('<hr>')
            i += 1
            continue

        h = re.match(r'^(#{1,6})\s+(.*)$', s)
        if h:
            flush()
            lvl = min(len(h.group(1)) + (1 if len(h.group(1)) == 1 else 0), 6)
            out.append('<h%d>%s</h%d>' % (lvl, inline(h.group(2).strip()), lvl))
            i += 1
            continue

        if s.startswith('>'):
            flush()
            buf = []
            while i < n and lines[i].startswith('>'):
                buf.append(re.sub(r'^>\s?', '', lines[i]))
                i += 1
            inner = render_md('\n'.join(buf))
            out.append('<blockquote>%s</blockquote>' % inner)
            continue

        # table
        if '|' in s and i + 1 < n and re.match(r'^\s*\|?[\s:|-]+\|[\s:|-]*$', lines[i + 1]):
            flush()
            header = [c.strip() for c in s.strip().strip('|').split('|')]
            i += 2
            rows = []
            while i < n and '|' in lines[i] and lines[i].strip():
                rows.append([c.strip() for c in lines[i].strip().strip('|').split('|')])
                i += 1
            t = ['<div class="table-wrap"><table><thead><tr>']
            t += ['<th>%s</th>' % inline(c) for c in header]
            t.append('</tr></thead><tbody>')
            for r in rows:
                t.append('<tr>' + ''.join('<td>%s</td>' % inline(c) for c in r) + '</tr>')
            t.append('</tbody></table></div>')
            out.append(''.join(t))
            continue

        ul = re.match(r'^\s*[-*+]\s+(.*)$', s)
        ol = re.match(r'^\s*(\d+)[.)]\s+(.*)$', s)
        if ul or ol:
            flush()
            ordered = bool(ol)
            items = []
            while i < n:
                cur = lines[i]
                mu = re.match(r'^\s*[-*+]\s+(.*)$', cur)
                mo = re.match(r'^\s*(\d+)[.)]\s+(.*)$', cur)
                if ordered and mo:
                    items.append(mo.group(2))
                elif not ordered and mu:
                    items.append(mu.group(1))
                elif cur.startswith('  ') and cur.strip() and items:
                    items[-1] += ' ' + cur.strip()
                else:
                    break
                i += 1
            tag = 'ol' if ordered else 'ul'
            out.append('<%s>%s</%s>' % (tag, ''.join('<li>%s</li>' % inline(x) for x in items), tag))
            continue

        para.append(s.strip())
        i += 1

    flush()
    return '\n'.join(out)


# ---------------------------------------------------------------- templates
def tpl(name):
    with open(os.path.join(TPL_DIR, name), encoding='utf-8') as f:
        return f.read()


def fill(template, ctx):
    out = template
    for k, v in ctx.items():
        out = out.replace('{{%s}}' % k.upper(), str(v))
    return out


def load_posts():
    posts = []
    if not os.path.isdir(POSTS_DIR):
        return posts
    for fn in sorted(os.listdir(POSTS_DIR)):
        if not fn.endswith('.md') or fn.startswith('_'):
            continue
        path = os.path.join(POSTS_DIR, fn)
        with open(path, encoding='utf-8') as f:
            meta, body = parse_front_matter(f.read())
        slug = meta.get('slug') or fn[:-3]
        date = meta.get('date') or '1970-01-01'
        tags = meta.get('tags') or []
        if isinstance(tags, str):
            tags = [tags]
        posts.append({
            'slug': slug,
            'title': meta.get('title', slug),
            'date': date,
            'time': meta.get('time', '00:00'),
            'category': meta.get('category', '분석'),
            'tags': tags,
            'thumbnail': meta.get('thumbnail', ''),
            'summary': meta.get('summary', ''),
            'author': meta.get('author', SITE['author']),
            'original': meta.get('original', ''),
            'seo_title': meta.get('seo_title', ''),
            'body_md': body,
            'body_html': render_md(body),
            'file': fn,
            'reading': max(1, round(len(re.sub(r'[^\w\s]', '', body)) / 500)),
        })
    posts.sort(key=lambda p: (p['date'], p.get('time', '00:00')), reverse=True)
    return posts


def korean_date(d):
    try:
        dt = datetime.date.fromisoformat(d)
    except ValueError:
        return d
    return '%d.%02d.%02d' % (dt.year, dt.month, dt.day)


def long_date(d):
    try:
        dt = datetime.date.fromisoformat(d)
    except ValueError:
        return d
    return '%d년 %d월 %d일' % (dt.year, dt.month, dt.day)


def rfc822(d, t=None):
    try:
        dt = datetime.datetime.fromisoformat('%sT%s' % (d, t) if t else d)
    except ValueError:
        dt = datetime.datetime(1970, 1, 1)
    return dt.strftime('%a, %d %b %Y %H:%M:%S +0900')


ASSET_VER = {}


def av(path):
    """'/assets/css/style.css' -> '/assets/css/style.css?v=ab12cd34' (캐시 무효화)"""
    if path in ASSET_VER:
        return ASSET_VER[path]
    full = os.path.join(ROOT, path.lstrip('/'))
    try:
        with open(full, 'rb') as f:
            h = hashlib.md5(f.read()).hexdigest()[:8]
    except OSError:
        h = ''
    ASSET_VER[path] = path + ('?v=' + h if h else '')
    return ASSET_VER[path]


def card(p, featured=False):
    cls = 'card card--featured' if featured else 'card'
    thumb = av(p['thumbnail']) if p['thumbnail'] else '/assets/images/og-default.png'
    return fill(
        '<article class="%(cls)s">'
        '<a class="card__link" href="/posts/%(slug)s/">'
        '<div class="card__thumb"><img src="%(thumb)s" alt="%(title_attr)s" loading="lazy" width="1200" height="675"></div>'
        '<div class="card__body">'
        '<div class="card__meta"><span class="badge">%(category)s</span><time datetime="%(date)s">%(date_kr)s</time></div>'
        '<h2 class="card__title">%(title)s</h2>'
        '<p class="card__excerpt">%(summary)s</p>'
        '</div></a></article>' % {
            'cls': cls, 'slug': p['slug'], 'thumb': thumb,
            'title': esc(p['title']), 'title_attr': esc(p['title']),
            'category': esc(p['category']), 'date': p['date'],
            'date_kr': korean_date(p['date']), 'summary': esc(p['summary']),
        }, {})


def absolutize(html_text):
    """피드 리더가 상대경로를 못 풀는 경우를 막기 위해 /... 절대경로를 사이트 URL로 바꾼다."""
    return re.sub(r'(src|href)="(/(?!/)[^"]*)"',
                  lambda m: '%s="%s%s"' % (m.group(1), SITE['url'], m.group(2)),
                  html_text)


def subscribe_block(where=''):
    """RSS + JSON Feed 구독 박스. 포스트 하단과 /about/에서 같은 마크업을 쓴다."""
    import urllib.parse
    mail = 'mailto:%s?subject=%s&body=%s' % (
        SITE['email'],
        urllib.parse.quote(SUBSCRIBE_MAIL_SUBJECT),
        urllib.parse.quote(SUBSCRIBE_MAIL_BODY),
    )
    anchor = ' id="subscribe"' if where == 'about' else ''
    return (
        '<aside class="subscribe"%s>'
        '<div class="subscribe__copy">'
        '<div class="subscribe__label">SUBSCRIBE</div>'
        '<h2 class="subscribe__title">새 리포트를 받아보세요</h2>'
        '<p class="subscribe__desc">RSS 리더기나 JSON 피드를 읽는 앱에 주소를 넣으면 새 글이 발행될 때마다 자동으로 들어옵니다. '
        '메일 알림을 원하시면 아래 구독 신청을 눌러 한 통만 보내주세요.</p>'
        '</div>'
        '<div class="subscribe__actions">'
        '<a class="subbtn" href="/feed.xml">'
        '<span class="subbtn__k">RSS</span><span class="subbtn__v">/feed.xml</span></a>'
        '<a class="subbtn" href="/feed.json">'
        '<span class="subbtn__k">JSON FEED</span><span class="subbtn__v">/feed.json</span></a>'
        '<a class="subbtn subbtn--mail" href="%s">'
        '<span class="subbtn__k">EMAIL</span><span class="subbtn__v">구독 신청 메일</span></a>'
        '</div>'
        '<p class="subscribe__note">보내주신 주소는 알림 발송에만 쓰고 공개하지 않습니다. 언제든 한 통으로 해지됩니다.</p>'
        '</aside>' % (anchor, mail)
    )


def tip_block():
    """후원 지갑이 설정된 경우에만 렌더한다. TIP_WALLETS가 비어 있으면 빈 문자열."""
    rows = [(label, addr.strip()) for label, addr in TIP_WALLETS if addr and addr.strip()]
    if not rows:
        return ''
    items = ''.join(
        '<div class="tip__row"><span class="tip__k">%s</span>'
        '<code class="tip__addr" data-addr="%s">%s</code>'
        '<button class="tip__copy" type="button" data-copy="%s">COPY</button></div>'
        % (esc(label), esc(addr), esc(addr), esc(addr))
        for label, addr in rows)
    note = '<p class="tip__note">%s</p>' % esc(TIP_NOTE) if TIP_NOTE else ''
    return (
        '<aside class="tip">'
        '<div class="subscribe__label">SUPPORT</div>'
        '<h2 class="tip__title">리포트가 도움이 됐다면</h2>'
        '<p class="tip__desc">광고 없이 운영합니다. 후원은 아래 지갑 주소로만 받고, 받은 내역을 조건으로 한 대가성 홍보는 넣지 않습니다.</p>'
        '%s%s</aside>' % (items, note)
    )


def write(path, content):
    full = os.path.join(ROOT, path)
    os.makedirs(os.path.dirname(full) or '.', exist_ok=True)
    with open(full, 'w', encoding='utf-8') as f:
        f.write(content)
    return full


def main():
    posts = load_posts()
    base = tpl('base.html')
    nav_active = {}

    def page(path, title, description, content, active='', extra_head='', canonical=None, og_image=None,
             title_raw=None, og_type='website', og_title=None):
        if title_raw:
            full_title = title_raw
        elif title == '홈':
            full_title = '%s — 사이버보안 · AI 엔지니어링 저널' % SITE['name']
        else:
            full_title = '%s — %s' % (title, SITE['name'])
        ctx = {
            'site_title': SITE['title'],
            'site_name': SITE['name'],
            'tagline': SITE['tagline'],
            'page_title': title,
            'full_title': esc(full_title),
            'description': esc(description),
            'content': content,
            'nav_home': 'is-active' if active == 'home' else '',
            'nav_archive': 'is-active' if active == 'archive' else '',
            'year': datetime.date.today().year,
            'author': SITE['author'],
            'email': SITE['email'],
            'canonical': canonical or (SITE['url'] + '/' + path.replace('index.html', '')),
            'og_title': esc(og_title or full_title),
            'og_image': og_image or (SITE['url'] + '/assets/images/og-default.png'),
            'extra_head': extra_head,
            'site_url': SITE['url'],
            'og_type': og_type,
            'css': av('/assets/css/style.css'),
            'js': av('/assets/js/main.js'),
        }
        write(path, fill(base, ctx))

    if not posts:
        page('index.html', '아카이브 준비 중', SITE['desc'],
             '<section class="empty"><h1>아직 발행된 리포트가 없습니다.</h1></section>', 'home')
        return

    # ---- home
    lead = posts[0]
    rest = posts[1:]
    home_inner = (
        '<section class="lead">%s</section>'
        '<section class="grid">%s</section>' % (card(lead, featured=True), ''.join(card(p) for p in rest))
    )
    page('index.html', '홈', SITE['desc'],
         fill(tpl('index.html'), {'lead_and_grid': home_inner}),
         'home', og_image=(SITE['url'] + lead['thumbnail']) if lead['thumbnail'] else '',
         title_raw='%s — 사이버보안 · AI 엔지니어링 저널' % SITE['name'])

    # ---- posts
    post_tpl = tpl('post.html')
    for idx, p in enumerate(posts):
        prev_p = posts[idx + 1] if idx + 1 < len(posts) else None   # older
        next_p = posts[idx - 1] if idx > 0 else None                # newer
        tags_html = ''.join('<span class="tag">#%s</span>' % esc(t) for t in p['tags'])
        pager = ''
        if next_p or prev_p:
            pager = '<nav class="pager">'
            if prev_p:
                pager += ('<a class="pager__item" href="/posts/%s/"><span>이전 글</span><strong>%s</strong></a>'
                          % (prev_p['slug'], esc(prev_p['title'])))
            if next_p:
                pager += ('<a class="pager__item pager__item--next" href="/posts/%s/"><span>다음 글</span><strong>%s</strong></a>'
                          % (next_p['slug'], esc(next_p['title'])))
            pager += '</nav>'

        article = fill(post_tpl, {
            'title': esc(p['title']),
            'category': esc(p['category']),
            'date': p['date'],
            'date_long': long_date(p['date']),
            'author': esc(p['author']),
            'reading': p['reading'],
            'thumbnail': av(p['thumbnail']) if p['thumbnail'] else '',
            'summary': esc(p['summary']),
            'body': p['body_html'],
            'tags': tags_html,
            'pager': pager,
            'subscribe': subscribe_block(),
            'tip': tip_block(),
            'canonical_post': '%s/posts/%s/' % (SITE['url'], p['slug']),
            'site_url': SITE['url'],
            'title_json': json.dumps(p['title'], ensure_ascii=False).replace('</', '<\\/'),
            'summary_json': json.dumps(p['summary'], ensure_ascii=False).replace('</', '<\\/'),
        })
        desc = p['summary'] or SITE['desc']
        # 검색엔진 <title>은 60자 이내로 유지한다 (Bing "Title too long" 대응).
        # 사이트명은 og:site_name에 이미 있으므로 포스트 페이지 제목에는 붙이지 않는다.
        head_title = p['seo_title'] or p['title']
        if len(head_title) > 60:
            stripped = re.sub(r'^\[[^\]]{1,12}\]\s*', '', head_title)
            if len(stripped) <= 60:
                head_title = stripped   # 앞쪽 [침해 분석] 같은 머리표만 덜어낸다 (카테고리는 뱃지에 있음)
            else:
                head_title = stripped[:57].rstrip() + '…'
        page('posts/%s/index.html' % p['slug'], p['title'], desc, article, '',
             canonical='%s/posts/%s/' % (SITE['url'], p['slug']),
             og_image=(SITE['url'] + p['thumbnail']) if p['thumbnail'] else '',
             title_raw=head_title, og_type='article', og_title=p['title'])

    # ---- archive
    rows = []
    for p in posts:
        rows.append(
            '<li class="row"><a href="/posts/%s/">'
            '<time datetime="%s">%s</time>'
            '<span class="row__cat">%s</span>'
            '<span class="row__title">%s</span>'
            '</a></li>' % (p['slug'], p['date'], korean_date(p['date']), esc(p['category']), esc(p['title'])))
    page('archive/index.html', '아카이브', '발행된 모든 리포트 목록.',
         fill(tpl('archive.html'), {'rows': ''.join(rows), 'count': len(posts)}), 'archive')

    # ---- about
    page('about/index.html', '소개', 'DOHYEON TECH BRIEF 소개와 운영 원칙.',
         fill(tpl('about.html'), {'count': len(posts),
                                  'subscribe': subscribe_block('about'),
                                  'tip': tip_block()}), '')

    # ---- 404
    write('404.html', fill(base, {
        'site_title': SITE['title'], 'site_name': SITE['name'], 'tagline': SITE['tagline'],
        'page_title': '404', 'description': '페이지를 찾을 수 없습니다.',
        'content': tpl('404.html'), 'nav_home': '', 'nav_archive': '',
        'year': datetime.date.today().year, 'author': SITE['author'], 'email': SITE['email'],
        'canonical': SITE['url'] + '/', 'og_image': SITE['url'] + '/assets/images/og-default.png',
        'extra_head': '', 'full_title': '페이지를 찾을 수 없습니다 — ' + SITE['name'],
        'site_url': SITE['url'], 'css': av('/assets/css/style.css'), 'js': av('/assets/js/main.js'),
    }))

    # ---- feed.xml
    items = []
    for p in posts:
        link = '%s/posts/%s/' % (SITE['url'], p['slug'])
        items.append(
            '<item>'
            '<title>%s</title><link>%s</link><guid isPermaLink="true">%s</guid>'
            '<pubDate>%s</pubDate><category>%s</category>'
            '<description>%s</description>'
            '</item>' % (esc(p['title']), link, link, rfc822(p['date'], p.get('time')),
                         esc(p['category']), esc(p['summary'])))
    feed = ('<?xml version="1.0" encoding="UTF-8"?>\n'
            '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n<channel>\n'
            '<title>%s</title>\n<link>%s/</link>\n<description>%s</description>\n'
            '<language>ko</language>\n<lastBuildDate>%s</lastBuildDate>\n'
            '<atom:link href="%s/feed.xml" rel="self" type="application/rss+xml"/>\n'
            '%s\n</channel>\n</rss>\n') % (
        esc(SITE['name']), SITE['url'], esc(SITE['desc']),
        (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=9)).strftime('%a, %d %b %Y %H:%M:%S +0900'),
        SITE['url'], '\n'.join(items))
    write('feed.xml', feed)

    # ---- feed.json (JSON Feed 1.1)
    jitems = []
    for p in posts:
        link = '%s/posts/%s/' % (SITE['url'], p['slug'])
        try:
            stamp = '%sT%s:00+09:00' % (p['date'], p.get('time') or '00:00')
        except (TypeError, ValueError):
            stamp = '%sT00:00:00+09:00' % p['date']
        item = {
            'id': link,
            'url': link,
            'title': p['title'],
            'summary': p['summary'],
            'content_html': absolutize(p['body_html']),
            'date_published': stamp,
            'authors': [{'name': p['author']}],
            'tags': p['tags'],
        }
        if p['thumbnail']:
            item['image'] = SITE['url'] + p['thumbnail']
        jitems.append(item)
    jfeed = {
        'version': 'https://jsonfeed.org/version/1.1',
        'title': SITE['name'],
        'home_page_url': SITE['url'] + '/',
        'feed_url': SITE['url'] + '/feed.json',
        'description': SITE['desc'],
        'language': SITE['lang'],
        'icon': SITE['url'] + '/assets/images/favicon.png',
        'authors': [{'name': SITE['author'], 'url': SITE['url'] + '/about/'}],
        'items': jitems,
    }
    write('feed.json', json.dumps(jfeed, ensure_ascii=False, indent=2) + '\n')

    # ---- sitemap.xml
    urls = [('%s/' % SITE['url'], posts[0]['date'], '1.0', 'daily'),
            ('%s/archive/' % SITE['url'], posts[0]['date'], '0.6', 'daily'),
            ('%s/about/' % SITE['url'], posts[0]['date'], '0.4', 'monthly')]
    for p in posts:
        urls.append(('%s/posts/%s/' % (SITE['url'], p['slug']), p['date'], '0.9', 'monthly'))
    sm = ['<?xml version="1.0" encoding="UTF-8"?>',
          '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for u, d, pr, ch in urls:
        sm.append('<url><loc>%s</loc><lastmod>%s</lastmod><priority>%s</priority><changefreq>%s</changefreq></url>'
                  % (u, d, pr, ch))
    sm.append('</urlset>')
    write('sitemap.xml', '\n'.join(sm))

    # ---- robots.txt
    write('robots.txt',
          'User-agent: *\nAllow: /\n\nSitemap: %s/sitemap.xml\n' % SITE['url'])
    # ---- keep Pages from running Jekyll
    write('.nojekyll', '')

    print('built %d posts -> index.html, posts/, archive/, about/, feed.xml, sitemap.xml' % len(posts))


def new_post(title):
    """Create posts/YYYY-MM-DD-slug.md skeleton."""
    today = datetime.date.today().isoformat()
    slug = re.sub(r'[^a-z0-9]+', '-', title.lower()).strip('-') or 'post'
    path = os.path.join(POSTS_DIR, '%s-%s.md' % (today, slug))
    tpl_text = ('---\n'
                'title: "%s"\n'
                'slug: %s\n'
                'date: "%s"\n'
                'category: "제로데이"\n'
                'tags: []\n'
                'thumbnail: /assets/images/thumb_example.png\n'
                'summary: ""\n'
                'author: "김도현"\n'
                '---\n\n'
                '## 1. 위협 개요\n\n\n## 2. 취약 지점\n\n\n## 3. 익스플로잇 메커니즘\n\n\n## 4. 패치·완화책\n') % (
        title, slug, today)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(tpl_text)
    print('created', path)


if __name__ == '__main__':
    if len(sys.argv) > 2 and sys.argv[1] == '--new':
        new_post(sys.argv[2])
    else:
        main()
