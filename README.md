# mem·world

A second brain on a sphere. Notes and PDFs you drop into a vault are embedded
locally, arranged on a globe by semantic similarity, and rendered as a vintage
cartographic world — islands form where knowledge clusters.

See `DESIGN.md` for the full design.

## Quick start

```sh
# backend (Python 3.12 via uv)
uv sync --directory backend
uv run --directory backend uvicorn memworld.main:app --reload --port 8000

# frontend (bun + Vite + Three.js)
bun install --cwd frontend
bun run --cwd frontend dev
```

Open http://localhost:5173. The first backend start downloads the embedding
model (~90 MB) and ingests everything in `vault/`.

## Using it

- Drop `.md` or `.pdf` files into `vault/` — they appear on the globe within
  seconds, placed near semantically similar items.
- Double-click the terrain to create a note pinned at that spot.
- Click a card to read it; its wikilink arcs light up.
- Search (top bar) flies the camera to the best match.
