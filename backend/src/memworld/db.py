from __future__ import annotations

import sqlite3
from pathlib import Path

import sqlite_vec

SCHEMA = """
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  text TEXT NOT NULL DEFAULT '',
  link_targets TEXT NOT NULL DEFAULT '[]',
  content_hash TEXT NOT NULL,
  created_at REAL NOT NULL,
  modified_at REAL NOT NULL,
  x REAL, y REAL, z REAL,
  pinned INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS links (
  src INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  dst INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'wikilink',
  PRIMARY KEY (src, dst, kind)
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"""


def connect(path: Path) -> sqlite3.Connection:
    db = sqlite3.connect(str(path), check_same_thread=False)
    db.row_factory = sqlite3.Row
    db.enable_load_extension(True)
    sqlite_vec.load(db)
    db.enable_load_extension(False)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA foreign_keys=ON")
    db.executescript(SCHEMA)
    db.commit()
    return db


def ensure_vec_table(db: sqlite3.Connection, dim: int) -> None:
    db.execute(
        f"CREATE VIRTUAL TABLE IF NOT EXISTS item_vec USING vec0("
        f"item_id INTEGER PRIMARY KEY, embedding float[{dim}])"
    )
    db.commit()


def has_vec_table(db: sqlite3.Connection) -> bool:
    row = db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='item_vec'"
    ).fetchone()
    return row is not None
