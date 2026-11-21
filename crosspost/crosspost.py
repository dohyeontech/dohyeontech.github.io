#!/usr/bin/env python3
"""Cross-post a Korean blog article (English adaptation) to Dev.to and Hashnode.

Both targets get canonical_url pointing at https://dohyeontech.github.io so the
original stays the indexed copy, and a visible link back to the original at the
bottom of the body.

Usage:
    ./crosspost.py devto <file.md> [--draft]
    ./crosspost.py hashnode <file.md> [--draft]
    ./crosspost.py both <file.md> [--draft]

<file.md> is a crosspost source with YAML front matter:
    title, subtitle, cover_image, tags (list), canonical_url, source_ko
"""
import argparse
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

SECRETS = Path("/workspace/.secrets")
DEVTO_KEY = SECRETS / "devto_api_key"
HASHNODE_TOKEN = SECRETS / "hashnode_token"
HASHNODE_PUBLICATION = SECRETS / "hashnode_publication_id"
ORIGIN = "https://dohyeontech.github.io"


def read_front_matter(path: Path):
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---"):
        raise SystemExit(f"{path}: no front matter")
    _, fm, body = text.split("---", 2)
    meta = {}
    for line in fm.strip().splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        key, value = key.strip(), value.strip()
        if value.startswith("[") and value.endswith("]"):
            meta[key] = [v.strip().strip('"') for v in value[1:-1].split(",") if v.strip()]
        else:
            meta[key] = value.strip('"')
    return meta, body.strip()


def ensure_source_link(body: str, meta: dict, slug: str) -> str:
    """Hashnode needs the explicit backlink in the body; Dev.to gets it too so the
    rendered page always shows the original even if canonical is ignored."""
    if slug in body:
        return body
    ko = meta.get("source_ko") or f"{ORIGIN}/"
    return f"{body}\n\n*Originally published in Korean at [dohyeontech.github.io]({ko}).*"


def post_json(url, payload, headers, timeout=60):
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={
            "Content-Type": "application/json",
            # dev.to sits behind Cloudflare; the default urllib UA gets a 403.
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/140.0 Safari/537.36",
            **headers,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, {"error": e.read().decode(errors="replace")}


def publish_devto(meta, body, draft=False, slug_for_link=""):
    key = DEVTO_KEY.read_text().strip()
    tags = [t.lower() for t in meta.get("tags", [])][:4]
    payload = {
        "article": {
            "title": meta["title"],
            "body_markdown": ensure_source_link(body, meta, slug_for_link),
            "published": not draft,
            "tags": tags,
            "canonical_url": meta["canonical_url"],
            "description": meta.get("subtitle", ""),
        }
    }
    if meta.get("cover_image"):
        payload["article"]["main_image"] = meta["cover_image"]
    status, data = post_json("https://dev.to/api/articles", payload, {"api-key": key})
    if status not in (200, 201):
        raise SystemExit(f"dev.to publish failed {status}: {data}")
    return data


def publish_hashnode(meta, body, draft=False, slug_for_link=""):
    token = HASHNODE_TOKEN.read_text().strip()
    pub_id = HASHNODE_PUBLICATION.read_text().strip()
    hashnode_body = ensure_source_link(body, meta, slug_for_link)
    if meta.get("cover_image"):
        hashnode_body = f"![cover]({meta['cover_image']})\n\n{hashnode_body}"
    query = """
    mutation PublishPost($input: PublishPostInput!) {
      publishPost(input: $input) {
        post { id slug url canonicalUrl }
      }
    }"""
    variables = {
        "input": {
            "title": meta["title"],
            "publicationId": pub_id,
            "contentMarkdown": hashnode_body,
            "canonicalUrl": meta["canonical_url"],
            "tags": [{"slug": t, "name": t} for t in meta.get("tags", [])],
            "subtitle": meta.get("subtitle", ""),
            "disableComments": False,
        }
    }
    if draft:
        variables["input"]["publishedAt"] = None
    status, data = post_json(
        "https://gql.hashnode.com",
        {"query": query, "variables": variables},
        {"Authorization": token},
    )
    if status != 200 or "errors" in data:
        raise SystemExit(f"hashnode publish failed {status}: {data}")
    return data


def slug_of(meta):
    m = re.search(r"/posts/([^/]+)/?", meta.get("canonical_url", ""))
    return m.group(1) if m else ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("target", choices=["devto", "hashnode", "both"])
    ap.add_argument("file")
    ap.add_argument("--draft", action="store_true")
    args = ap.parse_args()

    meta, body = read_front_matter(Path(args.file))
    slug = slug_of(meta)
    out = {}
    if args.target in ("devto", "both"):
        data = publish_devto(meta, body, args.draft, slug)
        out["devto"] = {"url": data.get("url"), "id": data.get("id"), "canonical_url": data.get("canonical_url")}
    if args.target in ("hashnode", "both"):
        data = publish_hashnode(meta, body, args.draft, slug)
        out["hashnode"] = data["data"]["publishPost"]["post"]
    print(json.dumps(out, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    sys.exit(main())
