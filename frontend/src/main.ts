import * as THREE from 'three'
import {
  createNote,
  deleteItem,
  fetchItem,
  fetchWorld,
  searchWorld,
  setPosition,
  updateNote,
  uploadFile,
  type WorldItem,
  type WorldState,
} from './api'
import { CARD_ANCHOR_ALTITUDE, disposeCard, makeCard } from './cards'
import {
  computeClusters,
  computeSuperClusters,
  disposeSprite,
  makeClusterSprite,
  relabelUnderParents,
  subdivide,
  type Cluster,
} from './clusters'
import { GlobeControls } from './controls'
import { Globe } from './globe'
import { Minimap } from './minimap'
import { addLights, makeAtmosphere, makeStars } from './scene'
import { UI } from './ui'
import './styles.css'

// LOD hierarchy (camera distance): super-regions far, regions mid, fine
// clusters near, then cards. add levels here as the world densifies.
interface LabelLevel {
  radius: number // leader-clustering radius (radians)
  fadeIn: [number, number]
  fadeOut: [number, number] | null
  size: number // sprite scale multiplier
  flyDistance: number // clicking a label descends to this zoom
}

const LABEL_LEVELS: LabelLevel[] = [
  { radius: 0.95, fadeIn: [1.85, 2.3], fadeOut: null, size: 1.45, flyDistance: 1.5 },
  { radius: 0.6, fadeIn: [1.0, 1.25], fadeOut: [1.9, 2.4], size: 1.0, flyDistance: 0.95 },
  { radius: 0.33, fadeIn: [0.62, 0.8], fadeOut: [1.05, 1.3], size: 0.74, flyDistance: 0.5 },
]
const CARDS_FADE = [0.6, 1.0] as const
const ARC_COLOR = '#ff8a5c'
const ARC_HOVER = '#ffd27a'
// fine-cluster accent hues; member cards tint toward theirs while the fine
// labels are on screen, so groupings stay trackable through the zoom
const GROUP_PALETTE = [
  '#d98a66',
  '#7fa3d6',
  '#a8c97e',
  '#c9a3e0',
  '#e0c069',
  '#74c0b2',
  '#dd8aa8',
  '#b3bd6d',
]

const app = document.getElementById('app')!
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(innerWidth, innerHeight)
renderer.localClippingEnabled = true
app.appendChild(renderer.domElement)

// cards/labels skip the depth test (terrain would slice them), so the
// planet's own occlusion is emulated with one clipping plane at the horizon:
// sprites rise gradually over the limb instead of popping into existence
const horizonPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)

const scene = new THREE.Scene()
scene.background = new THREE.Color('#0c1322')
addLights(scene)
scene.add(makeStars())
scene.add(makeAtmosphere())

const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.005, 60)

const globe = new Globe()
scene.add(globe.group)
const cards = new THREE.Group()
scene.add(cards)
const labelGroups: THREE.Group[] = LABEL_LEVELS.map(() => {
  const group = new THREE.Group()
  scene.add(group)
  return group
})
const arcs = new THREE.Group()
scene.add(arcs)

const controls = new GlobeControls(camera, renderer.domElement, (dir) =>
  globe.elevation(dir),
)

let world: WorldState | null = null
let levelClusters: Cluster[][] = LABEL_LEVELS.map(() => [])
let clusters: Cluster[] = [] // mid level — bookmarks/status/minimap granularity
const groupColors = new Map<number, string>() // item id -> fine-cluster accent
let selectedId: number | null = null
let hovered: THREE.Object3D | null = null
// cards glide between layout positions instead of teleporting
const lastPositions = new Map<number, THREE.Vector3>()

const ui = new UI({
  onSearch: (q) => searchWorld(q),
  onPick: (item) => {
    controls.flyTo(new THREE.Vector3(...item.pos))
    void select(item.id)
  },
  onOpen: (id) => {
    const item = world?.items.find((i) => i.id === id)
    if (item) controls.flyTo(new THREE.Vector3(...item.pos))
    void select(id)
  },
  onNavigate: (title) => navigateToTitle(title),
  onCreate: async (title, content, pos) => {
    await createNote(title, content, pos)
    await refresh(true)
  },
  onSave: async (id, content) => {
    const updated = await updateNote(id, content)
    await refresh(true)
    return updated
  },
  onDelete: async (id) => {
    await deleteItem(id)
    selectedId = null
    await refresh(true)
  },
  onTogglePin: async (item) => {
    const updated = await setPosition(item.id, item.pos, !item.pinned)
    await refresh(true)
    return updated
  },
  onNewNote: () => {
    const t = controls.target.clone().normalize()
    ui.showCreateForm([t.x, t.y, t.z])
  },
  onClose: () => {
    selectedId = null
    drawArcs()
  },
})

function navigateToTitle(title: string): void {
  if (!world) return
  const lc = title.trim().toLowerCase()
  const slug = lc.replace(/\s+/g, '-')
  const found = world.items.find(
    (i) => i.title.toLowerCase() === lc || i.path.toLowerCase().includes(`/${slug}.`),
  )
  if (found) {
    controls.flyTo(new THREE.Vector3(...found.pos))
    void select(found.id)
    return
  }
  void searchWorld(title).then((results) => {
    if (results[0]) {
      controls.flyTo(new THREE.Vector3(...results[0].pos))
      void select(results[0].id)
    } else {
      ui.setStatus(`nothing called “${title}” yet — uncharted waters`)
    }
  })
}

async function refresh(force = false): Promise<void> {
  try {
    const w = await fetchWorld(force ? undefined : world?.rev)
    if (w) {
      world = w
      rebuild()
    }
  } catch {
    ui.setStatus('backend offline — start uvicorn on :8000')
  }
}

function cardAltitude(p: THREE.Vector3): number {
  return 1 + Math.max(0, globe.elevation(p)) + CARD_ANCHOR_ALTITUDE
}

// -- lazy card pool ------------------------------------------------------------
// 10k canvas-textured sprites would eat gigabytes of GPU memory; only the
// cards near the camera target exist, respawned as the view moves.

const CARD_LIMIT = 350
const ALL_CARDS_BELOW = 600 // small worlds keep every card alive
let cardsDirty = true
const lastCardTarget = new THREE.Vector3(0, 0, 0)
let lastCardDistance = -1

function spawnCard(item: WorldItem): THREE.Sprite {
  const sprite = makeCard(item, globe.elevation(new THREE.Vector3(...item.pos)))
  sprite.material.clippingPlanes = [horizonPlane]
  const accent = groupColors.get(item.id)
  sprite.userData.groupColor = accent ? new THREE.Color(accent) : null
  const target = (sprite.userData.normal as THREE.Vector3).clone()
  const prev = lastPositions.get(item.id)
  if (prev && prev.angleTo(target) > 0.004) {
    // start at the old spot and glide to the new one
    sprite.userData.normal = prev.clone()
    sprite.position.copy(prev).multiplyScalar(cardAltitude(prev))
    sprite.userData.glideTo = target
  }
  lastPositions.set(item.id, target)
  return sprite
}

function updateVisibleCards(): void {
  if (!world) return
  const total = world.items.length
  if (total > ALL_CARDS_BELOW && !cards.visible) return
  const target = controls.target.clone().normalize()
  const moved =
    cardsDirty ||
    target.angleTo(lastCardTarget) > 0.04 ||
    Math.abs(controls.viewDistance - lastCardDistance) > 0.12 ||
    (cards.visible && cards.children.length === 0 && total > 0)
  if (!moved) return
  cardsDirty = false
  lastCardTarget.copy(target)
  lastCardDistance = controls.viewDistance

  let wanted: WorldItem[]
  if (total <= ALL_CARDS_BELOW) {
    wanted = world.items
  } else {
    const radius = Math.min(1.2, Math.max(0.3, controls.viewDistance * 1.3))
    const cos = Math.cos(radius)
    const scored: [number, WorldItem][] = []
    for (const item of world.items) {
      const dot =
        target.x * item.pos[0] + target.y * item.pos[1] + target.z * item.pos[2]
      if (dot > cos) scored.push([dot, item])
    }
    scored.sort((a, b) => b[0] - a[0])
    wanted = scored.slice(0, CARD_LIMIT).map((s) => s[1])
  }
  const wantedIds = new Set(wanted.map((i) => i.id))
  for (const child of [...cards.children]) {
    const sprite = child as THREE.Sprite
    const item = sprite.userData.item as WorldItem
    if (wantedIds.has(item.id)) continue
    if (sprite === movingCard || item.id === selectedId) continue // never mid-action
    cards.remove(sprite)
    disposeCard(sprite)
  }
  const have = new Set(cards.children.map((c) => (c.userData.item as WorldItem).id))
  for (const item of wanted) {
    if (!have.has(item.id)) cards.add(spawnCard(item))
  }
}

function rebuild(): void {
  if (!world) return
  globe.update(world.items)
  for (const child of [...cards.children]) {
    cards.remove(child)
    disposeCard(child as THREE.Sprite)
  }
  cardsDirty = true
  for (const id of [...lastPositions.keys()]) {
    if (!world.items.some((i) => i.id === id)) lastPositions.delete(id)
  }
  // a true hierarchy: mid level is geometric, the top level merges by tag,
  // and the fine level is computed INSIDE each region (true subsets) —
  // children that equal their parent inherit its name; singletons get none
  const mid = computeClusters(world.items, LABEL_LEVELS[1].radius)
  const top = computeSuperClusters(mid)
  relabelUnderParents(mid)
  let fine = subdivide(mid, LABEL_LEVELS[2].radius)
  // label sprites carry canvas textures — cap the fine level at big scale
  if (fine.length > 250) {
    fine = [...fine].sort((a, b) => b.items.length - a.items.length).slice(0, 250)
  }
  levelClusters = [top, mid, fine]
  clusters = mid
  groupColors.clear()
  fine.forEach((c, i) => {
    c.color = GROUP_PALETTE[i % GROUP_PALETTE.length]
    for (const item of c.items) groupColors.set(item.id, c.color)
  })
  labelGroups.forEach((group, li) => {
    for (const child of [...group.children]) {
      group.remove(child)
      disposeSprite(child as THREE.Sprite)
    }
    for (const cluster of levelClusters[li]) {
      const sprite = makeClusterSprite(
        cluster,
        globe.elevation(cluster.center),
        LABEL_LEVELS[li].size,
        cluster.color,
      )
      sprite.material.clippingPlanes = [horizonPlane]
      sprite.userData.level = li
      group.add(sprite)
    }
  })
  const mini = (cs: Cluster[]) =>
    cs.map((c) => ({ center: c.center, label: c.label, count: c.items.length }))
  minimap.setWorld(world.items, {
    coarse: mini(levelClusters[0]),
    fine: mini(clusters),
  })
  if (!sidebar.hidden) renderSidebar()
  drawArcs()
  ui.setStatus(
    world.items.length === 0
      ? 'open ocean — drop a file in, or double-click to write'
      : `${world.items.length} items · ${levelClusters[0].length} continents · ${clusters.length} regions`,
  )
}

function drawArcs(): void {
  for (const child of [...arcs.children]) {
    arcs.remove(child)
    const mesh = child as THREE.Mesh
    mesh.geometry.dispose()
    ;(mesh.material as THREE.Material).dispose()
  }
  if (!world || selectedId === null) return
  const byId = new Map(world.items.map((i) => [i.id, i]))
  for (const [src, dst] of world.links) {
    if (src !== selectedId && dst !== selectedId) continue
    const a = byId.get(src)
    const b = byId.get(dst)
    if (!a || !b) continue
    arcs.add(makeArc(a, b))
  }
}

/** Flight paths are tubes (real thickness, hoverable, clickable). */
function makeArc(a: WorldItem, b: WorldItem): THREE.Mesh {
  const av = new THREE.Vector3(...a.pos)
  const bv = new THREE.Vector3(...b.pos)
  const angle = av.angleTo(bv)
  const elevA = Math.max(0, globe.elevation(av))
  const elevB = Math.max(0, globe.elevation(bv))
  const points: THREE.Vector3[] = []
  for (let i = 0; i <= 48; i++) {
    const t = i / 48
    const p = av.clone().lerp(bv, t).normalize()
    const base = 1 + elevA * (1 - t) + elevB * t + 0.018
    p.multiplyScalar(base + Math.sin(t * Math.PI) * (0.02 + angle * 0.05))
    points.push(p)
  }
  const curve = new THREE.CatmullRomCurve3(points)
  const geometry = new THREE.TubeGeometry(curve, 72, 0.003, 6, false)
  const material = new THREE.MeshBasicMaterial({
    color: ARC_COLOR,
    transparent: true,
    opacity: 0.92,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.userData.ends = [a, b] // clickable: ride the arc to the far end
  mesh.userData.arc = true
  return mesh
}

async function select(id: number): Promise<void> {
  selectedId = id
  drawArcs()
  try {
    ui.showItem(await fetchItem(id))
  } catch {
    ui.setStatus('failed to load item')
  }
}

// -- picking ----------------------------------------------------------------

const raycaster = new THREE.Raycaster()
const pointer = new THREE.Vector2()
let downAt: [number, number] | null = null

interface Hit {
  card?: WorldItem
  cluster?: Cluster
  arc?: THREE.Mesh
  surface?: THREE.Vector3
  object?: THREE.Object3D
}

function raycastAt(clientX: number, clientY: number): Hit | null {
  pointer.set((clientX / innerWidth) * 2 - 1, -(clientY / innerHeight) * 2 + 1)
  raycaster.setFromCamera(pointer, camera)
  for (const group of labelGroups) {
    if (!group.visible) continue
    const labelHit = raycaster.intersectObjects(group.children, false)[0]
    if (labelHit) {
      return { cluster: labelHit.object.userData.cluster as Cluster, object: labelHit.object }
    }
  }
  if (cards.visible) {
    const cardHit = raycaster.intersectObjects(cards.children, false)[0]
    if (cardHit) {
      return { card: cardHit.object.userData.item as WorldItem, object: cardHit.object }
    }
  }
  if (arcs.children.length > 0) {
    const arcHit = raycaster.intersectObjects(arcs.children, false)[0]
    if (arcHit) return { arc: arcHit.object as THREE.Mesh, object: arcHit.object }
  }
  const globeHit = raycaster.intersectObject(globe.land, false)[0]
  if (globeHit) return { surface: globeHit.point.clone().normalize() }
  return null
}

// -- card context menu + move mode ----------------------------------------------
// moving is deliberate: right-click a card -> "move" -> the card follows the
// cursor -> click to place (esc cancels). plain left-drag only pans the globe.

let movingCard: THREE.Sprite | null = null
let moveOrigin: THREE.Vector3 | null = null
const ctxmenu = document.getElementById('ctxmenu') as HTMLUListElement

function closeCardMenu(): void {
  ctxmenu.hidden = true
}

function openCardMenu(sprite: THREE.Sprite, x: number, y: number): void {
  const item = sprite.userData.item as WorldItem
  ctxmenu.innerHTML = `
    <li class="ctx-title">${item.title.length > 26 ? item.title.slice(0, 25) + '…' : item.title}</li>
    <li data-act="open">open</li>
    <li data-act="move">move…</li>
    <li data-act="pin">${item.pinned ? 'unpin' : 'pin in place'}</li>`
  ctxmenu.style.left = `${Math.min(x, innerWidth - 180)}px`
  ctxmenu.style.top = `${Math.min(y, innerHeight - 150)}px`
  ctxmenu.hidden = false
  ctxmenu.querySelector('[data-act="open"]')!.addEventListener('click', () => {
    closeCardMenu()
    void select(item.id)
  })
  ctxmenu.querySelector('[data-act="move"]')!.addEventListener('click', () => {
    closeCardMenu()
    movingCard = sprite
    moveOrigin = (sprite.userData.normal as THREE.Vector3).clone()
    renderer.domElement.style.cursor = 'move'
    ui.setStatus(`moving “${item.title}” — click to place, esc to cancel`)
  })
  ctxmenu.querySelector('[data-act="pin"]')!.addEventListener('click', async () => {
    closeCardMenu()
    try {
      await setPosition(item.id, item.pos, !item.pinned)
      await refresh(true)
      ui.setStatus(item.pinned ? `unpinned “${item.title}”` : `pinned “${item.title}”`)
    } catch {
      ui.setStatus('failed to update pin')
    }
  })
}

document.addEventListener('click', (e) => {
  if (!(e.target instanceof Node) || !ctxmenu.contains(e.target)) closeCardMenu()
})

controls.ignorePointer = (e) => {
  if (movingCard) return true // placement click must not pan/tilt
  if (e.button === 2 && cards.visible) {
    const hit = raycastAt(e.clientX, e.clientY)
    if (hit?.card && hit.object instanceof THREE.Sprite) {
      openCardMenu(hit.object, e.clientX, e.clientY)
      return true
    }
  }
  return false
}

renderer.domElement.addEventListener('pointerdown', (e) => {
  downAt = [e.clientX, e.clientY]
  if (e.button === 0) closeCardMenu()
})

function cancelMove(): void {
  if (!movingCard || !moveOrigin) return
  movingCard.userData.normal = moveOrigin
  movingCard.position.copy(moveOrigin).multiplyScalar(cardAltitude(moveOrigin))
  movingCard = null
  moveOrigin = null
  renderer.domElement.style.cursor = 'grab'
  ui.setStatus('move cancelled')
}

document.addEventListener(
  'keydown',
  (e) => {
    if (e.key === 'Escape' && movingCard) {
      cancelMove()
      e.stopImmediatePropagation() // keep the panel open
    }
  },
  true,
)

async function placeMovingCard(): Promise<void> {
  if (!movingCard) return
  const sprite = movingCard
  movingCard = null
  moveOrigin = null
  renderer.domElement.style.cursor = 'grab'
  const item = sprite.userData.item as WorldItem
  const p = sprite.userData.normal as THREE.Vector3
  lastPositions.set(item.id, p.clone())
  try {
    await setPosition(item.id, [p.x, p.y, p.z], true)
    await refresh(true)
    ui.setStatus(`pinned “${item.title}” here`)
  } catch {
    ui.setStatus('failed to move item')
  }
}

// -- clicks --------------------------------------------------------------------

renderer.domElement.addEventListener('click', (e) => {
  if (movingCard) {
    void placeMovingCard()
    return
  }
  if (downAt && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 6) return
  const hit = raycastAt(e.clientX, e.clientY)
  if (hit?.card) {
    void select(hit.card.id)
  } else if (hit?.cluster) {
    // descend exactly one LOD level toward the clicked region
    const level = LABEL_LEVELS[(hit.object?.userData.level as number) ?? 1]
    controls.flyTo(hit.cluster.center, { distance: level.flyDistance, tilt: 0.45 })
    if (level === LABEL_LEVELS[LABEL_LEVELS.length - 1]) {
      ui.showRegion({ label: hit.cluster.label, items: hit.cluster.items })
    }
  } else if (hit?.arc) {
    const [a, b] = hit.arc.userData.ends as [WorldItem, WorldItem]
    const far = selectedId === a.id ? b : a
    controls.flyTo(new THREE.Vector3(...far.pos))
    void select(far.id)
  } else if (selectedId !== null) {
    ui.hide() // click on empty terrain/ocean dismisses the panel
  }
})

renderer.domElement.addEventListener('dblclick', (e) => {
  const hit = raycastAt(e.clientX, e.clientY)
  if (hit?.surface) {
    ui.showCreateForm([hit.surface.x, hit.surface.y, hit.surface.z])
  }
})

function unhover(obj: THREE.Object3D): void {
  if (obj instanceof THREE.Sprite) obj.scale.divideScalar(1.12)
  else if (obj.userData.arc) {
    ;((obj as THREE.Mesh).material as THREE.MeshBasicMaterial).color.set(ARC_COLOR)
  }
}

function applyHover(obj: THREE.Object3D): void {
  if (obj instanceof THREE.Sprite) obj.scale.multiplyScalar(1.12)
  else if (obj.userData.arc) {
    ;((obj as THREE.Mesh).material as THREE.MeshBasicMaterial).color.set(ARC_HOVER)
  }
}

renderer.domElement.addEventListener('pointermove', (e) => {
  if (movingCard) {
    // move mode: the card follows the cursor across the terrain
    pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1)
    raycaster.setFromCamera(pointer, camera)
    const hit = raycaster.intersectObject(globe.land, false)[0]
    if (hit) {
      const p = hit.point.clone().normalize()
      movingCard.userData.normal = p
      movingCard.userData.glideTo = undefined
      movingCard.position.copy(p).multiplyScalar(cardAltitude(p))
    }
    return
  }
  if (e.buttons !== 0) return
  const hit = raycastAt(e.clientX, e.clientY)
  const target = hit?.card || hit?.cluster || hit?.arc ? (hit.object ?? null) : null
  if (target !== hovered) {
    if (hovered) unhover(hovered)
    hovered = target
    if (hovered) applyHover(hovered)
    renderer.domElement.style.cursor = hovered ? 'pointer' : 'grab'
  }
})

// -- file drop ------------------------------------------------------------------

addEventListener('dragover', (e) => e.preventDefault())
addEventListener('drop', async (e) => {
  e.preventDefault()
  const files = [...(e.dataTransfer?.files ?? [])]
  if (files.length === 0) return
  const hit = raycastAt(e.clientX, e.clientY)
  const pos = hit?.surface
    ? ([hit.surface.x, hit.surface.y, hit.surface.z] as [number, number, number])
    : undefined
  let done = 0
  for (const file of files) {
    ui.setStatus(`adding ${file.name} (${++done}/${files.length})…`)
    try {
      await uploadFile(file, pos)
    } catch {
      ui.setStatus(`couldn't add ${file.name} (unsupported type?)`)
    }
  }
  await refresh(true)
})

// -- bookmarks --------------------------------------------------------------------

interface Bookmark {
  name: string
  target: [number, number, number]
  distance: number
  tilt: number
}

const BOOKMARK_KEY = 'memworld.bookmarks'

function loadBookmarks(): Bookmark[] {
  try {
    return JSON.parse(localStorage.getItem(BOOKMARK_KEY) ?? '[]') as Bookmark[]
  } catch {
    return []
  }
}

function saveBookmarks(list: Bookmark[]): void {
  localStorage.setItem(BOOKMARK_KEY, JSON.stringify(list))
}

function nearestRegionLabel(t: THREE.Vector3): string | null {
  let best: string | null = null
  let bestAngle = 0.9
  for (const c of clusters) {
    const a = c.center.angleTo(t)
    if (a < bestAngle) {
      bestAngle = a
      best = c.label
    }
  }
  return best
}

function renderBookmarks(): void {
  const list = document.getElementById('views-list') as HTMLUListElement
  const items = loadBookmarks()
  list.innerHTML =
    `<li class="views-save">☆ save this view</li>` +
    items
      .map(
        (b, i) =>
          `<li class="views-item" data-i="${i}">${b.name}<span class="del" data-i="${i}" title="remove">×</span></li>`,
      )
      .join('')
  list.querySelector('.views-save')!.addEventListener('click', () => {
    const t = controls.target.clone().normalize()
    const name = nearestRegionLabel(t) ?? `view ${items.length + 1}`
    saveBookmarks([...items, {
      name,
      target: [t.x, t.y, t.z],
      distance: controls.distance,
      tilt: controls.tilt,
    }])
    renderBookmarks()
  })
  list.querySelectorAll<HTMLElement>('.views-item').forEach((el) =>
    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).classList.contains('del')) {
        const idx = Number((e.target as HTMLElement).dataset.i)
        const next = loadBookmarks()
        next.splice(idx, 1)
        saveBookmarks(next)
        renderBookmarks()
        e.stopPropagation()
        return
      }
      const b = loadBookmarks()[Number(el.dataset.i)]
      if (b) {
        controls.flyTo(new THREE.Vector3(...b.target), {
          distance: b.distance,
          tilt: b.tilt,
        })
      }
      list.hidden = true
    }),
  )
}

document.getElementById('views-btn')!.addEventListener('click', (e) => {
  const list = document.getElementById('views-list')!
  list.hidden = !list.hidden
  if (!list.hidden) renderBookmarks()
  e.stopPropagation()
})
document.addEventListener('click', (e) => {
  const box = document.getElementById('viewsbox')!
  if (!(e.target instanceof Node) || !box.contains(e.target)) {
    document.getElementById('views-list')!.hidden = true
  }
})

// -- card glide ---------------------------------------------------------------

/** Sprites billboard themselves; this only drifts cards that have a glide
 * target (drift tick, re-placed edits) toward their new home. */
function updateGlides(dt: number): void {
  if (!cards.visible) return
  const glide = 1 - Math.exp(-dt * 1.4)
  for (const child of cards.children) {
    const sprite = child as THREE.Sprite
    const n = sprite.userData.normal as THREE.Vector3
    const to = sprite.userData.glideTo as THREE.Vector3 | undefined
    if (!to) continue
    const angle = n.angleTo(to)
    const axis = new THREE.Vector3().crossVectors(n, to)
    if (angle < 0.002 || axis.lengthSq() < 1e-12) {
      sprite.userData.glideTo = undefined
      continue
    }
    n.applyAxisAngle(axis.normalize(), angle * glide)
    sprite.position.copy(n).multiplyScalar(cardAltitude(n))
  }
}

// -- LOD crossfade -----------------------------------------------------------

function smoothstep(x: number, lo: number, hi: number): number {
  const t = THREE.MathUtils.clamp((x - lo) / (hi - lo), 0, 1)
  return t * t * (3 - 2 * t)
}

/** Opacity of an LOD band at camera distance d. */
function bandOpacity(d: number, level: LabelLevel): number {
  let o = smoothstep(d, level.fadeIn[0], level.fadeIn[1])
  if (level.fadeOut) o *= 1 - smoothstep(d, level.fadeOut[0], level.fadeOut[1])
  return o
}

function applyLod(): void {
  const d = controls.viewDistance
  const cardOpacity = 1 - smoothstep(d, CARDS_FADE[0], CARDS_FADE[1])
  cards.visible = cardOpacity > 0.02
  // move the horizon clipping plane with the camera: fragments beyond the
  // limb are shaved off, so sprites rise smoothly over the curve
  const camDir = camera.position.clone().normalize()
  const horizon = 1 / Math.max(camera.position.length(), 1.0001)
  horizonPlane.normal.copy(camDir)
  horizonPlane.constant = -horizon + 0.012 // slack for terrain/card altitude
  // coarse cull: fully-clipped sprites must not swallow raycasts.
  // while fine-cluster labels are on screen, member cards tint subtly toward
  // their group's accent so subgroups stay trackable through the zoom
  const tint = bandOpacity(d, LABEL_LEVELS[LABEL_LEVELS.length - 1]) * 0.38
  for (const child of cards.children) {
    const sprite = child as THREE.Sprite
    sprite.material.opacity = cardOpacity
    const groupColor = sprite.userData.groupColor as THREE.Color | null
    if (groupColor && tint > 0.01) {
      sprite.material.color.setRGB(1, 1, 1).lerp(groupColor, tint)
    } else {
      sprite.material.color.setRGB(1, 1, 1)
    }
    const n = sprite.userData.normal as THREE.Vector3
    sprite.visible = n.dot(camDir) > horizon - 0.08
  }
  labelGroups.forEach((group, li) => {
    const opacity = bandOpacity(d, LABEL_LEVELS[li])
    group.visible = opacity > 0.02
    if (!group.visible) return
    for (const child of group.children) {
      const sprite = child as THREE.Sprite
      sprite.material.opacity = opacity
      const center = (sprite.userData.cluster as Cluster).center
      sprite.visible = center.dot(camDir) > horizon - 0.12
    }
  })
}

// -- sidebar (vault file tree) ---------------------------------------------------

const sidebar = document.getElementById('sidebar')!
const KIND_GLYPH: Record<string, string> = { note: '¶', pdf: '⎘', image: '✦' }

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

interface TreeDir {
  dirs: Map<string, TreeDir>
  files: WorldItem[]
}

function buildTree(items: WorldItem[]): TreeDir {
  const root: TreeDir = { dirs: new Map(), files: [] }
  for (const item of [...items].sort((a, b) => a.path.localeCompare(b.path))) {
    const parts = item.path.split('/')
    let node = root
    for (const part of parts.slice(0, -1)) {
      let dir = node.dirs.get(part)
      if (!dir) node.dirs.set(part, (dir = { dirs: new Map(), files: [] }))
      node = dir
    }
    node.files.push(item)
  }
  return root
}

function treeSize(node: TreeDir): number {
  let n = node.files.length
  for (const dir of node.dirs.values()) n += treeSize(dir)
  return n
}

function renderTreeHtml(node: TreeDir): string {
  let html = '<ul>'
  for (const [name, dir] of node.dirs) {
    const open = treeSize(dir) <= 50 ? ' open' : '' // big folders start folded
    html += `<li><details${open}><summary>${escapeHtml(name)}</summary>${renderTreeHtml(dir)}</details></li>`
  }
  for (const file of node.files) {
    html += `<li class="tree-file" data-id="${file.id}"><span class="glyph ${file.kind}">${
      KIND_GLYPH[file.kind] ?? '·'
    }</span>${escapeHtml(file.title)}</li>`
  }
  return html + '</ul>'
}

function openItem(id: number): void {
  const item = world?.items.find((i) => i.id === id)
  if (item) controls.flyTo(new THREE.Vector3(...item.pos))
  void select(id)
}

function renderSidebar(): void {
  if (!world) return
  const counts: Record<string, number> = { note: 0, pdf: 0, image: 0 }
  for (const item of world.items) counts[item.kind] = (counts[item.kind] ?? 0) + 1
  document.getElementById('sidebar-stats')!.textContent =
    `${world.items.length} items — ${counts.note} notes · ${counts.pdf} pdfs · ` +
    `${counts.image} images — ${clusters.length} regions`
  const tree = document.getElementById('sidebar-tree')!
  tree.innerHTML = renderTreeHtml(buildTree(world.items))
  tree.querySelectorAll<HTMLElement>('.tree-file').forEach((el) =>
    el.addEventListener('click', () => openItem(Number(el.dataset.id))),
  )
}

document.getElementById('menu-btn')!.addEventListener('click', () => {
  sidebar.hidden = !sidebar.hidden
  if (!sidebar.hidden) renderSidebar()
})
document.getElementById('sidebar-close')!.addEventListener('click', () => {
  sidebar.hidden = true
})

// -- minimap ------------------------------------------------------------------

const minimap = new Minimap(
  document.getElementById('minimap') as HTMLCanvasElement,
  (dir) => controls.flyTo(dir, { distance: controls.distance, tilt: controls.tilt }),
)

// -- loop -------------------------------------------------------------------

let lastFrame = performance.now()
renderer.setAnimationLoop(() => {
  const now = performance.now()
  const dt = Math.min(0.05, (now - lastFrame) / 1000)
  lastFrame = now
  controls.update(now)
  applyLod()
  updateVisibleCards()
  updateGlides(dt)
  minimap.draw(controls.target)
  renderer.render(scene, camera)
})

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
})

void refresh(true)
setInterval(() => void refresh(), 2500)
