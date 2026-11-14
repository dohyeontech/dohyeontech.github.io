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


def rfc822(d):
    try:
        dt = datetime.datetime.fromisoformat(d)
    except ValueError:
        dt = datetime.datetime(1970, 1, 1)
    return dt.strftime('%a, %d %b %Y 00:00:00 +0900')


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

    def page(path, title, description, content, active='', extra_head='', canonical=None, og_image=None):
        if title == '홈':
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
            'og_image': og_image or (SITE['url'] + '/assets/images/og-default.png'),
            'extra_head': extra_head,
            'site_url': SITE['url'],
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
         'home', og_image=(SITE['url'] + lead['thumbnail']) if lead['thumbnail'] else '')

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
            'canonical_post': '%s/posts/%s/' % (SITE['url'], p['slug']),
            'site_url': SITE['url'],
            'title_json': json.dumps(p['title'], ensure_ascii=False).replace('</', '<\\/'),
            'summary_json': json.dumps(p['summary'], ensure_ascii=False).replace('</', '<\\/'),
        })
        desc = p['summary'] or SITE['desc']
        page('posts/%s/index.html' % p['slug'], p['title'], desc, article, '',
             canonical='%s/posts/%s/' % (SITE['url'], p['slug']),
             og_image=(SITE['url'] + p['thumbnail']) if p['thumbnail'] else '')

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
         fill(tpl('about.html'), {'count': len(posts)}), '')

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
            '</item>' % (esc(p['title']), link, link, rfc822(p['date']),
                         esc(p['category']), esc(p['summary'])))
    feed = ('<?xml version="1.0" encoding="UTF-8"?>\n'
            '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n<channel>\n'
            '<title>%s</title>\n<link>%s/</link>\n<description>%s</description>\n'
            '<language>ko</language>\n<lastBuildDate>%s</lastBuildDate>\n'
            '<atom:link href="%s/feed.xml" rel="self" type="application/rss+xml"/>\n'
            '%s\n</channel>\n</rss>\n') % (
        esc(SITE['name']), SITE['url'], esc(SITE['desc']), rfc822(posts[0]['date']),
        SITE['url'], '\n'.join(items))
    write('feed.xml', feed)

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
