import * as THREE from 'three'
import { fileUrl, type WorldItem } from './api'

// world-space size of a card sprite; sprites are screen-aligned so they keep
// this rectangle's proportions in the viewport at any camera angle
const CARD_W = 0.1
const CANVAS_W = 560
const CANVAS_H = 396
const BODY_H = 372 // card body; the rest is the pin notch
const CARD_H = CARD_W * (CANVAS_H / CANVAS_W)
const MARGIN = 24 // transparent margin so the baked shadow isn't clipped
export const CARD_ANCHOR_ALTITUDE = 0.004

const KIND_COLOR: Record<string, string> = {
  note: '#7fa75e',
  pdf: '#c46a4a',
  image: '#5a7fb5',
}
const KIND_GLYPH: Record<string, string> = { note: '¶', pdf: '⎘', image: '✦' }

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines: number,
): void {
  const words = text.split(/\s+/)
  let line = ''
  let lines = 0
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word
    if (ctx.measureText(candidate).width > maxWidth && line) {
      lines++
      if (lines === maxLines) {
        ctx.fillText(line + '…', x, y)
        return
      }
      ctx.fillText(line, x, y)
      y += lineHeight
      line = word
    } else {
      line = candidate
    }
  }
  if (line) ctx.fillText(line, x, y)
}

/** Card body + the little pin notch pointing at the anchor. */
function cardFrame(ctx: CanvasRenderingContext2D, fill: string): Path2D {
  const w = CANVAS_W - MARGIN * 2
  const h = BODY_H - MARGIN * 2
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H)
  const path = new Path2D()
  path.roundRect(MARGIN, MARGIN, w, h, 18)
  path.moveTo(CANVAS_W / 2 - 20, BODY_H - MARGIN - 2)
  path.lineTo(CANVAS_W / 2, CANVAS_H - 4)
  path.lineTo(CANVAS_W / 2 + 20, BODY_H - MARGIN - 2)
  path.closePath()
  ctx.shadowColor = 'rgba(10, 14, 24, 0.4)'
  ctx.shadowBlur = 18
  ctx.shadowOffsetY = 10
  ctx.fillStyle = fill
  ctx.fill(path)
  ctx.shadowColor = 'transparent'
  return path
}

function drawCard(ctx: CanvasRenderingContext2D, item: WorldItem): void {
  const w = CANVAS_W - MARGIN * 2
  const frame = cardFrame(ctx, '#faf3e0')
  ctx.strokeStyle = '#54442f'
  ctx.lineWidth = 4
  ctx.stroke(frame)

  // kind ribbon
  const kindColor = KIND_COLOR[item.kind] ?? '#8a7350'
  ctx.fillStyle = kindColor
  ctx.beginPath()
  ctx.roundRect(MARGIN, MARGIN, w, 14, { tl: 18, tr: 18, br: 0, bl: 0 } as never)
  ctx.fill()

  // glyph badge
  ctx.fillStyle = kindColor
  ctx.beginPath()
  ctx.arc(CANVAS_W - MARGIN - 52, MARGIN + 64, 30, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#faf3e0'
  ctx.font = '36px Georgia, serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(KIND_GLYPH[item.kind] ?? '·', CANVAS_W - MARGIN - 52, MARGIN + 66)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'

  // title
  ctx.fillStyle = '#3a2f20'
  ctx.font = 'bold 44px Georgia, serif'
  wrapText(ctx, item.title, MARGIN + 30, MARGIN + 86, w - 150, 52, 3)

  // tags
  if (item.tags.length > 0) {
    ctx.font = 'italic 27px Georgia, serif'
    let x = MARGIN + 30
    const y = BODY_H - MARGIN - 30
    for (const tag of item.tags.slice(0, 4)) {
      const label = `#${tag}`
      const tw = ctx.measureText(label).width
      if (x + tw > CANVAS_W - MARGIN - 30) break
      ctx.fillStyle = 'rgba(122, 103, 72, 0.16)'
      ctx.beginPath()
      ctx.roundRect(x - 10, y - 26, tw + 20, 38, 19)
      ctx.fill()
      ctx.fillStyle = '#7a6748'
      ctx.fillText(label, x, y)
      x += tw + 34
    }
  }
  if (item.pinned) {
    ctx.fillStyle = '#8a7350'
    ctx.font = '30px Georgia, serif'
    ctx.fillText('⚲', CANVAS_W - MARGIN - 64, BODY_H - MARGIN - 28)
  }
}

/** Repaint the card as a framed artwork once its image loads. */
function drawImageCard(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  item: WorldItem,
): void {
  const w = CANVAS_W - MARGIN * 2
  const h = BODY_H - MARGIN * 2
  const frame = cardFrame(ctx, '#faf3e0')
  ctx.save()
  ctx.beginPath()
  ctx.roundRect(MARGIN + 8, MARGIN + 8, w - 16, h - 16, 12)
  ctx.clip()
  const scale = Math.max((w - 16) / img.width, (h - 16) / img.height)
  const dw = img.width * scale
  const dh = img.height * scale
  ctx.drawImage(img, MARGIN + 8 + (w - 16 - dw) / 2, MARGIN + 8 + (h - 16 - dh) / 2, dw, dh)
  const grad = ctx.createLinearGradient(0, BODY_H - MARGIN - 96, 0, BODY_H - MARGIN)
  grad.addColorStop(0, 'rgba(20, 16, 10, 0)')
  grad.addColorStop(1, 'rgba(20, 16, 10, 0.78)')
  ctx.fillStyle = grad
  ctx.fillRect(MARGIN + 8, BODY_H - MARGIN - 96, w - 16, 88)
  ctx.fillStyle = '#f5eed9'
  ctx.font = 'bold 34px Georgia, serif'
  wrapText(ctx, item.title, MARGIN + 26, BODY_H - MARGIN - 34, w - 60, 38, 1)
  ctx.restore()
  ctx.strokeStyle = '#54442f'
  ctx.lineWidth = 4
  ctx.stroke(frame)
}

/** Cards are sprites: always camera-facing, never perspective-skewed —
 * a flag planted at its anchor point (sprite center sits at the notch tip). */
export function makeCard(item: WorldItem, elevation = 0): THREE.Sprite {
  const canvas = document.createElement('canvas')
  canvas.width = CANVAS_W
  canvas.height = CANVAS_H
  const ctx = canvas.getContext('2d')!
  drawCard(ctx, item)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 8
  if (item.kind === 'image') {
    const img = new Image()
    img.onload = () => {
      drawImageCard(ctx, img, item)
      texture.needsUpdate = true
    }
    img.src = fileUrl(item.id)
  }
  // no depth test: nearby terrain would bite chunks out of the quad.
  // cards past the horizon are culled manually each frame (applyLod).
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    alphaTest: 0.04,
  })
  const sprite = new THREE.Sprite(material)
  sprite.renderOrder = 15 // above terrain and arcs, below cluster labels
  sprite.center.set(0.5, 0) // anchor at the notch tip; the flag rises upward
  sprite.scale.set(CARD_W, CARD_H, 1)
  const p = new THREE.Vector3(...item.pos).normalize()
  sprite.position.copy(p).multiplyScalar(1 + Math.max(0, elevation) + CARD_ANCHOR_ALTITUDE)
  sprite.userData.item = item
  sprite.userData.normal = p
  return sprite
}

export function disposeCard(sprite: THREE.Sprite): void {
  sprite.material.map?.dispose()
  sprite.material.dispose()
}
