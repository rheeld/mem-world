import * as THREE from 'three'

export interface FlyToOptions {
  distance?: number
  tilt?: number
  duration?: number
}

const MIN_TILT = 0.06 // keep view dir off the exact local-up axis (lookAt degenerates)

function shortAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a))
}

/** Rotate `v` toward `to` by fraction `t` of the angle between them (slerp). */
function rotateToward(v: THREE.Vector3, to: THREE.Vector3, t: number): void {
  const angle = v.angleTo(to)
  if (angle < 1e-7) return
  const axis = new THREE.Vector3().crossVectors(v, to)
  if (axis.lengthSq() < 1e-12) return // antipodal; let input move it off the singularity
  axis.normalize()
  v.applyAxisAngle(axis, angle * t)
}

/**
 * Google-Earth-style globe camera. The camera always looks at a point ON the
 * globe surface: left-drag pans that point (the ground follows the cursor
 * exactly), wheel zooms toward it, and holding right/middle mouse tilts/orbits
 * around it. The tangent reference frame is parallel-transported with the
 * target rather than derived from a world axis, so panning is smooth
 * everywhere on the sphere — including over the poles.
 */
export class GlobeControls {
  // desired state — input writes here; the camera eases toward it
  target = new THREE.Vector3(0, 0, 1)
  distance = 2.6
  tilt = 0.25
  azimuth = 0
  minDistance = 0.03
  maxDistance = 4.5
  maxTilt = 1.5

  // parallel-transported tangent reference; rotated along with the target
  private northRef = new THREE.Vector3(0, 1, 0)

  // smoothed state — what the camera actually uses
  private sTarget = new THREE.Vector3(0, 0, 1)
  private sDistance = 2.6
  private sTilt = 0.25
  private sAzimuth = 0

  private mode: 'none' | 'pan' | 'tilt' = 'none'
  private lastX = 0
  private lastY = 0
  private lastNow = performance.now()
  private anim: {
    start: number
    duration: number
    fromTarget: THREE.Vector3
    fromNorth: THREE.Vector3
    rotation: THREE.Quaternion
    fromDistance: number
    toDistance: number
    fromTilt: number
    toTilt: number
  } | null = null

  /** When set, a truthy return claims the left-button gesture (e.g. card drag). */
  ignorePointer?: (e: PointerEvent) => boolean

  constructor(
    private camera: THREE.PerspectiveCamera,
    private dom: HTMLElement,
    private elevationAt?: (dir: THREE.Vector3) => number,
  ) {
    dom.addEventListener('pointerdown', this.onDown)
    window.addEventListener('pointermove', this.onMove)
    window.addEventListener('pointerup', this.onUp)
    dom.addEventListener('wheel', this.onWheel, { passive: false })
    dom.addEventListener('contextmenu', (e) => e.preventDefault())
    dom.style.cursor = 'grab'
    this.apply()
  }

  /** Smoothed camera distance — drive zoom-dependent LOD off this. */
  get viewDistance(): number {
    return this.sDistance
  }

  private onDown = (e: PointerEvent): void => {
    if (e.button === 0 && this.ignorePointer?.(e)) return
    this.anim = null
    if (e.button === 0) this.mode = 'pan'
    else if (e.button === 1 || e.button === 2) {
      this.mode = 'tilt'
      e.preventDefault()
    }
    this.dom.style.cursor = 'grabbing'
    this.lastX = e.clientX
    this.lastY = e.clientY
  }

  private onMove = (e: PointerEvent): void => {
    if (this.mode === 'none') return
    const dx = e.clientX - this.lastX
    const dy = e.clientY - this.lastY
    this.lastX = e.clientX
    this.lastY = e.clientY
    if (this.mode === 'pan') this.pan(dx, dy)
    else this.orbit(dx, dy)
  }

  private onUp = (): void => {
    this.mode = 'none'
    this.dom.style.cursor = 'grab'
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault()
    this.anim = null
    this.distance = THREE.MathUtils.clamp(
      this.distance * Math.exp(e.deltaY * 0.0014),
      this.minDistance,
      this.maxDistance,
    )
  }

  /** True "grab the ground": one pixel of cursor = one pixel of ground. */
  private pan(dx: number, dy: number): void {
    const fov = THREE.MathUtils.degToRad(this.camera.fov)
    const k = (2 * this.distance * Math.tan(fov / 2)) / this.dom.clientHeight
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0)
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1)
    // signs verified empirically: the ground follows the cursor
    const q = new THREE.Quaternion()
      .setFromAxisAngle(up, -dx * k)
      .multiply(new THREE.Quaternion().setFromAxisAngle(right, -dy * k))
    this.target.applyQuaternion(q).normalize()
    this.northRef.applyQuaternion(q).normalize() // carry the frame along
  }

  /** Hold right/middle mouse: drag up tilts toward the horizon, sideways rotates. */
  private orbit(dx: number, dy: number): void {
    this.azimuth -= dx * 0.005
    this.tilt = THREE.MathUtils.clamp(this.tilt - dy * 0.005, MIN_TILT, this.maxTilt)
  }

  flyTo(point: THREE.Vector3, opts: FlyToOptions = {}): void {
    const toTarget = point.clone().normalize()
    this.anim = {
      start: performance.now(),
      duration: opts.duration ?? 1200,
      fromTarget: this.target.clone(),
      fromNorth: this.northRef.clone(),
      rotation: new THREE.Quaternion().setFromUnitVectors(
        this.target.clone().normalize(),
        toTarget,
      ),
      fromDistance: this.distance,
      toDistance: opts.distance ?? Math.min(this.distance, 0.5),
      fromTilt: this.tilt,
      toTilt: opts.tilt ?? 0.5,
    }
  }

  update(now = performance.now()): void {
    if (this.anim) {
      const a = this.anim
      const t = Math.min(1, (now - a.start) / a.duration)
      const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
      const qt = new THREE.Quaternion().slerp(a.rotation, e)
      this.target.copy(a.fromTarget).applyQuaternion(qt).normalize()
      this.northRef.copy(a.fromNorth).applyQuaternion(qt).normalize()
      this.distance = a.fromDistance * Math.pow(a.toDistance / a.fromDistance, e)
      this.tilt = a.fromTilt + (a.toTilt - a.fromTilt) * e
      if (t >= 1) this.anim = null
    }

    const dt = Math.min(0.05, (now - this.lastNow) / 1000)
    this.lastNow = now
    const s = 1 - Math.exp(-dt * 10)
    rotateToward(this.sTarget, this.target, s)
    this.sDistance *= Math.pow(this.distance / this.sDistance, s)
    this.sTilt += (this.tilt - this.sTilt) * s
    this.sAzimuth += shortAngle(this.azimuth - this.sAzimuth) * s

    this.apply()
  }

  /** Tangent basis at `up`, built from the parallel-transported reference. */
  private basis(up: THREE.Vector3): { east: THREE.Vector3; north: THREE.Vector3 } {
    const north = this.northRef
      .clone()
      .addScaledVector(up, -this.northRef.dot(up))
    if (north.lengthSq() < 1e-10) {
      // reference degenerated onto the radial axis; rebuild it arbitrarily
      north.set(1, 0, 0).addScaledVector(up, -up.x)
    }
    north.normalize()
    const east = new THREE.Vector3().crossVectors(north, up)
    return { east, north }
  }

  private apply(): void {
    const up = this.sTarget.clone().normalize()
    const { east, north } = this.basis(up)
    const sin = Math.sin(this.sTilt)
    const dir = up
      .clone()
      .multiplyScalar(Math.cos(this.sTilt))
      .addScaledVector(east, sin * Math.cos(this.sAzimuth))
      .addScaledVector(north, sin * Math.sin(this.sAzimuth))
    this.camera.position.copy(this.sTarget).addScaledVector(dir, this.sDistance)
    // keep the camera above the terrain under it
    if (this.elevationAt) {
      const radial = this.camera.position.clone().normalize()
      const minR = 1 + Math.max(0, this.elevationAt(radial)) + 0.012
      if (this.camera.position.length() < minR) this.camera.position.setLength(minR)
    }
    this.camera.up.copy(up)
    this.camera.lookAt(this.sTarget)
  }
}
