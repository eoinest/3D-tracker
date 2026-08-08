/**
 * 1€ filter (Casiez, Roussel, Vogel — CHI 2012).
 *
 * Head tracking has the classic jitter-vs-lag tradeoff: a fixed low-pass filter
 * that kills the shimmer when you sit still also smears the geometry when you
 * lunge sideways, which is exactly when the parallax illusion needs to be
 * crisp. The 1€ filter adapts its cutoff to speed — heavy smoothing when slow,
 * almost none when fast.
 */

class LowPass {
  private y: number | null = null
  private s = 0

  filter(value: number, alpha: number): number {
    this.s = this.y === null ? value : alpha * value + (1 - alpha) * this.s
    this.y = value
    return this.s
  }

  get hasValue(): boolean {
    return this.y !== null
  }

  get last(): number {
    return this.s
  }

  reset(): void {
    this.y = null
    this.s = 0
  }
}

export interface OneEuroOptions {
  /** Cutoff frequency (Hz) at zero speed. Lower = smoother when still. */
  minCutoff?: number
  /** Speed coefficient. Higher = more responsive to fast motion. */
  beta?: number
  /** Cutoff for the derivative estimate. */
  dCutoff?: number
}

export class OneEuroFilter {
  minCutoff: number
  beta: number
  dCutoff: number

  private xFilter = new LowPass()
  private dxFilter = new LowPass()
  private lastTime: number | null = null

  constructor({ minCutoff = 1.0, beta = 0.02, dCutoff = 1.0 }: OneEuroOptions = {}) {
    this.minCutoff = minCutoff
    this.beta = beta
    this.dCutoff = dCutoff
  }

  reset(): void {
    this.xFilter.reset()
    this.dxFilter.reset()
    this.lastTime = null
  }

  /** @param t timestamp in seconds */
  filter(value: number, t: number): number {
    if (!Number.isFinite(value)) return this.xFilter.last

    let dt = this.lastTime === null ? 1 / 60 : t - this.lastTime
    if (!(dt > 0) || dt > 1) dt = 1 / 60
    this.lastTime = t

    const prev = this.xFilter.hasValue ? this.xFilter.last : value
    const dx = (value - prev) / dt
    const edx = this.dxFilter.filter(dx, alpha(dt, this.dCutoff))

    const cutoff = this.minCutoff + this.beta * Math.abs(edx)
    return this.xFilter.filter(value, alpha(dt, cutoff))
  }
}

function alpha(dt: number, cutoff: number): number {
  const tau = 1 / (2 * Math.PI * cutoff)
  return 1 / (1 + tau / dt)
}

/** Three independent 1€ filters, for filtering a position. */
export class OneEuroVec3 {
  private fx: OneEuroFilter
  private fy: OneEuroFilter
  private fz: OneEuroFilter

  constructor(opts: OneEuroOptions = {}) {
    this.fx = new OneEuroFilter(opts)
    this.fy = new OneEuroFilter(opts)
    this.fz = new OneEuroFilter(opts)
  }

  configure(opts: Required<OneEuroOptions>): void {
    for (const f of [this.fx, this.fy, this.fz]) {
      f.minCutoff = opts.minCutoff
      f.beta = opts.beta
      f.dCutoff = opts.dCutoff
    }
  }

  reset(): void {
    this.fx.reset()
    this.fy.reset()
    this.fz.reset()
  }

  filter(x: number, y: number, z: number, t: number): [number, number, number] {
    return [this.fx.filter(x, t), this.fy.filter(y, t), this.fz.filter(z, t)]
  }
}
