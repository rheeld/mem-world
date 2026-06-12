import * as THREE from 'three'
import type { WorldItem } from './api'

export interface MiniCluster {
  center: THREE.Vector3
  label: string
  count: number
}

const W = 390
const H = 195
const DPR = 2
const MIN_ZOOM = 1
const MAX_ZOOM = 7
const LABEL_ZOOM_MAX = 2 // below this: high-level region summaries
const TITLE_ZOOM_MIN = 3.5 // above this: individual item titles

const KIND_DOT: Record<string, string> = {
  note: '#a8c97e',
  pdf: '#d98a66',
  image: '#7fa3d6',
}

function toMap(x: number, y: number, z: number): [number, number] {
  const lon = Math.atan2(z, x)
  const lat = Math.asin(THREE.MathUtils.clamp(y, -1, 1))
  return [((lon + Math.PI) / (2 * Math.PI)) * W, (1 - (lat + Math.PI / 2) / Math.PI) * H]
}

/** Bottom-left overview: the whole world flattened to an equirect map.
 * Scroll to zoom (region summaries when zoomed out, items when zoomed in);
 * click to centre that point on the globe. */
export interface MiniClusterLevels {
  coarse: MiniCluster[]
  fine: MiniCluster[]
}

export class Minimap {
  private base = document.createElement('canvas')
  private ctx: CanvasRenderingContext2D
  private items: WorldItem[] = []
  private clusters: MiniClusterLevels = { coarse: [], fine: [] }
  private zoom = 1
  private cx = W / 2
  private cy = H / 2
  private dirty = true

  constructor(canvas: HTMLCanvasElement, onPick: (dir: THREE.Vector3) => void) {
    canvas.width = W * DPR
    canvas.height = H * DPR
    this.base.width = W * DPR
    this.base.height = H * DPR
    this.ctx = canvas.getContext('2d')!
    this.ctx.scale(DPR, DPR)

    canvas.addEventListener('click', (e) => {
      const r = canvas.getBoundingClientRect()
      const [mx, my] = this.fromCanvas(
        ((e.clientX - r.left) / r.width) * W,
        ((e.clientY - r.top) / r.height) * H,
      )
      const lon = (mx / W) * 2 * Math.PI - Math.PI
      const lat = (1 - my / H) * Math.PI - Math.PI / 2
      onPick(
        new THREE.Vector3(
          Math.cos(lat) * Math.cos(lon),
          Math.sin(lat),
          Math.cos(lat) * Math.sin(lon),
        ),
      )
    })

    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault()
        const r = canvas.getBoundingClientRect()
        const px = ((e.clientX - r.left) / r.width) * W
        const py = ((e.clientY - r.top) / r.height) * H
        const [mx, my] = this.fromCanvas(px, py)
        this.zoom = THREE.MathUtils.clamp(
          this.zoom * Math.exp(-e.deltaY * 0.0022),
          MIN_ZOOM,
          MAX_ZOOM,
        )
        // keep the map point under the cursor fixed
        this.cx = mx - (px - W / 2) / this.zoom
        this.cy = my - (py - H / 2) / this.zoom
        this.clampCenter()
        this.dirty = true
      },
      { passive: false },
    )
  }

  private clampCenter(): void {
    if (this.zoom <= 1.001) {
      this.cx = W / 2
      this.cy = H / 2
      return
    }
    this.cx = ((this.cx % W) + W) % W
    const half = H / (2 * this.zoom)
    this.cy = THREE.MathUtils.clamp(this.cy, half, H - half)
  }

  private toCanvas(mx: number, my: number): [number, number] {
    let dx = mx - this.cx
    dx = ((dx + W * 1.5) % W) - W / 2
    return [W / 2 + dx * this.zoom, H / 2 + (my - this.cy) * this.zoom]
  }

  private fromCanvas(x: number, y: number): [number, number] {
    const mx = (((this.cx + (x - W / 2) / this.zoom) % W) + W) % W
    const my = THREE.MathUtils.clamp(this.cy + (y - H / 2) / this.zoom, 0, H)
    return [mx, my]
  }

  setWorld(items: WorldItem[], clusters: MiniClusterLevels): void {
    this.items = items
    this.clusters = clusters
    this.dirty = true
  }

  private renderBase(): void {
    const ctx = this.base.getContext('2d')!
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
    ctx.clearRect(0, 0, W, H)
    ctx.fillStyle = '#23405e'
    ctx.fillRect(0, 0, W, H)

    // graticule
    ctx.strokeStyle = 'rgba(245, 238, 217, 0.07)'
    ctx.lineWidth = 1
    for (let i = 0; i <= 12; i++) {
      const [x] = this.toCanvas((i / 12) * W, 0)
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, H)
      ctx.stroke()
    }
    for (let i = 1; i < 6; i++) {
      const [, y] = this.toCanvas(0, (i / 6) * H)
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(W, y)
      ctx.stroke()
    }

    // land blobs
    const r = Math.min(11 * this.zoom, 34)
    for (const item of this.items) {
      const [mx, my] = toMap(...item.pos)
      const [x, y] = this.toCanvas(mx, my)
      if (x < -r || x > W + r || y < -r || y > H + r) continue
      const g = ctx.createRadialGradient(x, y, 0, x, y, r)
      g.addColorStop(0, 'rgba(150, 165, 105, 0.5)')
      g.addColorStop(1, 'rgba(150, 165, 105, 0)')
      ctx.fillStyle = g
      ctx.fillRect(x - r, y - r, r * 2, r * 2)
    }

    if (this.zoom >= LABEL_ZOOM_MAX) {
      // item dots, with titles at deep zoom
      const showTitles = this.zoom >= TITLE_ZOOM_MIN
      ctx.font = '9px Georgia, serif'
      for (const item of this.items) {
        const [mx, my] = toMap(...item.pos)
        const [x, y] = this.toCanvas(mx, my)
        if (x < -4 || x > W + 4 || y < -4 || y > H + 4) continue
        ctx.fillStyle = KIND_DOT[item.kind] ?? '#ddd'
        ctx.beginPath()
        ctx.arc(x, y, 1.9, 0, Math.PI * 2)
        ctx.fill()
        if (showTitles) {
          const t = item.title.length > 18 ? item.title.slice(0, 17) + '…' : item.title
          ctx.strokeStyle = 'rgba(12, 16, 26, 0.85)'
          ctx.lineWidth = 2.5
          ctx.strokeText(t, x + 5, y + 3)
          ctx.fillStyle = '#e8e2cf'
          ctx.fillText(t, x + 5, y + 3)
        }
      }
    } else {
      // high-level summaries: region labels, biggest first, de-cluttered;
      // continents while zoomed right out, regions once partly zoomed
      ctx.font = '600 10px Georgia, serif'
      ctx.textAlign = 'center'
      const taken: [number, number, number, number][] = []
      const source = this.zoom < 1.45 ? this.clusters.coarse : this.clusters.fine
      const sorted = [...source].sort((a, b) => b.count - a.count)
      for (const c of sorted) {
        const [mx, my] = toMap(c.center.x, c.center.y, c.center.z)
        const [x, y] = this.toCanvas(mx, my)
        if (x < 0 || x > W || y < 4 || y > H - 4) continue
        const text = `${c.label} · ${c.count}`
        const tw = ctx.measureText(text).width
        const box: [number, number, number, number] = [x - tw / 2 - 2, y - 8, tw + 4, 12]
        if (
          taken.some(
            ([bx, by, bw, bh]) =>
              box[0] < bx + bw && box[0] + box[2] > bx && box[1] < by + bh && box[1] + box[3] > by,
          )
        ) {
          continue
        }
        taken.push(box)
        ctx.strokeStyle = 'rgba(12, 16, 26, 0.9)'
        ctx.lineWidth = 3
        ctx.strokeText(text, x, y)
        ctx.fillStyle = '#f5eed9'
        ctx.fillText(text, x, y)
      }
      ctx.textAlign = 'left'
    }
  }

  /** Per-frame: cached layers + the current view marker. */
  draw(target: THREE.Vector3): void {
    if (this.dirty) {
      this.renderBase()
      this.dirty = false
    }
    const ctx = this.ctx
    ctx.clearRect(0, 0, W, H)
    ctx.drawImage(this.base, 0, 0, W, H)
    const [mx, my] = toMap(target.x, target.y, target.z)
    const [x, y] = this.toCanvas(mx, my)
    ctx.strokeStyle = '#f5eed9'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.arc(x, y, 5, 0, Math.PI * 2)
    ctx.stroke()
    ctx.fillStyle = '#f5eed9'
    ctx.beginPath()
    ctx.arc(x, y, 1.5, 0, Math.PI * 2)
    ctx.fill()
    if (this.zoom > 1.001) {
      ctx.font = 'italic 9px Georgia, serif'
      ctx.fillStyle = 'rgba(245, 238, 217, 0.55)'
      ctx.fillText(`${this.zoom.toFixed(1)}×`, 6, H - 6)
    }
  }
}
