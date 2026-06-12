from __future__ import annotations

import hashlib
import logging
import re
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Iterator

from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

if TYPE_CHECKING:
    from .world import World

log = logging.getLogger("memworld.vault")

WIKILINK_RE = re.compile(r"\[\[([^\]|#\n]+)")
TAG_RE = re.compile(r"(?<![\w#])#([A-Za-z][\w/-]*)")
MD_EXTS = {".md", ".markdown"}
PDF_EXTS = {".pdf"}
IMG_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
VAULT_EXTS = MD_EXTS | PDF_EXTS | IMG_EXTS
PDF_MAX_PAGES = 30


@dataclass
class Parsed:
    kind: str
    title: str
    text: str
    tags: list[str] = field(default_factory=list)
    link_targets: list[str] = field(default_factory=list)


def content_hash(path: Path) -> str:
    return hashlib.sha1(path.read_bytes()).hexdigest()


def iter_vault_files(root: Path) -> Iterator[Path]:
    for p in sorted(root.rglob("*")):
        if not p.is_file() or p.suffix.lower() not in VAULT_EXTS:
            continue
        if any(part.startswith(".") for part in p.relative_to(root).parts):
            continue
        yield p


def parse_file(path: Path) -> Parsed | None:
    try:
        if path.suffix.lower() in MD_EXTS:
            return _parse_md(path)
        if path.suffix.lower() in PDF_EXTS:
            return _parse_pdf(path)
        if path.suffix.lower() in IMG_EXTS:
            return _parse_image(path)
    except Exception:
        log.exception("failed to parse %s", path)
    return None


def _parse_md(path: Path) -> Parsed:
    import frontmatter

    post = frontmatter.load(str(path))
    body = post.content
    title = post.get("title")
    if not title:
        m = re.search(r"^#\s+(.+)$", body, re.MULTILINE)
        title = m.group(1).strip() if m else path.stem.replace("-", " ").replace("_", " ")
    fm_tags = post.get("tags") or []
    if isinstance(fm_tags, str):
        fm_tags = [t.strip() for t in fm_tags.split(",") if t.strip()]
    tags = sorted({*[str(t) for t in fm_tags], *TAG_RE.findall(body)})
    links = [t.strip() for t in WIKILINK_RE.findall(body) if t.strip()]
    return Parsed("note", str(title), body, tags, links)


def _parse_pdf(path: Path) -> Parsed:
    from pypdf import PdfReader

    reader = PdfReader(str(path))
    chunks: list[str] = []
    for page in reader.pages[:PDF_MAX_PAGES]:
        try:
            text = page.extract_text()
        except Exception:
            text = None
        if text:
            chunks.append(text)
    title = None
    if reader.metadata and reader.metadata.title:
        title = str(reader.metadata.title).strip() or None
    return Parsed(
        "pdf", title or path.stem.replace("-", " ").replace("_", " "), "\n".join(chunks)
    )


def _parse_image(path: Path) -> Parsed:
    # no pixels are read; the filename carries the semantics (name files like
    # "van-gogh-the-starry-night.jpg" so the work lands near its artist)
    title = path.stem.replace("-", " ").replace("_", " ").strip()
    return Parsed("image", title.title(), title)


class VaultWatcher(FileSystemEventHandler):
    """Debounces filesystem events into a single rescan; rescans are cheap
    because ingest is content-hash gated."""

    def __init__(self, world: "World", debounce: float = 0.8):
        self.world = world
        self.debounce = debounce
        self._timer: threading.Timer | None = None
        self._lock = threading.Lock()

    def on_any_event(self, event) -> None:
        if event.is_directory:
            return
        path = str(getattr(event, "dest_path", "") or event.src_path)
        if ".memworld" in path or Path(path).suffix.lower() not in VAULT_EXTS:
            return
        with self._lock:
            if self._timer is not None:
                self._timer.cancel()
            self._timer = threading.Timer(self.debounce, self._rescan)
            self._timer.daemon = True
            self._timer.start()

    def _rescan(self) -> None:
        try:
            self.world.scan()
        except Exception:
            log.exception("rescan failed")


def start_watcher(world: "World") -> Observer:
    observer = Observer()
    observer.schedule(VaultWatcher(world), str(world.cfg.vault), recursive=True)
    observer.daemon = True
    observer.start()
    return observer
