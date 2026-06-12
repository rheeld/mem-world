# mem-world — design doc

A Google-Earth-like second brain: an infinite Freeform-style canvas wrapped onto the
surface of a sphere, where notes, PDFs, and excerpts arrange themselves by meaning.
The world starts as empty ocean; knowledge accretes into islands and continents.

## Decisions (locked in via Q&A, 2026-06-11)

### Platform & stack
- **Frontend**: Three.js web app (bun for tooling/deps).
- **Backend**: Python (uv-managed venv), FastAPI server.
- **Database**: SQLite + sqlite-vec — single file next to the vault; metadata,
  vectors, positions, annotations all in one portable DB.
- **Vault**: a watched drop directory of plain files (`.md`, `.pdf`, images).
  Files are the source of truth for content; the DB holds everything else
  (positions, embeddings, ink, highlights, links) keyed to file paths.
- **Dev machines**: macOS (primary build machine) + Asus Z13 Strix Halo 128GB
  (local-inference experiments). Everything must run on both — no hosted services.

### The world
- **Fixed-radius sphere**; growth shows as density/terrain, not radius.
- **Visual style: stylized low-poly 3D terrain** (revised 2026-06-11; originally
  vintage cartography, which hit equirect pole-distortion limits and lacked
  depth). Flat-shaded faceted geometry: blue low-poly ocean, dense regions rise
  out of the water as actual elevated terrain — beach → meadow → forest →
  rock → snow by height. Parchment/serif treatment lives on in the UI chrome
  (topbar, cards, panels).
- **Camera: Google-Earth-style** (`controls.ts`): the camera always looks at a
  point on the surface, never the center. Left-drag pans that point across the
  globe (ground follows cursor), wheel zooms toward it, right/middle-drag
  re-anchors to the clicked ground point and arcs around it — tilt toward the
  horizon + rotate — keeping that point centered.
- **Terrain semantics** (all three):
  - elevation = content density / importance (mountains = deepest topics) — implemented
    as vertex displacement from a gaussian density field over item positions
  - biome = age (raw volcanic/sand when fresh → lush when mature; neglected areas weather)
  - weather/light = recent activity (active regions glow/clear; dormant fog over stale areas)
- **Zoomed out**: map-style place names that fade in/out with zoom, summary cards
  on hover/click (counts + recents in v1; LLM-written prose post-v1), and
  representative "capital" thumbnails per cluster.
- **Max zoom-in**: fully flat — past a threshold it behaves exactly like an
  infinite 2D Freeform canvas; curvature only felt when zooming out.
- **Ocean**: compressed distances + fast travel (search-fly, bookmarks, arcs).

### Semantic layout engine
- **Algorithm: spherical UMAP + force settle.** UMAP with spherical/Haversine
  output gives initial geography; a continuous force simulation (similarity +
  wikilink attraction, collision repulsion) handles arrivals, pins, and drift.
- **Slow live drift**: heavily damped continuous motion — items glide toward
  better positions over days, like tectonics you can watch.
- **Re-embed on save/idle**, then the card begins its slow glide.
- **Manual control — local freeform, global semantic, both modes**:
  - implicit neighborhoods: screen-scale arrangements are yours; drift moves
    whole neighborhoods, never undoes local placement
  - optional explicit **canvas patches**: named Freeform-style boards pinned to
    the terrain; contents 100% manual forever, the algorithm places the board
- **Scale target: ~10k items** — incremental layout, spatial indexing, marker
  clustering; no full tiling architecture.
- **Embeddings: local models only** (sentence-transformers class), chosen to run
  on both machines. No LLM summaries in v1.

### Notes (Obsidian half)
- Markdown files in the vault; rendered as **readable cards directly on the
  terrain** — zoom to read, edit in place. The world is the interface.
- v1 features: `[[wikilinks]]` + backlinks, `#tags`, rich embeds
  (images, code blocks, LaTeX). No daily-notes ritual in v1.
- Starting fresh — no vault import needed (build ingest funnel anyway via the
  drop folder).

### PDFs
- **Vertical scroll strip**: pages stacked top-to-bottom as one continuous
  ribbon laid across the terrain; margin space flanks both sides.
- Margin tools: typed text notes, text highlights (with attached comments,
  first-class embeddable items), and full Markdown notes pinned to page spots.
- **Anchoring: page coordinates** (page, x, y) — annotations survive strip
  re-layout. (Text-span anchoring can come later for highlights.)
- **Semantics: one position, chunk-aware** — whole-doc embedding places the
  document; internal chunks power search/excerpts.
- **LiquidText-style excerpt threads**: pull ideas out of documents and connect
  them — to sections of the same doc, other docs, or notes — rendered as
  flight-path arcs over the terrain.

### Links & arcs
- Wikilinks and excerpt threads render as **arcs, visible on selection/hover
  only** — clean map by default, illuminate on focus.
- Arcs are navigable: click to ride one to its destination ("ride the arcs").

### Capture
- Watched drop folder (file appears → embeds → rises out of the ocean at its
  semantic spot)
- Drag & drop from Finder onto the globe
- Create in-world: double-click the surface to spawn a note card there
  (pins locally)

### Navigation (all in v1)
- Text search (keyword + vector) → fly-to
- Bookmarks / saved camera views
- Ride the arcs
- Corner minimap globe (click to jump)

## v1 milestone: vertical slice

One island, every feature at minimum quality, end-to-end:
- globe + cartographic terrain generated from real density
- a handful of note cards (markdown render, wikilinks, tags), editable in place
- one PDF unrolled as a scroll strip with a highlight and a margin note
- one excerpt arc connecting a PDF passage to a note
- one canvas patch
- drop-folder ingest, search-fly, a bookmark, the minimap
- spherical UMAP + force layout with visible slow drift

Then broaden.

## Implementation status notes (2026-06-12)

- Zoom-LOD aggregation v1 is live: cards near, cluster-label pills far (leader
  clustering, named by dominant tag, disambiguated); clicking a label flies in
  and opens a region panel (kind breakdown + item list). Multi-level hierarchy
  still to come.
- PDFs are readable via an in-panel pdf.js reader (lazy page render). This is
  a stepping stone — the on-terrain unrolled scroll strip with margins,
  highlights, and LiquidText-style excerpt threads remain the design goal.
- Notes: in-app edit/delete (writes back to vault files, frontmatter
  preserved), clickable [[wikilinks]], links-to/linked-from rows, clickable
  tags (feed search), "+ note" button and double-click create.
- Local freeform v1: drag a card to move + pin it; pin/unpin from the panel.
  Canvas patches still to come.
- Slow live drift is on: a gentle settle step every 3 min (backend), and
  editing a note re-embeds and re-places it; the frontend glides cards to new
  positions instead of teleporting.
- Capture: watched vault dir, drag & drop files onto the globe (pins at the
  drop point), "+ note", double-click. Quick-capture inbox/hotkey still to
  come.
- Navigation: search→fly, ride-the-arcs (click an arc to travel it), saved
  views (bookmarks, localStorage). Minimap still to come.

- Wikipedia phase 1 (2026-06-12): ~9k Vital Articles (level 4) imported as a
  `wiki/` source via scripts/fetch_wikipedia_vital.py, with topic tags driving
  continents. Scale prep: batched embedding outside the lock, normalised
  settle forces, lazy card pool, binned terrain sampling. Phase 2 (100k+:
  ANN index, tile streaming, backend hierarchy) is designed but not built.

## Post-v1 (explicitly deferred)
- LLM region summaries (cluster prose, auto place-names beyond simple labels)
- Query → librarian: conversational LLM that flies the camera to clusters and
  answers from the world (read/navigate first; world-modifying librarian later)
- Handwritten ink, OCR
- Multi-device sync, sharing, mobile capture
- Multiple worlds / moons per domain
