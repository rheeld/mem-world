from __future__ import annotations

import json
import logging
import re
import threading
from pathlib import Path

import numpy as np

from . import db as dbm
from . import layout
from .config import Config
from .embeddings import Embedder
from .vault import MD_EXTS, Parsed, content_hash, iter_vault_files, parse_file

log = logging.getLogger("memworld.world")

EMBED_TEXT_LIMIT = 6000


class World:
    """Single orchestrator: vault files -> embeddings -> positions -> API state.
    All mutations hold the lock and bump the rev counter."""

    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.lock = threading.RLock()
        self.db = dbm.connect(cfg.db_path)
        self.embedder = Embedder(cfg.model)
        self.scanning = False

    # -- meta -----------------------------------------------------------

    @property
    def rev(self) -> int:
        row = self.db.execute("SELECT value FROM meta WHERE key='rev'").fetchone()
        return int(row["value"]) if row else 0

    def _bump(self) -> None:
        self.db.execute(
            "INSERT INTO meta(key, value) VALUES ('rev', '1') "
            "ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1"
        )
        self.db.commit()

    def _ensure_vec(self) -> None:
        dbm.ensure_vec_table(self.db, self.embedder.dim)

    # -- ingest ----------------------------------------------------------

    def scan(self) -> None:
        """Full vault sweep: ingest new/changed files, drop deleted ones,
        then run a layout pass. Hash-gated, so cheap when nothing changed.
        Parsing and embedding happen OUTSIDE the lock (a bulk import would
        otherwise block the API for minutes) and embedding is batched."""
        self.scanning = True
        try:
            with self.lock:
                known = {
                    r["path"]: dict(r)
                    for r in self.db.execute("SELECT id, path, content_hash FROM items")
                }
            seen: set[str] = set()
            pending: list[tuple[Path, str, str, Parsed]] = []
            for f in iter_vault_files(self.cfg.vault):
                rel = str(f.relative_to(self.cfg.vault))
                seen.add(rel)
                h = content_hash(f)
                row = known.get(rel)
                if row is None or row["content_hash"] != h:
                    parsed = parse_file(f)
                    if parsed is not None:
                        pending.append((f, rel, h, parsed))
            removed = [row for rel, row in known.items() if rel not in seen]
            if not pending and not removed:
                # files unchanged, but a re-layout may have been requested by
                # nulling positions (or a previous layout crashed midway)
                with self.lock:
                    n_unpositioned = self.db.execute(
                        "SELECT COUNT(*) AS n FROM items WHERE x IS NULL"
                    ).fetchone()["n"]
                    if n_unpositioned:
                        self._layout_pass()
                        self.db.commit()
                        self._bump()
                return

            vecs = None
            if pending:
                texts = [
                    f"{p.title}\n{' '.join(p.tags)}\n{p.text}"[:EMBED_TEXT_LIMIT]
                    for _, _, _, p in pending
                ]
                chunks = []
                batch = 128
                for i in range(0, len(texts), batch):
                    chunks.append(self.embedder.embed(texts[i : i + batch]))
                    if len(texts) > 500:
                        log.info("embedded %d/%d", min(i + batch, len(texts)), len(texts))
                vecs = np.vstack(chunks)

            with self.lock:
                if pending:
                    self._ensure_vec()
                    for (f, rel, h, parsed), vec in zip(pending, vecs):
                        self._upsert(f, rel, h, parsed, vec)
                for row in removed:
                    self.db.execute("DELETE FROM items WHERE id=?", (row["id"],))
                    if dbm.has_vec_table(self.db):
                        self.db.execute(
                            "DELETE FROM item_vec WHERE item_id=?", (row["id"],)
                        )
                self._rebuild_links()
                self._layout_pass()
                self.db.commit()
                self._bump()
        finally:
            self.scanning = False

    def _upsert(self, f: Path, rel: str, h: str, parsed: Parsed, vec: np.ndarray) -> bool:
        st = f.stat()
        existing = self.db.execute("SELECT id FROM items WHERE path=?", (rel,)).fetchone()
        if existing:
            item_id = existing["id"]
            self.db.execute(
                "UPDATE items SET kind=?, title=?, tags=?, text=?, link_targets=?, "
                "content_hash=?, modified_at=? WHERE id=?",
                (
                    parsed.kind,
                    parsed.title,
                    json.dumps(parsed.tags),
                    parsed.text,
                    json.dumps(parsed.link_targets),
                    h,
                    st.st_mtime,
                    item_id,
                ),
            )
            # content changed -> meaning may have moved; unpinned items get
            # re-placed by the layout pass (the frontend glides them over)
            self.db.execute(
                "UPDATE items SET x=NULL, y=NULL, z=NULL WHERE id=? AND pinned=0",
                (item_id,),
            )
        else:
            cur = self.db.execute(
                "INSERT INTO items(path, kind, title, tags, text, link_targets, "
                "content_hash, created_at, modified_at) VALUES (?,?,?,?,?,?,?,?,?)",
                (
                    rel,
                    parsed.kind,
                    parsed.title,
                    json.dumps(parsed.tags),
                    parsed.text,
                    json.dumps(parsed.link_targets),
                    h,
                    st.st_mtime,
                    st.st_mtime,
                ),
            )
            item_id = cur.lastrowid
        self.db.execute("DELETE FROM item_vec WHERE item_id=?", (item_id,))
        self.db.execute(
            "INSERT INTO item_vec(item_id, embedding) VALUES (?,?)",
            (item_id, vec.astype(np.float32).tobytes()),
        )
        log.info("ingested %s (%s)", rel, parsed.kind)
        return True

    def _rebuild_links(self) -> None:
        items = self.db.execute("SELECT id, title, path, link_targets FROM items").fetchall()
        by_key: dict[str, int] = {}
        for r in items:
            by_key[r["title"].strip().lower()] = r["id"]
            by_key[Path(r["path"]).stem.lower()] = r["id"]
        self.db.execute("DELETE FROM links")
        for r in items:
            for target in json.loads(r["link_targets"]):
                dst = by_key.get(target.strip().lower())
                if dst is not None and dst != r["id"]:
                    self.db.execute(
                        "INSERT OR IGNORE INTO links(src, dst, kind) VALUES (?,?,'wikilink')",
                        (r["id"], dst),
                    )

    # -- layout ----------------------------------------------------------

    def _load_vectors(self) -> dict[int, np.ndarray]:
        if not dbm.has_vec_table(self.db):
            return {}
        return {
            r["item_id"]: np.frombuffer(r["embedding"], dtype=np.float32)
            for r in self.db.execute("SELECT item_id, embedding FROM item_vec")
        }

    def _layout_pass(self) -> None:
        rows = self.db.execute("SELECT id, x, y, z, pinned FROM items").fetchall()
        vec_map = self._load_vectors()
        rows = [r for r in rows if r["id"] in vec_map]
        if not rows:
            return
        unpositioned = [r for r in rows if r["x"] is None]
        if not unpositioned:
            return
        # cold start / bulk arrival -> full layout; trickle -> incremental
        if len(unpositioned) >= max(3, 0.25 * len(rows)):
            log.info("full layout of %d items (UMAP + settle)…", len(rows))
            ids = [r["id"] for r in rows]
            vecs = np.stack([vec_map[i] for i in ids])
            pinned = {
                idx: np.array([r["x"], r["y"], r["z"]])
                for idx, r in enumerate(rows)
                if r["pinned"] and r["x"] is not None
            }
            pos = layout.full_layout(vecs, pinned=pinned)
            for idx, item_id in enumerate(ids):
                if idx in pinned:
                    continue
                self._write_position(item_id, pos[idx])
        else:
            placed = [r for r in rows if r["x"] is not None]
            anchor_vecs = np.stack([vec_map[r["id"]] for r in placed])
            anchor_pos = np.stack([[r["x"], r["y"], r["z"]] for r in placed])
            for r in unpositioned:
                p = layout.place_near(anchor_vecs, anchor_pos, vec_map[r["id"]])
                self._write_position(r["id"], p)

    def _write_position(self, item_id: int, pos: np.ndarray) -> None:
        self.db.execute(
            "UPDATE items SET x=?, y=?, z=? WHERE id=?",
            (float(pos[0]), float(pos[1]), float(pos[2]), item_id),
        )

    # -- queries ----------------------------------------------------------

    def world_state(self) -> dict:
        with self.lock:
            items = [
                self._item_summary(r)
                for r in self.db.execute("SELECT * FROM items WHERE x IS NOT NULL")
            ]
            links = [
                [r["src"], r["dst"]]
                for r in self.db.execute("SELECT src, dst FROM links")
            ]
            return {"rev": self.rev, "items": items, "links": links}

    @staticmethod
    def _item_summary(r) -> dict:
        return {
            "id": r["id"],
            "path": r["path"],
            "kind": r["kind"],
            "title": r["title"],
            "tags": json.loads(r["tags"]),
            "pos": [r["x"], r["y"], r["z"]],
            "pinned": bool(r["pinned"]),
        }

    def get_item(self, item_id: int) -> dict | None:
        with self.lock:
            r = self.db.execute("SELECT * FROM items WHERE id=?", (item_id,)).fetchone()
            if r is None:
                return None
            detail = self._item_summary(r)
            detail["links_out"] = [
                {"id": l["id"], "title": l["title"], "kind": l["kind"]}
                for l in self.db.execute(
                    "SELECT i.id, i.title, i.kind FROM links l "
                    "JOIN items i ON i.id = l.dst WHERE l.src=?",
                    (item_id,),
                )
            ]
            detail["links_in"] = [
                {"id": l["id"], "title": l["title"], "kind": l["kind"]}
                for l in self.db.execute(
                    "SELECT i.id, i.title, i.kind FROM links l "
                    "JOIN items i ON i.id = l.src WHERE l.dst=?",
                    (item_id,),
                )
            ]
            if Path(r["path"]).suffix.lower() in MD_EXTS:
                import frontmatter

                f = self.cfg.vault / r["path"]
                detail["content"] = (
                    frontmatter.load(str(f)).content if f.exists() else r["text"]
                )
            else:
                detail["content"] = r["text"][:5000]
            detail["modified_at"] = r["modified_at"]
            return detail

    def search(self, q: str, k: int = 12) -> list[dict]:
        with self.lock:
            if not dbm.has_vec_table(self.db):
                return []
            v = self.embedder.embed([q])[0]
            rows = self.db.execute(
                "SELECT item_id, distance FROM item_vec WHERE embedding MATCH ? AND k = ? "
                "ORDER BY distance",
                (v.astype(np.float32).tobytes(), k),
            ).fetchall()
            scored = {r["item_id"]: float(r["distance"]) for r in rows}
            # exact-ish title matches float to the top regardless of vector distance
            like = self.db.execute(
                "SELECT id FROM items WHERE title LIKE ? LIMIT ?", (f"%{q}%", k)
            ).fetchall()
            order = [r["id"] for r in like] + [
                i for i in scored if i not in {r["id"] for r in like}
            ]
            results = []
            for item_id in order[:k]:
                r = self.db.execute(
                    "SELECT * FROM items WHERE id=? AND x IS NOT NULL", (item_id,)
                ).fetchone()
                if r is not None:
                    s = self._item_summary(r)
                    s["distance"] = scored.get(item_id)
                    results.append(s)
            return results

    # -- mutations ---------------------------------------------------------

    def create_note(
        self, title: str, content: str = "", pos: list[float] | None = None
    ) -> dict:
        with self.lock:
            notes_dir = self.cfg.vault / "notes"
            notes_dir.mkdir(parents=True, exist_ok=True)
            slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-") or "note"
            path = notes_dir / f"{slug}.md"
            n = 2
            while path.exists():
                path = notes_dir / f"{slug}-{n}.md"
                n += 1
            path.write_text(f"# {title}\n\n{content}\n" if content else f"# {title}\n")
            self.scan()
            rel = str(path.relative_to(self.cfg.vault))
            row = self.db.execute("SELECT id FROM items WHERE path=?", (rel,)).fetchone()
            if row is None:
                raise RuntimeError(f"created note failed to ingest: {rel}")
            if pos is not None:
                self.set_position(row["id"], pos, pinned=True)
            item = self.get_item(row["id"])
            assert item is not None
            return item

    def drift_step(self) -> None:
        """One gentle settle iteration — the slow tectonic drift. Pinned items
        never move; the frontend animates the rest."""
        with self.lock:
            rows = self.db.execute(
                "SELECT id, x, y, z, pinned FROM items WHERE x IS NOT NULL"
            ).fetchall()
            vec_map = self._load_vectors()
            rows = [r for r in rows if r["id"] in vec_map]
            # drift is for living, human-scale worlds; at bulk-import scale the
            # per-tick settle would be too heavy (and the world is mostly static)
            if len(rows) < 5 or len(rows) > 4000:
                return
            ids = [r["id"] for r in rows]
            pos = np.array([[r["x"], r["y"], r["z"]] for r in rows])
            vecs = np.stack([vec_map[i] for i in ids])
            pinned = np.array([bool(r["pinned"]) for r in rows])
            new = layout.settle(
                pos, vecs, pinned, steps=1, attract=0.1, repel_total=0.15, max_step=0.0035
            )
            if float(np.abs(new - pos).max()) < 1e-7:
                return
            for i, item_id in enumerate(ids):
                if not pinned[i]:
                    self._write_position(item_id, new[i])
            self.db.commit()
            self._bump()

    def update_note(self, item_id: int, content: str) -> dict | None:
        with self.lock:
            r = self.db.execute("SELECT path FROM items WHERE id=?", (item_id,)).fetchone()
            if r is None:
                return None
            f = self.cfg.vault / r["path"]
            if f.suffix.lower() not in MD_EXTS:
                raise ValueError("only notes can be edited")
            import frontmatter

            post = frontmatter.load(str(f))
            post.content = content
            f.write_text(frontmatter.dumps(post) if post.metadata else content)
            self.scan()
            return self.get_item(item_id)

    def delete_item(self, item_id: int) -> bool:
        with self.lock:
            r = self.db.execute("SELECT path FROM items WHERE id=?", (item_id,)).fetchone()
            if r is None:
                return False
            f = self.cfg.vault / r["path"]
            if f.exists():
                f.unlink()
            self.scan()
            return True

    def set_position(self, item_id: int, pos: list[float], pinned: bool = True) -> dict | None:
        with self.lock:
            p = np.asarray(pos, dtype=np.float64)
            norm = np.linalg.norm(p)
            if norm == 0:
                raise ValueError("position must be a non-zero vector")
            p = p / norm
            self.db.execute(
                "UPDATE items SET x=?, y=?, z=?, pinned=? WHERE id=?",
                (float(p[0]), float(p[1]), float(p[2]), int(pinned), item_id),
            )
            self.db.commit()
            self._bump()
            return self.get_item(item_id)
