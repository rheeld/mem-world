from __future__ import annotations

import logging
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .config import Config
from .vault import VAULT_EXTS, start_watcher
from .world import World

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

DRIFT_INTERVAL_S = 180.0

world: World | None = None
observer = None
stop_drift = threading.Event()


def _drift_loop() -> None:
    while not stop_drift.wait(DRIFT_INTERVAL_S):
        try:
            if world is not None and not world.scanning:
                world.drift_step()
        except Exception:
            logging.getLogger("memworld").exception("drift step failed")


@asynccontextmanager
async def lifespan(app: FastAPI):
    global world, observer
    world = World(Config.from_env())
    # first scan loads the embedding model; don't block startup
    threading.Thread(target=world.scan, daemon=True).start()
    threading.Thread(target=_drift_loop, daemon=True).start()
    observer = start_watcher(world)
    yield
    stop_drift.set()
    if observer is not None:
        observer.stop()


app = FastAPI(title="mem-world", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)


def _world() -> World:
    if world is None:
        raise HTTPException(503, "world not ready")
    return world


class CreateNote(BaseModel):
    title: str
    content: str = ""
    pos: list[float] | None = None


class SetPosition(BaseModel):
    pos: list[float]
    pinned: bool = True


@app.get("/api/status")
def status():
    w = _world()
    count = w.db.execute("SELECT COUNT(*) AS n FROM items").fetchone()["n"]
    return {
        "rev": w.rev,
        "items": count,
        "scanning": w.scanning,
        "model": w.cfg.model,
        "model_loaded": w.embedder.loaded,
        "vault": str(w.cfg.vault),
    }


@app.get("/api/world")
def get_world(since: int | None = None):
    w = _world()
    if since is not None and since == w.rev:
        return {"rev": w.rev, "unchanged": True}
    return w.world_state()


@app.get("/api/items/{item_id}")
def get_item(item_id: int):
    item = _world().get_item(item_id)
    if item is None:
        raise HTTPException(404, "no such item")
    return item


@app.post("/api/items")
def create_item(body: CreateNote):
    if not body.title.strip():
        raise HTTPException(422, "title required")
    return _world().create_note(body.title.strip(), body.content, body.pos)


@app.post("/api/upload")
async def upload_file(file: UploadFile = File(...), pos: str | None = Form(None)):
    import json
    from pathlib import Path

    w = _world()
    name = Path(file.filename or "dropped").name.replace("/", "_")
    suffix = Path(name).suffix.lower()
    if suffix not in VAULT_EXTS:
        raise HTTPException(422, f"unsupported file type: {suffix or '(none)'}")
    inbox = w.cfg.vault / "inbox"
    inbox.mkdir(parents=True, exist_ok=True)
    dest = inbox / name
    n = 2
    while dest.exists():
        dest = inbox / f"{Path(name).stem}-{n}{suffix}"
        n += 1
    dest.write_bytes(await file.read())
    w.scan()
    rel = str(dest.relative_to(w.cfg.vault))
    row = w.db.execute("SELECT id FROM items WHERE path=?", (rel,)).fetchone()
    if row is None:
        raise HTTPException(500, "file saved but failed to ingest")
    if pos:
        try:
            w.set_position(row["id"], json.loads(pos), pinned=True)
        except (ValueError, TypeError):
            pass
    return w.get_item(row["id"])


class UpdateNote(BaseModel):
    content: str


@app.put("/api/items/{item_id}")
def update_item(item_id: int, body: UpdateNote):
    try:
        item = _world().update_note(item_id, body.content)
    except ValueError as e:
        raise HTTPException(422, str(e))
    if item is None:
        raise HTTPException(404, "no such item")
    return item


@app.delete("/api/items/{item_id}")
def delete_item(item_id: int):
    if not _world().delete_item(item_id):
        raise HTTPException(404, "no such item")
    return {"ok": True}


@app.get("/api/items/{item_id}/file")
def get_item_file(item_id: int):
    w = _world()
    r = w.db.execute("SELECT path FROM items WHERE id=?", (item_id,)).fetchone()
    if r is None:
        raise HTTPException(404, "no such item")
    f = w.cfg.vault / r["path"]
    if not f.exists():
        raise HTTPException(404, "file missing from vault")
    import mimetypes

    media = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
    return FileResponse(str(f), media_type=media, filename=f.name)


@app.patch("/api/items/{item_id}/position")
def set_position(item_id: int, body: SetPosition):
    item = _world().set_position(item_id, body.pos, body.pinned)
    if item is None:
        raise HTTPException(404, "no such item")
    return item


@app.get("/api/search")
def search(q: str, k: int = 12):
    if not q.strip():
        return {"results": []}
    return {"results": _world().search(q.strip(), k)}
