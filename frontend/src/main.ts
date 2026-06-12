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
import { disposeCard, makeCard } from './cards'
import { computeClusters, disposeSprite, makeClusterSprite, type Cluster } from './clusters'
import { GlobeControls } from './controls'
import { Globe } from './globe'
import { addLights, makeAtmosphere, makeStars } from './scene'
import { UI } from './ui'
import './styles.css'

// LOD bands (camera distance): cards near, cluster labels far
const CARDS_FADE = [0.7, 1.5] as const
const LABELS_FADE = [0.9, 1.7] as const
const CARD_ALTITUDE = 0.016

const app = document.getElementById('app')!
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(innerWidth, innerHeight)
app.appendChild(renderer.domElement)

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
const labels = new THREE.Group()
scene.add(labels)
const arcs = new THREE.Group()
scene.add(arcs)

const controls = new GlobeControls(camera, renderer.domElement, (dir) =>
  globe.elevation(dir),
)

let world: WorldState | null = null
let clusters: Cluster[] = []
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
  return 1 + Math.max(0, globe.elevation(p)) + CARD_ALTITUDE
}

function rebuild(): void {
  if (!world) return
  globe.update(world.items)
  for (const child of [...cards.children]) {
    cards.remove(child)
    disposeCard(child as THREE.Mesh)
  }
  for (const item of world.items) {
    const mesh = makeCard(item, globe.elevation(new THREE.Vector3(...item.pos)))
    const target = (mesh.userData.normal as THREE.Vector3).clone()
    const prev = lastPositions.get(item.id)
    if (prev && prev.angleTo(target) > 0.004) {
      // start at the old spot and glide to the new one
      mesh.userData.normal = prev.clone()
      mesh.position.copy(prev).multiplyScalar(cardAltitude(prev))
      mesh.userData.glideTo = target
    }
    lastPositions.set(item.id, target)
    cards.add(mesh)
  }
  for (const id of [...lastPositions.keys()]) {
    if (!world.items.some((i) => i.id === id)) lastPositions.delete(id)
  }
  for (const child of [...labels.children]) {
    labels.remove(child)
    disposeSprite(child as THREE.Sprite)
  }
  clusters = computeClusters(world.items)
  for (const cluster of clusters) {
    labels.add(makeClusterSprite(cluster, globe.elevation(cluster.center)))
  }
  drawArcs()
  ui.setStatus(
    world.items.length === 0
      ? 'open ocean — drop a file in, or double-click to write'
      : `${world.items.length} items · ${clusters.length} regions`,
  )
}

function drawArcs(): void {
  for (const child of [...arcs.children]) {
    arcs.remove(child)
    const line = child as THREE.Line
    line.geometry.dispose()
    ;(line.material as THREE.Material).dispose()
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

function makeArc(a: WorldItem, b: WorldItem): THREE.Line {
  const av = new THREE.Vector3(...a.pos)
  const bv = new THREE.Vector3(...b.pos)
  const angle = av.angleTo(bv)
  const elevA = Math.max(0, globe.elevation(av))
  const elevB = Math.max(0, globe.elevation(bv))
  const points: THREE.Vector3[] = []
  for (let i = 0; i <= 64; i++) {
    const t = i / 64
    const p = av.clone().lerp(bv, t).normalize()
    const base = 1 + elevA * (1 - t) + elevB * t + 0.018
    p.multiplyScalar(base + Math.sin(t * Math.PI) * (0.02 + angle * 0.05))
    points.push(p)
  }
  const geometry = new THREE.BufferGeometry().setFromPoints(points)
  const material = new THREE.LineBasicMaterial({
    color: '#ff8a5c',
    transparent: true,
    opacity: 0.95,
  })
  const line = new THREE.Line(geometry, material)
  line.userData.ends = [a, b] // clickable: ride the arc to the far end
  return line
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
raycaster.params.Line = { threshold: 0.008 }
const pointer = new THREE.Vector2()
let downAt: [number, number] | null = null

interface Hit {
  card?: WorldItem
  cluster?: Cluster
  arc?: THREE.Line
  surface?: THREE.Vector3
  object?: THREE.Object3D
}

function raycastAt(clientX: number, clientY: number): Hit | null {
  pointer.set((clientX / innerWidth) * 2 - 1, -(clientY / innerHeight) * 2 + 1)
  raycaster.setFromCamera(pointer, camera)
  if (labels.visible) {
    const labelHit = raycaster.intersectObjects(labels.children, false)[0]
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
    if (arcHit) return { arc: arcHit.object as THREE.Line, object: arcHit.object }
  }
  const globeHit = raycaster.intersectObject(globe.land, false)[0]
  if (globeHit) return { surface: globeHit.point.clone().normalize() }
  return null
}

// -- card dragging (local freeform) -------------------------------------------

let draggingCard: THREE.Mesh | null = null

controls.ignorePointer = (e) => {
  if (!cards.visible) return false
  const hit = raycastAt(e.clientX, e.clientY)
  if (hit?.card && hit.object instanceof THREE.Mesh) {
    draggingCard = hit.object
    return true
  }
  return false
}

renderer.domElement.addEventListener('pointerdown', (e) => {
  downAt = [e.clientX, e.clientY]
})

window.addEventListener('pointermove', (e) => {
  if (!draggingCard || !(e.buttons & 1)) return
  pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1)
  raycaster.setFromCamera(pointer, camera)
  const hit = raycaster.intersectObject(globe.land, false)[0]
  if (!hit) return
  const p = hit.point.clone().normalize()
  draggingCard.userData.normal = p
  draggingCard.userData.glideTo = undefined
  draggingCard.position.copy(p).multiplyScalar(cardAltitude(p))
  renderer.domElement.style.cursor = 'grabbing'
})

window.addEventListener('pointerup', async (e) => {
  if (!draggingCard) return
  const mesh = draggingCard
  draggingCard = null
  renderer.domElement.style.cursor = 'grab'
  const moved = downAt && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 6
  if (!moved) return
  const item = mesh.userData.item as WorldItem
  const p = mesh.userData.normal as THREE.Vector3
  lastPositions.set(item.id, p.clone())
  try {
    await setPosition(item.id, [p.x, p.y, p.z], true)
    ui.setStatus(`pinned “${item.title}” here`)
    await refresh(true)
  } catch {
    ui.setStatus('failed to move item')
  }
})

// -- clicks --------------------------------------------------------------------

renderer.domElement.addEventListener('click', (e) => {
  if (downAt && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 6) return
  const hit = raycastAt(e.clientX, e.clientY)
  if (hit?.card) {
    void select(hit.card.id)
  } else if (hit?.cluster) {
    controls.flyTo(hit.cluster.center, { distance: 0.75, tilt: 0.45 })
    ui.showRegion({ label: hit.cluster.label, items: hit.cluster.items })
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

renderer.domElement.addEventListener('pointermove', (e) => {
  if (e.buttons !== 0) return
  const hit = raycastAt(e.clientX, e.clientY)
  const target = hit?.card || hit?.cluster ? (hit.object ?? null) : null
  if (target !== hovered) {
    if (hovered instanceof THREE.Mesh) hovered.scale.setScalar(1)
    if (hovered instanceof THREE.Sprite) hovered.scale.divideScalar(1.12)
    hovered = target
    if (hovered instanceof THREE.Mesh) hovered.scale.setScalar(1.12)
    if (hovered instanceof THREE.Sprite) hovered.scale.multiplyScalar(1.12)
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

// -- card orientation + glide -----------------------------------------------------

const camUp = new THREE.Vector3()
const cardUp = new THREE.Vector3()
const cardRight = new THREE.Vector3()
const cardBasis = new THREE.Matrix4()

/** Keep every card tangent to the sphere but rotated about its normal so its
 * text "up" tracks the camera's up — always readable, never upside-down.
 * Cards with a glide target also drift toward it here. */
function orientCards(dt: number): void {
  if (!cards.visible) return
  camUp.setFromMatrixColumn(camera.matrixWorld, 1)
  const glide = 1 - Math.exp(-dt * 1.4)
  for (const child of cards.children) {
    const mesh = child as THREE.Mesh
    const n = mesh.userData.normal as THREE.Vector3
    const to = mesh.userData.glideTo as THREE.Vector3 | undefined
    if (to) {
      const angle = n.angleTo(to)
      if (angle < 0.002) {
        mesh.userData.glideTo = undefined
      } else {
        const axis = new THREE.Vector3().crossVectors(n, to)
        if (axis.lengthSq() > 1e-12) {
          n.applyAxisAngle(axis.normalize(), angle * glide)
          mesh.position.copy(n).multiplyScalar(cardAltitude(n))
        }
      }
    }
    cardUp.copy(camUp).addScaledVector(n, -camUp.dot(n))
    if (cardUp.lengthSq() < 1e-8) continue
    cardUp.normalize()
    cardRight.crossVectors(cardUp, n)
    cardBasis.makeBasis(cardRight, cardUp, n)
    mesh.setRotationFromMatrix(cardBasis)
  }
}

// -- LOD crossfade -----------------------------------------------------------

function smoothstep(x: number, lo: number, hi: number): number {
  const t = THREE.MathUtils.clamp((x - lo) / (hi - lo), 0, 1)
  return t * t * (3 - 2 * t)
}

function applyLod(): void {
  const d = controls.viewDistance
  const cardOpacity = 1 - smoothstep(d, CARDS_FADE[0], CARDS_FADE[1])
  const labelOpacity = smoothstep(d, LABELS_FADE[0], LABELS_FADE[1])
  cards.visible = cardOpacity > 0.02
  labels.visible = labelOpacity > 0.02
  for (const child of cards.children) {
    ;((child as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = cardOpacity
  }
  for (const child of labels.children) {
    ;(child as THREE.Sprite).material.opacity = labelOpacity
  }
}

// -- loop -------------------------------------------------------------------

let lastFrame = performance.now()
renderer.setAnimationLoop(() => {
  const now = performance.now()
  const dt = Math.min(0.05, (now - lastFrame) / 1000)
  lastFrame = now
  controls.update(now)
  applyLod()
  orientCards(dt)
  renderer.render(scene, camera)
})

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
})

void refresh(true)
setInterval(() => void refresh(), 2500)
