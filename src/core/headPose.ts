/**
 * Head position from MediaPipe's facial transformation matrix.
 *
 * This is the better of the two estimators in the app, and it is worth knowing
 * why. `pinhole.ts` back-projects a single pair of iris landmarks: two points
 * out of 478, so every pixel of landmark noise lands directly on the output,
 * and a blink or a glance to the side moves them. The transformation matrix is
 * a rigid Procrustes fit of the *whole* canonical face mesh to the detected
 * one, so hundreds of landmarks vote on a single 6-DoF pose and the noise
 * largely cancels. It is also yaw-invariant by construction rather than by the
 * 3D-separation trick pinhole.ts has to use.
 *
 * The catch: MediaPipe estimates that pose against an undocumented virtual
 * camera whose field of view almost certainly isn't your webcam's, so the
 * result is a similarity transform away from the truth — right direction,
 * wrong scale. Conveniently that is a *single* unknown scalar, and the app
 * already has a calibration flow that solves for exactly one scalar. So the
 * matrix supplies the geometry and the calibration supplies the units.
 *
 * Dependency-free so it can be tested without a browser or a webcam.
 */

export interface HeadPoseOptions {
  /**
   * Scales MediaPipe's virtual-camera centimetres to real metres. 0.01 would
   * be correct if its assumed FOV matched the real camera exactly.
   */
  metersPerUnit: number
  /** True for a user-facing (mirrored) camera. */
  mirror: boolean
  /** Webcam position in display space, in metres. */
  cameraXM: number
  cameraYM: number
  cameraZM: number
}

export interface HeadPose {
  /** Head centre in display space, in metres. */
  x: number
  y: number
  z: number
  /** Head orientation, in radians. Not used for projection — useful for debug. */
  yaw: number
  pitch: number
  roll: number
}

/**
 * @param matrix 4×4 column-major, as MediaPipe returns it in `Matrix.data`.
 */
export function headPoseFromMatrix(
  matrix: readonly number[],
  options: HeadPoseOptions,
): HeadPose | null {
  if (matrix.length < 16) return null

  // Column-major: the translation is the last column, elements 12..14.
  const tx = matrix[12]!
  const ty = matrix[13]!
  const tz = matrix[14]!
  if (!Number.isFinite(tx) || !Number.isFinite(ty) || !Number.isFinite(tz)) return null

  const k = options.metersPerUnit
  // MediaPipe's virtual camera sits at the origin looking down −Z, so a face in
  // front of it has negative tz. Distance is the magnitude.
  const distance = Math.abs(tz) * k
  if (!(distance > 0.01)) return null

  const xCam = tx * k
  const yCam = ty * k

  return {
    // Image-space +x is the viewer's left for a user-facing camera.
    x: options.cameraXM + (options.mirror ? -xCam : xCam),
    y: options.cameraYM + yCam,
    z: options.cameraZM + distance,
    ...eulerFromMatrix(matrix),
  }
}

/** YXZ Euler angles from the rotation part of a column-major 4×4. */
function eulerFromMatrix(m: readonly number[]): { yaw: number; pitch: number; roll: number } {
  // Column-major indices: m[col * 4 + row].
  const m11 = m[0]!
  const m31 = m[2]!
  const m32 = m[6]!
  const m33 = m[10]!
  const m12 = m[4]!
  const m13 = m[8]!

  const pitch = Math.asin(clamp(-m32, -1, 1))
  const cosPitch = Math.cos(pitch)
  if (Math.abs(cosPitch) > 1e-6) {
    return {
      pitch,
      yaw: Math.atan2(m31, m33),
      roll: Math.atan2(m12, m11),
    }
  }
  return { pitch, yaw: Math.atan2(-m13, m11), roll: 0 }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * Solves for `metersPerUnit` from a known viewing distance.
 *
 * Same idea as the pinhole calibration: sit at a distance you can measure and
 * let one multiplication absorb every unknown in MediaPipe's camera model.
 */
export function calibrateMetersPerUnit(
  matrix: readonly number[],
  trueDistanceM: number,
): number | null {
  if (matrix.length < 16 || !(trueDistanceM > 0)) return null
  const tz = Math.abs(matrix[14]!)
  if (!Number.isFinite(tz) || tz < 1e-6) return null
  return trueDistanceM / tz
}
