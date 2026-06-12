from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]


@dataclass(frozen=True)
class Config:
    vault: Path
    db_path: Path
    model: str

    @classmethod
    def from_env(cls) -> "Config":
        vault = Path(os.environ.get("MEMWORLD_VAULT", str(REPO_ROOT / "vault"))).resolve()
        internal = vault / ".memworld"
        internal.mkdir(parents=True, exist_ok=True)
        db_path = Path(os.environ.get("MEMWORLD_DB", str(internal / "index.db")))
        model = os.environ.get("MEMWORLD_MODEL", "sentence-transformers/all-MiniLM-L6-v2")
        return cls(vault=vault, db_path=db_path, model=model)
