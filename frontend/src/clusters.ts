import * as THREE from 'three'
import type { WorldItem } from './api'

export interface Cluster {
  center: THREE.Vector3
  items: WorldItem[]
  label: string
  /** the tag this label came from, when it came from one */
  labelTag?: string
  parent?: Cluster
  /** group accent colour (fine clusters); cards of members tint toward it */
  color?: string
}

// -- clustering -----------------------------------------------------------------

/** Leader clustering on geodesic distance: items join the nearest cluster
 * CENTER within `radius`, so dense worlds can't chain into one mega-region
 * (single-linkage did exactly that). Two refinement passes settle centers.
 * Fine up to ~1k items; past that this moves to the backend. */
export function computeClusters(
  items: WorldItem[],
  radius = 0.6,
  exclude?: Set<string>,
): Cluster[] {
  const dirs = items.map((i) => new THREE.Vector3(...i.pos))
  let centers: THREE.Vector3[] = []
  let assign: number[] = []
  for (let pass = 0; pass < 3; pass++) {
    assign = []
    const counts: number[] = pass === 0 ? [] : centers.map(() => 0)
    if (pass === 0) centers = []
    const sums = centers.map(() => new THREE.Vector3())
    for (let i = 0; i < dirs.length; i++) {
      let best = -1
      let bestAngle = radius
      for (let c = 0; c < centers.length; c++) {
        const a = dirs[i].angleTo(centers[c])
        if (a < bestAngle) {
          bestAngle = a
          best = c
        }
      }
      if (best === -1) {
        centers.push(dirs[i].clone())
        sums.push(dirs[i].clone())
        counts.push(1)
        best = centers.length - 1
      } else {
        sums[best].add(dirs[i])
        counts[best]++
      }
      assign.push(best)
    }
    centers = sums
      .map((s, c) => (counts[c] > 0 ? s.normalize() : centers[c]))
      .filter((_, c) => counts[c] > 0)
  }
  const groups = new Map<number, number[]>()
  for (let i = 0; i < assign.length; i++) {
    let g = groups.get(assign[i])
    if (!g) groups.set(assign[i], (g = []))
    g.push(i)
  }
  const result = [...groups.values()].map((idx) => {
    const members = idx.map((i) => items[i])
    const center = idx
      .reduce((acc, i) => acc.add(dirs[i]), new THREE.Vector3())
      .normalize()
    const { label, tag } = labelFor(members, center, exclude)
    return { center, items: members, label, labelTag: tag }
  })
  disambiguate(result)
  return result
}

// -- naming -----------------------------------------------------------------------

function titleCase(s: string): string {
  if (s.length <= 3) return s.toUpperCase() // acronym tags: ml -> ML
  return s.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function labelFor(
  members: WorldItem[],
  center: THREE.Vector3,
  exclude?: Set<string>,
): { label: string; tag?: string } {
  // prefer a tag that actually represents the cluster — but never one of the
  // excluded tags (ancestor names, or tags ubiquitous in the parent: those
  // don't distinguish this group from its siblings)
  const counts = new Map<string, number>()
  for (const m of members) {
    for (const t of m.tags) {
      if (!exclude?.has(t)) counts.set(t, (counts.get(t) ?? 0) + 1)
    }
  }
  let best: string | null = null
  let bestCount = 1
  for (const [tag, count] of counts) {
    if (count > bestCount) {
      best = tag
      bestCount = count
    }
  }
  if (best) return { label: titleCase(best), tag: best }
  return { label: centralTitle(members, center) }
}

function centralTitle(members: WorldItem[], center: THREE.Vector3): string {
  let pick = members[0]
  let pickDist = Infinity
  for (const m of members) {
    const d = new THREE.Vector3(...m.pos).angleTo(center)
    if (d < pickDist) {
      pickDist = d
      pick = m
    }
  }
  const t = pick.title.replace(/_/g, ' ')
  return t.length > 24 ? t.slice(0, 23).trimEnd() + '…' : t
}

function dominantTag(items: WorldItem[]): string | null {
  const counts = new Map<string, number>()
  for (const item of items) {
    for (const tag of item.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  let best: string | null = null
  let bestCount = 1
  for (const [tag, count] of counts) {
    if (count > bestCount) {
      best = tag
      bestCount = count
    }
  }
  return best
}

/** If several siblings claim the same label, that name distinguishes nothing:
 * ALL of them fall back to their most central item's title (no "Tag · X"
 * composites — those read as broken hierarchy). The only exception is a label
 * honestly inherited from an identical parent, which is kept. */
function disambiguate(clusters: Cluster[]): void {
  const byLabel = new Map<string, Cluster[]>()
  for (const c of clusters) {
    let g = byLabel.get(c.label)
    if (!g) byLabel.set(c.label, (g = []))
    g.push(c)
  }
  for (const group of byLabel.values()) {
    if (group.length < 2) continue
    for (const c of group) {
      if (c.parent && c.parent.label === c.label) continue
      c.label = centralTitle(c.items, c.center)
      c.labelTag = undefined
    }
  }
}

// -- hierarchy ----------------------------------------------------------------------

/** Tags that must not name a child of `parent`: every ancestor's own name-tag,
 * plus any tag so common in the parent that it distinguishes nothing. */
function parentExclusions(parent: Cluster): Set<string> {
  const exclude = new Set<string>()
  let p: Cluster | undefined = parent
  while (p) {
    if (p.labelTag) exclude.add(p.labelTag)
    p = p.parent
  }
  const counts = new Map<string, number>()
  for (const item of parent.items) {
    for (const tag of item.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  for (const [tag, count] of counts) {
    if (count / parent.items.length >= 0.6) exclude.add(tag)
  }
  return exclude
}

/** Top LOD level: merge child regions that share a dominant tag into one
 * continent ("ART"), regardless of how far the topic sprawls — pure geometric
 * merging splits big domains. Untagged children join the nearest continent. */
export function computeSuperClusters(children: Cluster[]): Cluster[] {
  const byTag = new Map<string, Cluster[]>()
  const untagged: Cluster[] = []
  for (const child of children) {
    const tag = dominantTag(child.items)
    if (tag) {
      let group = byTag.get(tag)
      if (!group) byTag.set(tag, (group = []))
      group.push(child)
    } else {
      untagged.push(child)
    }
  }
  const supers: Cluster[] = []
  for (const [tag, group] of byTag) {
    const items = group.flatMap((c) => c.items)
    const center = group
      .reduce(
        (acc, c) => acc.addScaledVector(c.center, c.items.length),
        new THREE.Vector3(),
      )
      .normalize()
    const sup: Cluster = { center, items, label: titleCase(tag), labelTag: tag }
    for (const c of group) c.parent = sup
    supers.push(sup)
  }
  for (const child of untagged) {
    let best: Cluster | null = null
    let bestAngle = 0.85
    for (const s of supers) {
      const a = s.center.angleTo(child.center)
      if (a < bestAngle) {
        bestAngle = a
        best = s
      }
    }
    if (best) {
      best.items = best.items.concat(child.items)
      child.parent = best
    } else {
      const sup: Cluster = {
        center: child.center.clone(),
        items: child.items,
        label: child.label,
        labelTag: child.labelTag,
      }
      child.parent = sup
      supers.push(sup)
    }
  }
  disambiguate(supers)
  return supers
}

/** Re-name children now that their parents exist. A child identical to its
 * parent INHERITS the parent's label (same group, same name — renaming it
 * would lie); others get the most distinctive name available. */
export function relabelUnderParents(children: Cluster[]): void {
  for (const c of children) {
    const p = c.parent
    if (!p) continue
    if (c.items.length === p.items.length) {
      c.label = p.label
      c.labelTag = p.labelTag
      continue
    }
    const { label, tag } = labelFor(c.items, c.center, parentExclusions(p))
    c.label = label
    c.labelTag = tag
  }
  disambiguate(children)
}

/** Build the next level INSIDE each parent, so children are true subsets.
 * Parents that don't subdivide produce no children (their label simply hands
 * over to the cards); singleton children are skipped — the card is the label. */
export function subdivide(parents: Cluster[], radius: number): Cluster[] {
  const out: Cluster[] = []
  for (const parent of parents) {
    if (parent.items.length < 3) continue
    const subs = computeClusters(parent.items, radius, parentExclusions(parent))
    if (subs.length <= 1) continue
    for (const sub of subs) {
      if (sub.items.length < 2) continue
      sub.parent = parent
      out.push(sub)
    }
  }
  disambiguate(out)
  return out
}

// -- sprites -----------------------------------------------------------------------

export function makeClusterSprite(
  cluster: Cluster,
  elevation: number,
  sizeMul = 1,
  accent?: string,
): THREE.Sprite {
  const canvas = document.createElement('canvas')
  canvas.width = 720
  canvas.height = 200
  const ctx = canvas.getContext('2d')!
  const text = cluster.label
  const countText = String(cluster.items.length)

  ctx.font = '600 58px Georgia, serif'
  const tw = ctx.measureText(text).width
  ctx.font = '400 40px Georgia, serif'
  const cw = ctx.measureText(countText).width
  const pad = 40
  const accentW = accent ? 34 : 0
  const pillW = Math.min(688, tw + cw + pad * 2 + 34 + accentW)
  const pillH = 108
  const x0 = (canvas.width - pillW) / 2
  const y0 = (canvas.height - pillH) / 2

  ctx.shadowColor = 'rgba(0,0,0,0.45)'
  ctx.shadowBlur = 22
  ctx.shadowOffsetY = 8
  ctx.fillStyle = 'rgba(24, 28, 38, 0.82)'
  ctx.beginPath()
  ctx.roundRect(x0, y0, pillW, pillH, pillH / 2)
  ctx.fill()
  ctx.shadowColor = 'transparent'
  ctx.strokeStyle = 'rgba(245, 238, 217, 0.55)'
  ctx.lineWidth = 3
  ctx.stroke()

  if (accent) {
    ctx.fillStyle = accent
    ctx.beginPath()
    ctx.arc(x0 + pad - 6, canvas.height / 2 + 2, 11, 0, Math.PI * 2)
    ctx.fill()
  }

  ctx.fillStyle = '#f5eed9'
  ctx.font = '600 58px Georgia, serif'
  ctx.textBaseline = 'middle'
  ctx.fillText(
    text,
    x0 + pad + accentW,
    canvas.height / 2 + 2,
    pillW - pad * 2 - cw - 30 - accentW,
  )
  ctx.fillStyle = 'rgba(245, 238, 217, 0.62)'
  ctx.font = '400 40px Georgia, serif'
  ctx.fillText(countText, x0 + pillW - pad - cw, canvas.height / 2 + 4)

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  // no depth test: the quad would slice into the terrain at the horizon.
  // far-side labels are culled manually each frame instead (applyLod).
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  })
  const sprite = new THREE.Sprite(material)
  sprite.renderOrder = 20
  const w = (0.3 + Math.log2(cluster.items.length + 1) * 0.045) * sizeMul
  sprite.scale.set(w, w * (canvas.height / canvas.width), 1)
  sprite.position
    .copy(cluster.center)
    .multiplyScalar(1 + Math.max(0, elevation) + 0.11)
  sprite.userData.cluster = cluster
  return sprite
}

export function disposeSprite(sprite: THREE.Sprite): void {
  sprite.material.map?.dispose()
  sprite.material.dispose()
}
