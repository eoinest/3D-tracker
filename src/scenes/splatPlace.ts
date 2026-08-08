import { Euler, Group, MathUtils, Matrix4, Quaternion, Vector3 } from 'three'
import type { SplatMesh } from '@sparkjsdev/spark'

import { ensureSparkRenderer } from '../core/splatRuntime'
import { createWindowReveal } from './reveal'
import { disposeObject } from './shared'
import type { SceneContext, SceneDefinition, SceneInstance } from './types'

/**
 * A real place, captured as a 3D Gaussian splat, framed by the window.
 *
 * Splats are the right representation here in a way that meshes and panoramas
 * are not. A 360° photo has no parallax at all — every pixel sits at infinity,
 * so leaning does nothing and the illusion dies on contact. A photogrammetry
 * mesh has depth but bakes away the view-dependent shading that makes a real
 * place look real. A splat keeps both.
 *
 * Spark computes each splat's screen footprint from `projectionMatrix[0][0]`
 * and `[1][1]`, so the off-axis shear in `offAxis.ts` — which lives in the
 * matrix's third column — passes straight through with no special handling.
 */

export interface SplatPlacement {
  /** Extra scale on top of auto-framing. */
  scale: number
  yawDeg: number
  pitchDeg: number
  rollDeg: number
  offsetXM: number
  offsetYM: number
  offsetZM: number
}

export interface SplatPlaceMeta {
  id: string
  name: string
  description: string
  url: string
  /** Shown in the panel. These captures are other people's work. */
  credit: string
  creditUrl?: string
  badge?: string
  /** Approximate download size, surfaced before the user commits to it. */
  sizeMB?: number
  placement: SplatPlacement
}

export const NEUTRAL_PLACEMENT: SplatPlacement = {
  scale: 1,
  yawDeg: 0,
  pitchDeg: 0,
  rollDeg: 0,
  offsetXM: 0,
  offsetYM: 0,
  offsetZM: 0,
}

/** How wide the framed capture should be, in metres. */
const TARGET_SPAN_M = 22
/** Eye height above the capture's floor, in metres. */
const STANDING_HEIGHT_M = 1.55

/**
 * 3DGS captures come out of COLMAP-style pipelines Y-down, so every one of
 * them arrives upside down. Spark's own examples fix this with
 * `quaternion.set(1, 0, 0, 0)` — a 180° turn about X — and so do we.
 */
const UPRIGHT_FLIP = new Quaternion().setFromEuler(new Euler(Math.PI, 0, 0))

export type SplatLoadState = 'loading' | 'ready' | 'error'

export interface SplatStatus {
  state: SplatLoadState
  /** 0–1 where the server reports a length, otherwise null. */
  progress: number | null
  error: string | null
  splatCount: number
  credit: string | null
  creditUrl: string | null
}

const IDLE_STATUS: SplatStatus = {
  state: 'ready',
  progress: null,
  error: null,
  splatCount: 0,
  credit: null,
  creditUrl: null,
}

/** Live status for whichever splat scene is currently mounted. */
export const splatStatus: { status: SplatStatus; onChange?: () => void } = {
  status: { ...IDLE_STATUS },
}

function notify(next: Partial<SplatStatus>): void {
  splatStatus.status = { ...splatStatus.status, ...next }
  splatStatus.onChange?.()
}

export function clearSplatStatus(): void {
  splatStatus.status = { ...IDLE_STATUS }
  splatStatus.onChange?.()
}

export function splatPlaceScene(meta: SplatPlaceMeta): SceneDefinition {
  return {
    id: meta.id,
    name: meta.name,
    description: meta.description,
    badge: meta.badge ?? 'Real place',
    kind: 'world',
    minFarM: 400,
    create: (ctx) => createSplatPlace(meta, ctx),
  }
}

interface AutoFrame {
  /** Point in capture space to pin at the window's vantage point. */
  anchor: Vector3
  /** Capture units to metres. */
  scale: number
}

function createSplatPlace(meta: SplatPlaceMeta, ctx: SceneContext): SceneInstance {
  const root = new Group()
  root.name = `place:${meta.id}`

  const pivot = new Group()
  pivot.name = 'splat-pivot'
  root.add(pivot)

  const reveal = createWindowReveal({ depthM: 0.085, color: 0xd8d2c6, sillColor: 0xb0a695 })
  reveal.layout(ctx)
  root.add(reveal.group)

  notify({
    state: 'loading',
    progress: null,
    error: null,
    splatCount: 0,
    credit: meta.credit,
    creditUrl: meta.creditUrl ?? null,
  })

  let disposed = false
  let frame: AutoFrame | null = null
  let context = ctx
  let splat: SplatMesh | null = null

  void (async () => {
    try {
      const spark = await ensureSparkRenderer()
      if (disposed) return

      const mesh = new spark.SplatMesh({
        url: meta.url,
        onProgress: (event) => {
          if (disposed) return
          notify({ progress: event.lengthComputable ? event.loaded / event.total : null })
        },
      })
      mesh.name = 'capture'
      // Hidden until framed, so the first frames aren't a faceful of giant
      // splats seen from inside the cloud.
      mesh.visible = false
      splat = mesh
      pivot.add(mesh)

      await mesh.initialized
      if (disposed) return

      frame = autoFrame(mesh)
      mesh.visible = true
      applyPlacement(pivot, meta.placement, frame, context)
      notify({ state: 'ready', progress: 1, splatCount: mesh.numSplats ?? 0 })
    } catch (err) {
      if (disposed) return
      console.error('[splat] load failed', err)
      notify({
        state: 'error',
        error: err instanceof Error ? err.message : 'Could not load that capture.',
      })
    }
  })()

  let lastSignature = ''

  return {
    root,
    // Splats carry their own baked lighting; the room IBL only washes them out.
    environmentIntensity: 0,
    resize(c) {
      context = c
      reveal.layout(c)
      if (frame) applyPlacement(pivot, meta.placement, frame, c)
    },
    update(_dt, _elapsed, c) {
      context = c
      reveal.setVisible(c.settings.showRoom)
      if (!frame) return
      const signature = placementSignature(c)
      if (signature !== lastSignature) {
        lastSignature = signature
        applyPlacement(pivot, meta.placement, frame, c)
      }
    },
    dispose() {
      disposed = true
      clearSplatStatus()
      if (splat) {
        pivot.remove(splat)
        splat.dispose()
      }
      disposeObject(root)
    },
  }
}

/**
 * Works out how to seat an arbitrary capture behind the window.
 *
 * Captures carry no agreed scale, up-axis, or origin — this one measured 916
 * units across with its origin off to one side, which put the default camera
 * position inside the point cloud. Rather than hand-tune five numbers per
 * scene (and have them all break the moment a URL is pasted), the framing is
 * derived from the capture's own geometry.
 */
function autoFrame(splat: SplatMesh): AutoFrame {
  const { center, size, floorY } = robustExtent(splat)

  // Horizontal diagonal rather than the bounding box's longest side: captures
  // often trail a thin tail of stray splats down one axis, and the diagonal is
  // far less sensitive to it.
  const spanXZ = Math.hypot(size.x, size.z)
  const scale = Number.isFinite(spanXZ) && spanXZ > 1e-4 ? TARGET_SPAN_M / spanXZ : 1

  if (!center.toArray().every(Number.isFinite)) {
    console.warn('[splat] capture has no usable extent; showing it unframed')
    return { anchor: new Vector3(), scale: 1 }
  }

  return {
    // Pin the capture's floor, at its horizontal centre, to a point a few
    // metres ahead of the window — as if standing at the near edge looking in.
    //
    // Anchoring the *centroid* to the viewpoint instead is tempting (it is
    // scale-invariant, and it works nicely for room-shaped captures shot from
    // the middle) but it drops you inside the terrain of a landscape. Since
    // captures give no clue which shape they are, this takes the version that
    // degrades more gracefully and leaves the rest to per-capture presets.
    anchor: new Vector3(center.x, floorY, center.z),
    scale,
  }
}

/**
 * Percentile bounds over a sample of splat centres.
 *
 * The true bounding box is nearly useless for framing: a handful of stray
 * splats behind the capture rig stretch it by an order of magnitude. Trimming
 * to the 3rd–97th percentile per axis describes where the scene actually is.
 */
function robustExtent(splat: SplatMesh): { center: Vector3; size: Vector3; floorY: number } {
  const total = splat.numSplats || 0
  const stride = Math.max(1, Math.floor(total / 6000))

  const xs: number[] = []
  const ys: number[] = []
  const zs: number[] = []
  // Measure in the upright frame, so "floor" means the floor.
  //
  // Non-finite centres have to be dropped rather than tolerated: a single NaN
  // makes `sort` misbehave, which poisons the percentiles, the extent, and
  // finally the scale — and a zero scale renders as a completely black window
  // with no error anywhere. Real captures do contain these.
  splat.forEachSplat((index, center) => {
    if (index % stride !== 0) return
    if (!Number.isFinite(center.x) || !Number.isFinite(center.y) || !Number.isFinite(center.z)) {
      return
    }
    xs.push(center.x)
    ys.push(-center.y)
    zs.push(-center.z)
  })

  if (xs.length === 0) {
    const box = splat.getBoundingBox(true)
    const size = box.getSize(new Vector3())
    const center = box.getCenter(new Vector3())
    return { center: new Vector3(center.x, -center.y, -center.z), size, floorY: -box.max.y }
  }

  const [x0, x1] = percentileRange(xs)
  const [y0, y1] = percentileRange(ys)
  const [z0, z1] = percentileRange(zs)

  return {
    center: new Vector3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2),
    size: new Vector3(x1 - x0, y1 - y0, z1 - z0),
    floorY: y0,
  }
}

function percentileRange(values: number[], low = 0.03, high = 0.97): [number, number] {
  values.sort((a, b) => a - b)
  const lo = values[Math.floor((values.length - 1) * low)]!
  const hi = values[Math.floor((values.length - 1) * high)]!
  return [lo, hi]
}

const scratchQuaternion = new Quaternion()
const scratchEuler = new Euler()
const scratchMatrix = new Matrix4()
const scratchAnchor = new Vector3()

/**
 * Places the capture so its floor, at its horizontal centre, lands at a
 * standing viewpoint a few metres in front of the window.
 */
function applyPlacement(
  pivot: Group,
  preset: SplatPlacement,
  frame: AutoFrame,
  ctx: SceneContext,
): void {
  const s = ctx.settings
  const scale = frame.scale * preset.scale * Math.max(0.01, s.splatScale)

  scratchEuler.set(
    MathUtils.degToRad(preset.pitchDeg + s.splatPitchDeg),
    MathUtils.degToRad(preset.yawDeg + s.splatYawDeg),
    MathUtils.degToRad(preset.rollDeg),
    'YXZ',
  )
  // User rotation, then the upright flip. The anchor was measured in the
  // upright frame, so only the user half applies when solving for position.
  scratchQuaternion.setFromEuler(scratchEuler)
  pivot.quaternion.copy(scratchQuaternion).multiply(UPRIGHT_FLIP)
  pivot.scale.setScalar(scale)

  // Depth walks the vantage point into the scene rather than resizing it.
  //
  // These captures are shells with a hard front boundary, and the band of good
  // viewpoints is narrow: on the valley, 8.4m frames the whole landscape and
  // 9.4m has you inside the mountain. Tuned by eye, and the reason Placement →
  // Distance exists.
  const distance = 3 + ctx.roomDepthM * 6 + s.splatDistanceM
  const desired = new Vector3(
    preset.offsetXM,
    -STANDING_HEIGHT_M + preset.offsetYM + s.splatHeightM,
    preset.offsetZM - distance,
  )

  // position = desired − R·S·anchor, so the anchor lands exactly on `desired`.
  scratchMatrix.compose(ZERO, scratchQuaternion, new Vector3(scale, scale, scale))
  scratchAnchor.copy(frame.anchor).applyMatrix4(scratchMatrix)
  pivot.position.copy(desired).sub(scratchAnchor)
}

const ZERO = new Vector3()

function placementSignature(ctx: SceneContext): string {
  const s = ctx.settings
  return [
    s.splatScale,
    s.splatYawDeg,
    s.splatPitchDeg,
    s.splatHeightM,
    s.splatDistanceM,
    ctx.roomDepthM,
  ].join('|')
}
