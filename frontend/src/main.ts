import * as THREE from 'three'
import {
  createNote,
  deleteItem,
  fetchItem,
  fetchWorld,
  searchWorld,
  updateNote,
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
let selectedId: number | null = null
let hovered: THREE.Object3D | null = null

const ui = new UI({
  onSearch: (q) => searchWorld(q),
  onPick: (item) => {
    controls.flyTo(new THREE.Vector3(...item.pos))
    void select(item.id)
  },
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
  onClose: () => {
    selectedId = null
    drawArcs()
  },
})

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

function rebuild(): void {
  if (!world) return
  globe.update(world.items)
  for (const child of [...cards.children]) {
    cards.remove(child)
    disposeCard(child as THREE.Mesh)
  }
  for (const item of world.items) {
    cards.add(makeCard(item, globe.elevation(new THREE.Vector3(...item.pos))))
  }
  for (const child of [...labels.children]) {
    labels.remove(child)
    disposeSprite(child as THREE.Sprite)
  }
  for (const cluster of computeClusters(world.items)) {
    labels.add(makeClusterSprite(cluster, globe.elevation(cluster.center)))
  }
  drawArcs()
  ui.setStatus(
    world.items.length === 0
      ? 'open ocean — drop a file into vault/ or double-click to write'
      : `${world.items.length} items · ${labels.children.length} regions`,
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
    arcs.add(makeArc(new THREE.Vector3(...a.pos), new THREE.Vector3(...b.pos)))
  }
}

function makeArc(a: THREE.Vector3, b: THREE.Vector3): THREE.Line {
  const angle = a.angleTo(b)
  const elevA = Math.max(0, globe.elevation(a))
  const elevB = Math.max(0, globe.elevation(b))
  const points: THREE.Vector3[] = []
  for (let i = 0; i <= 64; i++) {
    const t = i / 64
    const p = a.clone().lerp(b, t).normalize()
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
  return new THREE.Line(geometry, material)
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
  surface?: THREE.Vector3
  object?: THREE.Object3D
}

function raycast(e: MouseEvent): Hit | null {
  pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1)
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
  const globeHit = raycaster.intersectObject(globe.land, false)[0]
  if (globeHit) return { surface: globeHit.point.clone().normalize() }
  return null
}

renderer.domElement.addEventListener('pointerdown', (e) => {
  downAt = [e.clientX, e.clientY]
})

renderer.domElement.addEventListener('click', (e) => {
  if (downAt && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 6) return
  const hit = raycast(e)
  if (hit?.card) {
    void select(hit.card.id)
  } else if (hit?.cluster) {
    controls.flyTo(hit.cluster.center, { distance: 0.75, tilt: 0.45 })
  } else if (selectedId !== null) {
    ui.hide() // click on empty terrain/ocean dismisses the panel
  }
})

renderer.domElement.addEventListener('dblclick', (e) => {
  const hit = raycast(e)
  if (hit?.surface) {
    ui.showCreateForm([hit.surface.x, hit.surface.y, hit.surface.z])
  }
})

renderer.domElement.addEventListener('pointermove', (e) => {
  if (e.buttons !== 0) return
  const hit = raycast(e)
  const target = hit?.card || hit?.cluster ? (hit.object ?? null) : null
  if (target !== hovered) {
    if (hovered && hovered instanceof THREE.Mesh) hovered.scale.setScalar(1)
    if (hovered && hovered instanceof THREE.Sprite) {
      hovered.scale.divideScalar(1.12)
    }
    hovered = target
    if (hovered instanceof THREE.Mesh) hovered.scale.setScalar(1.12)
    if (hovered instanceof THREE.Sprite) hovered.scale.multiplyScalar(1.12)
    renderer.domElement.style.cursor = hovered ? 'pointer' : 'grab'
  }
})

// -- card orientation ----------------------------------------------------------

const camUp = new THREE.Vector3()
const cardUp = new THREE.Vector3()
const cardRight = new THREE.Vector3()
const cardBasis = new THREE.Matrix4()

/** Keep every card tangent to the sphere but rotated about its normal so its
 * text "up" tracks the camera's up — always readable, never upside-down. */
function orientCards(): void {
  if (!cards.visible) return
  camUp.setFromMatrixColumn(camera.matrixWorld, 1)
  for (const child of cards.children) {
    const mesh = child as THREE.Mesh
    const n = mesh.userData.normal as THREE.Vector3
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

renderer.setAnimationLoop(() => {
  controls.update()
  applyLod()
  orientCards()
  renderer.render(scene, camera)
})

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
})

void refresh(true)
setInterval(() => void refresh(), 2500)
