/**
 * Pinhole geometry for turning a pair of face landmarks into an eye position.
 *
 * Deliberately dependency-free: this is the arithmetic the whole illusion rests
 * on, and keeping it in a leaf module means it can be exercised directly by
 * `node --test` without a browser, a webcam, or a bundler.
 */

export interface PinholeOptions {
  videoWidth: number
  videoHeight: number
  /** Real-world separation of the two landmarks, in metres. */
  baselineM: number
  /** Camera focal length in pixels, divided by video width. */
  focalNorm: number
  /** True for a user-facing (mirrored) camera. */
  mirror: boolean
  /** Webcam position in display space, in metres. */
  cameraXM: number
  cameraYM: number
  cameraZM: number
}

export interface EyeEstimate {
  /** Eye midpoint in display space, in metres. */
  x: number
  y: number
  z: number
  /** Midpoint in normalised image coordinates. */
  u: number
  v: number
  separationPx: number
}

export interface Landmark {
  x: number
  y: number
  z?: number
}

/**
 * Back-projects a pair of landmarks of known real-world separation into a 3D
 * eye position, via the pinhole relation `z = baseline · focal / separation`.
 *
 * Sign errors hide in here, and a sign error inverts the parallax — which makes
 * the illusion feel subtly, unnameably wrong rather than visibly broken. Hence
 * the tests.
 */
export function eyeFromLandmarkPair(
  a: Landmark,
  b: Landmark,
  options: PinholeOptions,
): EyeEstimate | null {
  const { videoWidth: vw, videoHeight: vh, baselineM, focalNorm, mirror } = options
  if (!vw || !vh) return null

  // MediaPipe's z is on roughly the same scale as x, so multiply it by the
  // video *width* — not the height — to get comparable pixel units. Using the
  // 3D separation rather than the 2D one keeps the depth estimate stable when
  // you turn your head: the projected iris gap narrows under yaw, but the real
  // one does not, and a 2D estimate would read that as moving backwards.
  const dx = (a.x - b.x) * vw
  const dy = (a.y - b.y) * vh
  const dz = ((a.z ?? 0) - (b.z ?? 0)) * vw
  const separationPx = Math.hypot(dx, dy, dz)
  if (separationPx < 1) return null

  const focalPx = Math.max(1, focalNorm * vw)
  const u = (a.x + b.x) / 2
  const v = (a.y + b.y) / 2

  const zCam = (baselineM * focalPx) / separationPx
  const xCam = ((u - 0.5) * vw * zCam) / focalPx
  const yCam = ((v - 0.5) * vh * zCam) / focalPx

  return {
    // Image +x is the viewer's left for a user-facing camera, hence the flip.
    x: options.cameraXM + (mirror ? -xCam : xCam),
    // Image +y points down; display +y points up.
    y: options.cameraYM - yCam,
    z: options.cameraZM + zCam,
    u,
    v,
    separationPx,
  }
}
