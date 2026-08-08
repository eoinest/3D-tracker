/**
 * Deterministic value noise and fBm, for terrain and scatter placement.
 *
 * Deterministic matters more than it sounds: grass, flowers and trees are all
 * placed by sampling the *same* height field the terrain mesh was displaced
 * with, so anything stochastic has to give the same answer every call or props
 * end up floating above the ground or buried in it.
 */

export type Noise2D = (x: number, y: number) => number

function hash2(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 0x1f1f1f1f) ^ Math.imul(iy, 0x27d4eb2d) ^ seed
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
  h ^= h >>> 15
  return (h >>> 0) / 4294967295
}

/** Smooth value noise in [-1, 1]. */
export function valueNoise2D(seed: number): Noise2D {
  return (x, y) => {
    const x0 = Math.floor(x)
    const y0 = Math.floor(y)
    const fx = x - x0
    const fy = y - y0
    // Smoothstep the interpolant so the lattice doesn't show as a grid of
    // creases along the cell boundaries.
    const sx = fx * fx * (3 - 2 * fx)
    const sy = fy * fy * (3 - 2 * fy)

    const n00 = hash2(x0, y0, seed)
    const n10 = hash2(x0 + 1, y0, seed)
    const n01 = hash2(x0, y0 + 1, seed)
    const n11 = hash2(x0 + 1, y0 + 1, seed)

    const a = n00 + (n10 - n00) * sx
    const b = n01 + (n11 - n01) * sx
    return (a + (b - a) * sy) * 2 - 1
  }
}

export interface FbmOptions {
  octaves?: number
  frequency?: number
  lacunarity?: number
  gain?: number
}

/** Fractal Brownian motion over value noise, normalised to roughly [-1, 1]. */
export function fbm2D(seed: number, options: FbmOptions = {}): Noise2D {
  const { octaves = 4, frequency = 1, lacunarity = 2.03, gain = 0.5 } = options
  const layers = Array.from({ length: octaves }, (_, i) => valueNoise2D(seed + i * 7919))

  let total = 0
  let amplitude = 1
  for (let i = 0; i < octaves; i++) {
    total += amplitude
    amplitude *= gain
  }
  const normalise = 1 / total

  return (x, y) => {
    let sum = 0
    let amp = 1
    let freq = frequency
    for (let i = 0; i < octaves; i++) {
      sum += layers[i]!(x * freq, y * freq) * amp
      amp *= gain
      // Offsetting each octave keeps their lattices from lining up at the
      // origin, which otherwise leaves a visible seam through the middle.
      freq *= lacunarity
    }
    return sum * normalise
  }
}

/** Sampler for a seeded, repeatable sequence of random numbers in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
