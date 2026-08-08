import { Matrix4, type PerspectiveCamera, type Vector3Like } from 'three'

/**
 * Off-axis ("generalised") perspective projection — the whole trick.
 *
 * A normal camera has a symmetric frustum glued to the camera's own axis, so
 * moving your head does nothing and rotating the camera swings the whole world.
 * Here the frustum is pinned to a *fixed rectangle in the world* (the screen)
 * and sheared to meet the eye wherever the eye happens to be. The screen stops
 * behaving like a picture of a scene and starts behaving like a hole in a wall.
 *
 * See Kooima, "Generalized Perspective Projection" (2008). We only need the
 * axis-aligned case: the screen lies in z = 0 with +X right and +Y up, so the
 * orthonormal screen basis is the identity and the whole derivation collapses
 * to an asymmetric frustum plus a translation.
 */

export interface WindowRect {
  /** Width of the projection window in metres. */
  widthM: number
  heightM: number
  /** Offset of the window's centre from the display origin, in metres. */
  centerXM: number
  centerYM: number
}

const MIN_EYE_DISTANCE = 0.05

const scratch = new Matrix4()

export function offAxisProjection(
  eye: Vector3Like,
  win: WindowRect,
  near: number,
  far: number,
  target: Matrix4 = scratch,
): Matrix4 {
  // Eye position relative to the centre of the projection window.
  const ex = eye.x - win.centerXM
  const ey = eye.y - win.centerYM
  const ez = Math.max(MIN_EYE_DISTANCE, eye.z)

  // Distance from eye to the screen plane, scaled onto the near plane.
  const k = near / ez
  const halfW = win.widthM / 2
  const halfH = win.heightM / 2

  const left = (-halfW - ex) * k
  const right = (halfW - ex) * k
  const bottom = (-halfH - ey) * k
  const top = (halfH - ey) * k

  return target.makePerspective(left, right, top, bottom, near, far)
}

/**
 * Point a camera at the world through `win` from `eye`.
 *
 * The camera keeps identity orientation for all time — head movement is pure
 * translation plus frustum shear. Rotating it here is the single most common
 * way to break the illusion, because a rotation makes the screen's edges stop
 * lining up with the window's edges.
 */
export function applyOffAxisCamera(
  camera: PerspectiveCamera,
  eye: Vector3Like,
  win: WindowRect,
  near: number,
  far: number,
): void {
  camera.position.set(eye.x, eye.y, Math.max(MIN_EYE_DISTANCE, eye.z))
  camera.quaternion.identity()
  camera.up.set(0, 1, 0)
  camera.updateMatrix()
  camera.updateMatrixWorld(true)

  offAxisProjection(eye, win, near, far, camera.projectionMatrix)
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert()

  // Keep the descriptive fields honest so anything reading them (helpers,
  // shaders that want fov, debug UI) sees the frustum we actually rendered.
  const ez = Math.max(MIN_EYE_DISTANCE, eye.z)
  camera.near = near
  camera.far = far
  camera.aspect = win.widthM / win.heightM
  camera.fov = 2 * Math.atan(win.heightM / 2 / ez) * (180 / Math.PI)
}
