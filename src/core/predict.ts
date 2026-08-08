/**
 * Forward prediction, to hide the tracking pipeline's latency.
 *
 * By the time a head position reaches the screen it has been through camera
 * exposure, USB transfer, a video frame callback, ~10–20ms of neural network,
 * a smoothing filter that lags by design, then a render and a display refresh.
 * That total is typically 60–100ms, and the illusion is unusually sensitive to
 * it: the whole point is that the scene should feel welded to the room, and
 * lag makes it feel like it is being dragged along behind your head.
 *
 * The fix used in fish-tank VR is to extrapolate forward by roughly the
 * measured latency. The literature is consistent that this is worth doing but
 * only over short horizons — prediction over more than a couple of hundred
 * milliseconds overshoots visibly on direction changes, which reads worse than
 * the lag it removes. Hence the clamp.
 */

export interface PredictorOptions {
  /** Low-pass cutoff for the velocity estimate, in Hz. */
  velocityCutoffHz?: number
  /** Largest offset prediction may add, in metres. */
  maxOffsetM?: number
}

export class VelocityPredictor {
  private readonly velocityCutoffHz: number
  private readonly maxOffsetM: number

  private lastTime: number | null = null
  private last = { x: 0, y: 0, z: 0 }
  private velocity = { x: 0, y: 0, z: 0 }

  constructor({ velocityCutoffHz = 6, maxOffsetM = 0.07 }: PredictorOptions = {}) {
    this.velocityCutoffHz = velocityCutoffHz
    this.maxOffsetM = maxOffsetM
  }

  reset(): void {
    this.lastTime = null
    this.velocity = { x: 0, y: 0, z: 0 }
  }

  /** @param t seconds */
  update(x: number, y: number, z: number, t: number): void {
    if (this.lastTime === null) {
      this.lastTime = t
      this.last = { x, y, z }
      return
    }

    const dt = t - this.lastTime
    // Ignore duplicate or out-of-order samples; a zero dt would divide to
    // infinity and fling the scene off-screen for a frame.
    if (!(dt > 1e-4)) return
    this.lastTime = t

    const alpha = smoothingAlpha(dt, this.velocityCutoffHz)
    this.velocity.x += alpha * ((x - this.last.x) / dt - this.velocity.x)
    this.velocity.y += alpha * ((y - this.last.y) / dt - this.velocity.y)
    this.velocity.z += alpha * ((z - this.last.z) / dt - this.velocity.z)
    this.last = { x, y, z }
  }

  /**
   * Extrapolates a position forward.
   *
   * @param leadSeconds how far ahead to predict; 0 disables prediction.
   */
  predict(
    position: { x: number; y: number; z: number },
    leadSeconds: number,
  ): { x: number; y: number; z: number } {
    if (!(leadSeconds > 0) || this.lastTime === null) return position

    const clampOffset = (v: number): number => {
      const offset = v * leadSeconds
      return offset > this.maxOffsetM
        ? this.maxOffsetM
        : offset < -this.maxOffsetM
          ? -this.maxOffsetM
          : offset
    }

    return {
      x: position.x + clampOffset(this.velocity.x),
      y: position.y + clampOffset(this.velocity.y),
      z: position.z + clampOffset(this.velocity.z),
    }
  }

  /** Current speed estimate in m/s, for the debug overlay. */
  get speed(): number {
    return Math.hypot(this.velocity.x, this.velocity.y, this.velocity.z)
  }
}

function smoothingAlpha(dt: number, cutoffHz: number): number {
  const tau = 1 / (2 * Math.PI * cutoffHz)
  return 1 / (1 + tau / dt)
}
