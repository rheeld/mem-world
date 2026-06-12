"""Fetch Wikipedia's Vital Articles (level 4, ~10k) into the mem-world vault.

Articles arrive as markdown files under vault/wiki/<topic>/, with the intro
extract as the body and tags [wikipedia, <topic>]. Files are written to a
staging dir first and moved into the vault at the end, so the watcher sees
one bulk arrival and runs one layout instead of dozens.

Run with the backend's venv python:
  /Users/rhee/claude/mem-world/backend/.venv/bin/python scripts/fetch_wikipedia_vital.py
"""

from __future__ import annotations

import json
import re
import shutil
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

API = "https://en.wikipedia.org/w/api.php"
UA = {"User-Agent": "mem-world-personal-vault/0.1 (rheedan@dixonai.com)"}
ROOT_CAT = "Category:Wikipedia level-4 vital articles by topic"
STAGING = Path("/tmp/memworld-wiki-staging")
VAULT_WIKI = Path(__file__).resolve().parents[1] / "vault" / "wiki"


def api(params: dict) -> dict:
    qs = urllib.parse.urlencode({**params, "format": "json"})
    req = urllib.request.Request(f"{API}?{qs}", headers=UA)
    last: Exception | None = None
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read())
        except Exception as e:  # noqa: BLE001 — retry everything politely
            last = e
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"api failed: {params}: {last}")


def category_members(cat: str, cmtype: str) -> list[str]:
    out: list[str] = []
    cont: dict = {}
    while True:
        data = api(
            {
                "action": "query",
                "list": "categorymembers",
                "cmtitle": cat,
                "cmlimit": "500",
                "cmtype": cmtype,
                **cont,
            }
        )
        out += [m["title"] for m in data["query"]["categorymembers"]]
        if "continue" not in data:
            return out
        cont = {"cmcontinue": data["continue"]["cmcontinue"]}


def fetch_extracts(titles: list[str]) -> dict[str, str]:
    """Intro extracts (plain text) for up to 20 titles per request."""
    data = api(
        {
            "action": "query",
            "prop": "extracts",
            "exintro": "1",
            "explaintext": "1",
            "exlimit": "max",
            "redirects": "1",
            "titles": "|".join(titles),
        }
    )
    pages = data.get("query", {}).get("pages", {})
    return {p["title"]: p.get("extract", "") for p in pages.values() if "title" in p}


def slugify(s: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
    return s[:80] or "article"


def write_article(topic_dir: Path, title: str, extract: str) -> bool:
    extract = extract.strip()
    if len(extract) < 80:  # stubs and disambiguation noise
        return False
    slug = slugify(title)
    path = topic_dir / f"{slug}.md"
    n = 2
    while path.exists():
        path = topic_dir / f"{slug}-{n}.md"
        n += 1
    url = "https://en.wikipedia.org/wiki/" + urllib.parse.quote(title.replace(" ", "_"))
    tag = topic_dir.name
    path.write_text(
        f"---\ntitle: {json.dumps(title)}\ntags:\n- wikipedia\n- {tag}\n---\n\n"
        f"# {title}\n\n{extract}\n\n[Read on Wikipedia]({url})\n"
    )
    return True


def main() -> None:
    print("listing vital-article topics…")
    subcats = category_members(ROOT_CAT, "subcat")
    topics: list[tuple[str, list[str]]] = []
    seen_titles: set[str] = set()
    sources = subcats if subcats else [ROOT_CAT]
    for cat in sources:
        m = re.search(r" in (.+)$", cat)
        topic = slugify(m.group(1)) if m else "general"
        members = category_members(cat, "page")
        titles = []
        for t in members:
            t = t.removeprefix("Talk:")
            if t and t not in seen_titles:
                seen_titles.add(t)
                titles.append(t)
        if titles:
            topics.append((topic, titles))
            print(f"  {topic}: {len(titles)} articles")
    total = sum(len(t) for _, t in topics)
    print(f"{total} articles across {len(topics)} topics")

    if STAGING.exists():
        shutil.rmtree(STAGING)
    STAGING.mkdir(parents=True)

    written = 0
    lock_print = 0

    def handle(topic: str, batch: list[str]) -> int:
        extracts = fetch_extracts(batch)
        topic_dir = STAGING / topic
        topic_dir.mkdir(parents=True, exist_ok=True)
        n = 0
        for title in batch:
            if write_article(topic_dir, title, extracts.get(title, "")):
                n += 1
        return n

    jobs: list[tuple[str, list[str]]] = []
    for topic, titles in topics:
        for i in range(0, len(titles), 20):
            jobs.append((topic, titles[i : i + 20]))

    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(handle, topic, batch) for topic, batch in jobs]
        for i, fut in enumerate(futures):
            written += fut.result()
            if i - lock_print >= 25:
                lock_print = i
                print(f"  fetched {written} articles…")

    print(f"staged {written} articles; moving into the vault…")
    VAULT_WIKI.mkdir(parents=True, exist_ok=True)
    for topic_dir in STAGING.iterdir():
        dest = VAULT_WIKI / topic_dir.name
        if dest.exists():
            for f in topic_dir.iterdir():
                shutil.move(str(f), dest / f.name)
        else:
            shutil.move(str(topic_dir), dest)
    shutil.rmtree(STAGING, ignore_errors=True)
    print(f"done: {written} articles in {VAULT_WIKI}")


if __name__ == "__main__":
    sys.exit(main())
