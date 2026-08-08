import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  InstancedMesh,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Vector3,
} from 'three'
import { Sky } from 'three/addons/objects/Sky.js'

import { fbm2D, rng, type Noise2D } from './noise'

/**
 * Shared building blocks for the outdoor "window onto somewhere else" scenes.
 *
 * These scenes are rendered at *true scale* — grass is centimetres, hills are
 * hundreds of metres, and the aperture is a 30cm hole a half-metre from your
 * eye. That is the whole reason they work: a miniature diorama reads as a
 * model, whereas real-world proportions read as a place. It also means the
 * parallax budget is spent almost entirely on near geometry, which is why the
 * window reveal and the foreground grass matter far more than the mountains.
 */

// ── Sky ──────────────────────────────────────────────────────────────────────

export interface SkyOptions {
  /** Sun elevation above the horizon, in degrees. */
  elevationDeg?: number
  /** Sun compass bearing, in degrees. 0 puts it straight ahead of the window. */
  azimuthDeg?: number
  turbidity?: number
  rayleigh?: number
  mieCoefficient?: number
  mieDirectionalG?: number
  cloudCoverage?: number
  cloudDensity?: number
  cloudSpeed?: number
  cloudScale?: number
}

export interface SkyDome {
  object: Object3D
  /** Unit vector from the origin toward the sun. */
  sunDirection: Vector3
  update(elapsed: number): void
  dispose(): void
}

export function createSkyDome(options: SkyOptions = {}): SkyDome {
  const {
    elevationDeg = 22,
    azimuthDeg = 25,
    turbidity = 4,
    rayleigh = 2.1,
    mieCoefficient = 0.005,
    mieDirectionalG = 0.8,
    cloudCoverage = 0.45,
    cloudDensity = 0.5,
    cloudSpeed = 0.00006,
    cloudScale = 0.00022,
  } = options

  const sky = new Sky()
  // Depth-testing is switched off and the dome is drawn first, so it acts as a
  // pure background. That decouples its size from the far plane entirely —
  // otherwise the dome has to be bigger than the furthest terrain but still
  // inside the frustum, which is a fight not worth having.
  sky.material.depthTest = false
  sky.material.depthWrite = false
  sky.renderOrder = -1000
  sky.frustumCulled = false
  sky.scale.setScalar(200)

  const uniforms = sky.material.uniforms
  uniforms['turbidity']!.value = turbidity
  uniforms['rayleigh']!.value = rayleigh
  uniforms['mieCoefficient']!.value = mieCoefficient
  uniforms['mieDirectionalG']!.value = mieDirectionalG
  uniforms['cloudCoverage']!.value = cloudCoverage
  uniforms['cloudDensity']!.value = cloudDensity
  uniforms['cloudSpeed']!.value = cloudSpeed
  uniforms['cloudScale']!.value = cloudScale

  // The window looks down −Z, so put the sun in that half-space by default.
  const phi = (90 - elevationDeg) * (Math.PI / 180)
  const theta = (azimuthDeg - 90) * (Math.PI / 180)
  const sunDirection = new Vector3().setFromSphericalCoords(1, phi, theta)
  uniforms['sunPosition']!.value.copy(sunDirection)

  return {
    object: sky,
    sunDirection,
    update(elapsed) {
      uniforms['time']!.value = elapsed
    },
    dispose() {
      sky.geometry.dispose()
      sky.material.dispose()
    },
  }
}

// ── Ground ───────────────────────────────────────────────────────────────────

export interface GroundOptions {
  /** Where the fine detail starts. Nothing inside this is ever in frame. */
  innerRadiusM?: number
  outerRadiusM?: number
  rings?: number
  segments?: number
  /** Terrain height in metres at a world position. */
  heightAt: Noise2D
  /** Vertex colour at a world position, given the local height and slope. */
  colorAt: (x: number, z: number, height: number, slope: number, target: Color) => void
  roughness?: number
}

export interface Ground {
  mesh: Mesh
  heightAt: Noise2D
}

/**
 * A radial ground mesh: concentric rings whose spacing grows geometrically.
 *
 * A uniform grid can't win here. Fine enough for the grass three metres out and
 * it needs millions of vertices to reach the horizon; coarse enough to reach
 * the horizon cheaply and the near ground is visibly faceted. Because the
 * viewer is pinned to one spot — the window — a polar layout centred on that
 * spot gives detail exactly where it is needed and nowhere else.
 */
export interface RadialGridOptions {
  innerRadiusM?: number
  outerRadiusM?: number
  rings?: number
  segments?: number
}

/**
 * A flat radial grid centred on the origin, rings spaced geometrically.
 *
 * Shared by the ground and the water because both are horizontal sheets viewed
 * from one fixed spot, which is exactly the case a polar layout is built for.
 */
export function createRadialGrid(options: RadialGridOptions = {}): BufferGeometry {
  const { innerRadiusM = 1.2, outerRadiusM = 340, rings = 72, segments = 128 } = options

  const growth = (outerRadiusM / innerRadiusM) ** (1 / rings)
  const radii: number[] = [0]
  for (let i = 0; i <= rings; i++) radii.push(innerRadiusM * growth ** i)

  const rowCount = radii.length
  const colCount = segments + 1
  const positions = new Float32Array(rowCount * colCount * 3)
  const normals = new Float32Array(rowCount * colCount * 3)

  for (let r = 0; r < rowCount; r++) {
    const radius = radii[r]!
    for (let c = 0; c < colCount; c++) {
      const angle = (c / segments) * Math.PI * 2
      const i = (r * colCount + c) * 3
      positions[i] = Math.cos(angle) * radius
      positions[i + 1] = 0
      positions[i + 2] = Math.sin(angle) * radius
      normals[i + 1] = 1
    }
  }

  const indices: number[] = []
  for (let r = 0; r < rowCount - 1; r++) {
    for (let c = 0; c < segments; c++) {
      const a = r * colCount + c
      const b = a + 1
      const d = (r + 1) * colCount + c
      const e = d + 1
      // Counter-clockwise seen from above, so the front faces point at the
      // sky. Get this backwards and the sheet is silently backface-culled
      // into a thin sliver near the horizon.
      indices.push(a, b, d, b, e, d)
    }
  }

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new BufferAttribute(normals, 3))
  geometry.setIndex(indices)
  geometry.computeBoundingSphere()
  return geometry
}

export function createGround(options: GroundOptions): Ground {
  const {
    innerRadiusM = 1.2,
    outerRadiusM = 340,
    rings = 72,
    segments = 128,
    heightAt,
    colorAt,
    roughness = 1,
  } = options

  const geometry = createRadialGrid({ innerRadiusM, outerRadiusM, rings, segments })
  const positionAttr = geometry.getAttribute('position') as BufferAttribute
  const normalAttr = geometry.getAttribute('normal') as BufferAttribute
  const positions = positionAttr.array as Float32Array
  const normals = normalAttr.array as Float32Array
  const vertexCount = positionAttr.count
  const colors = new Float32Array(vertexCount * 3)

  const color = new Color()
  // Sample the height field a short distance out to get a slope, so steep
  // faces can be tinted differently (rock, dirt) from flat ground.
  const slopeStep = 0.6

  // Displace the flat grid in place, deriving normals by finite difference of
  // the same height field the props are placed against.
  for (let v = 0; v < vertexCount; v++) {
    const i = v * 3
    const x = positions[i]!
    const z = positions[i + 2]!
    const y = heightAt(x, z)

    const dx = heightAt(x + slopeStep, z) - heightAt(x - slopeStep, z)
    const dz = heightAt(x, z + slopeStep) - heightAt(x, z - slopeStep)
    const nx = -dx
    const nz = -dz
    const ny = 2 * slopeStep
    const inv = 1 / Math.hypot(nx, ny, nz)
    const slope = 1 - ny * inv

    positions[i + 1] = y
    normals[i] = nx * inv
    normals[i + 1] = ny * inv
    normals[i + 2] = nz * inv

    colorAt(x, z, y, slope, color)
    colors[i] = color.r
    colors[i + 1] = color.g
    colors[i + 2] = color.b
  }

  positionAttr.needsUpdate = true
  normalAttr.needsUpdate = true
  geometry.setAttribute('color', new BufferAttribute(colors, 3))
  geometry.computeBoundingSphere()

  const mesh = new Mesh(
    geometry,
    new MeshStandardMaterial({ vertexColors: true, roughness, metalness: 0 }),
  )
  mesh.name = 'ground'
  mesh.receiveShadow = true
  mesh.frustumCulled = false

  return { mesh, heightAt }
}

/** Convenience: an fBm height field with a broad swell plus finer detail. */
export function rollingHeightField(seed: number, options: {
  amplitudeM?: number
  scaleM?: number
  detail?: number
  /** Terrain starts flattening at this radius… */
  taperFromM?: number
  /** …and is perfectly flat beyond this one. */
  taperToM?: number
} = {}): Noise2D {
  const { amplitudeM = 9, scaleM = 190, detail = 5, taperFromM = 190, taperToM = 330 } = options
  const base = fbm2D(seed, { octaves: detail, frequency: 1 / scaleM })
  const ripple = fbm2D(seed + 4001, { octaves: 3, frequency: 1 / 9 })

  const raw = (x: number, z: number): number => base(x, z) * amplitudeM + ripple(x, z) * 0.13

  // Anchor the field to zero directly beneath the window. Without this the
  // ground sits at whatever the noise happens to return at the origin, which
  // can be metres above the viewer's eye — the scene ends up underground.
  const originHeight = raw(0, 0)

  return (x, z) => {
    // Flatten toward the rim so the far edge of the disc meets the horizon in
    // a clean line. A ragged edge out there reads as a hole in the world,
    // because the sky model is undefined below the horizon and renders flat.
    const radius = Math.hypot(x, z)
    const taper =
      radius <= taperFromM
        ? 1
        : radius >= taperToM
          ? 0
          : 1 - smoothstep((radius - taperFromM) / (taperToM - taperFromM))
    return (raw(x, z) - originHeight) * taper
  }
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t)
}

// ── Scatter ──────────────────────────────────────────────────────────────────

export interface ScatterOptions {
  count: number
  seed: number
  minRadiusM: number
  maxRadiusM: number
  /**
   * How radius is sampled.
   *
   * `area` spreads instances evenly over the annulus — correct for anything
   * whose real-world density is uniform, like a distant treeline.
   *
   * `log` puts an equal count in every octave of distance, which is what you
   * want for ground cover. Uniform-by-area sounds right but isn't: a disc 48m
   * across is 7000m², so an affordable instance budget spread evenly over it
   * leaves single blades metres apart in the foreground, where they are most
   * visible. Log sampling puts roughly half the budget inside 8m.
   */
  distribution?: 'area' | 'log'
  /** Radial bias for `area` sampling. Below 1 crowds instances inward. */
  areaBias?: number
  heightAt: Noise2D
  /** Return false to reject a candidate position. */
  accept?: (x: number, z: number, height: number) => boolean
  place(dummy: Object3D, x: number, y: number, z: number, random: () => number): void
  colorAt?: (x: number, z: number, random: () => number, target: Color) => void
}

/**
 * Places instances on a height field inside an annulus around the window.
 *
 * The annulus, rather than a disc, is deliberate: the ground directly beneath
 * the window is below the aperture's bottom edge and can never be seen, so
 * anything placed there is pure cost.
 */
export function scatter(
  geometry: BufferGeometry,
  material: MeshStandardMaterial,
  options: ScatterOptions,
): InstancedMesh {
  const {
    count,
    seed,
    minRadiusM,
    maxRadiusM,
    distribution = 'area',
    areaBias = 0.62,
    heightAt,
    accept,
    place,
    colorAt,
  } = options
  const radiusRatio = maxRadiusM / Math.max(0.01, minRadiusM)

  const random = rng(seed)
  const dummy = new Object3D()
  const color = new Color()
  const mesh = new InstancedMesh(geometry, material, count)
  mesh.frustumCulled = false
  mesh.instanceMatrix.setUsage(DynamicDrawUsage)

  let placed = 0
  let attempts = 0
  const maxAttempts = count * 12

  while (placed < count && attempts < maxAttempts) {
    attempts++
    const angle = random() * Math.PI * 2
    const u = random()
    const radius =
      distribution === 'log'
        ? minRadiusM * radiusRatio ** u
        : // Raising the uniform sample to a power biases density radially; the
          // square root would be uniform-by-area.
          minRadiusM + (maxRadiusM - minRadiusM) * u ** areaBias
    const x = Math.cos(angle) * radius
    const z = Math.sin(angle) * radius
    const y = heightAt(x, z)
    if (accept && !accept(x, z, y)) continue

    dummy.position.set(x, y, z)
    dummy.rotation.set(0, 0, 0)
    dummy.scale.setScalar(1)
    place(dummy, x, y, z, random)
    dummy.updateMatrix()
    mesh.setMatrixAt(placed, dummy.matrix)

    if (colorAt) {
      colorAt(x, z, random, color)
      mesh.setColorAt(placed, color)
    }
    placed++
  }

  mesh.count = placed
  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  return mesh
}

// ── Grass ────────────────────────────────────────────────────────────────────

export interface GrassOptions {
  count?: number
  seed?: number
  minRadiusM?: number
  maxRadiusM?: number
  heightAt: Noise2D
  /** Blade height range, in metres. */
  bladeHeightM?: [number, number]
  bladeWidthM?: number
  /** Base and tip colours; each blade lerps between them plus jitter. */
  baseColor?: number
  tipColor?: number
  windStrength?: number
  windSpeed?: number
  accept?: (x: number, z: number, height: number) => boolean
}

export interface GrassField {
  mesh: InstancedMesh
  update(elapsed: number): void
  dispose(): void
}

const BLADE_SEGMENTS = 4

/** A tapered blade, upright along +Y, with a 0→1 height attribute per vertex. */
function bladeGeometry(width: number, height: number, baseColor: Color, tipColor: Color): BufferGeometry {
  const positions: number[] = []
  const normals: number[] = []
  const colors: number[] = []
  const heights: number[] = []
  const indices: number[] = []

  const color = new Color()
  for (let i = 0; i <= BLADE_SEGMENTS; i++) {
    const t = i / BLADE_SEGMENTS
    const y = t * height
    // Taper to a point, with the widest part slightly above the base so the
    // blade reads as a leaf rather than a triangle.
    const w = width * (1 - t ** 1.6) * (0.65 + 0.35 * Math.min(1, t * 4))
    color.copy(baseColor).lerp(tipColor, t)

    for (const side of [-1, 1]) {
      positions.push((w / 2) * side, y, 0)
      normals.push(0, 0, 1)
      colors.push(color.r, color.g, color.b)
      heights.push(t)
    }
  }

  for (let i = 0; i < BLADE_SEGMENTS; i++) {
    const a = i * 2
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
  }

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3))
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3))
  geometry.setAttribute('aHeight', new BufferAttribute(new Float32Array(heights), 1))
  geometry.setIndex(indices)
  geometry.computeBoundingSphere()
  return geometry
}

export function createGrassField(options: GrassOptions): GrassField {
  const {
    count = 46000,
    seed = 0x6a55,
    minRadiusM = 1.4,
    maxRadiusM = 46,
    heightAt,
    bladeHeightM = [0.26, 0.62],
    bladeWidthM = 0.021,
    baseColor = 0x2f4f1d,
    tipColor = 0x8fb256,
    windStrength = 0.34,
    windSpeed = 1.05,
    accept,
  } = options

  const geometry = bladeGeometry(bladeWidthM, 1, new Color(baseColor), new Color(tipColor))

  const uniforms = {
    uTime: { value: 0 },
    uWind: { value: windStrength },
    uWindSpeed: { value: windSpeed },
  }

  const material = new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.92,
    metalness: 0,
    // Blades are one-sided strips; without DoubleSide, half the field is
    // invisible from any given angle.
    side: DoubleSide,
  })

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute float aHeight;
         uniform float uTime;
         uniform float uWind;
         uniform float uWindSpeed;`,
      )
      // The sway is applied *after* the instance matrix, so every blade bends
      // along the same world-space wind direction. Applying it in blade-local
      // space instead would rotate the wind with each blade's random yaw, and
      // the field would shimmer incoherently rather than move in gusts.
      .replace(
        '#include <project_vertex>',
        `vec4 mvPosition = vec4( transformed, 1.0 );
         #ifdef USE_INSTANCING
           mvPosition = instanceMatrix * mvPosition;
           vec3 bladeOrigin = instanceMatrix[3].xyz;
         #else
           vec3 bladeOrigin = vec3( 0.0 );
         #endif
         float phase = bladeOrigin.x * 0.32 + bladeOrigin.z * 0.24;
         float gust =
             sin( uTime * uWindSpeed + phase )
           + 0.42 * sin( uTime * uWindSpeed * 2.31 + phase * 1.7 )
           + 0.20 * sin( uTime * uWindSpeed * 0.47 + phase * 0.6 );
         // Cubic falloff pins the base and lets the tip travel.
         float bend = aHeight * aHeight * aHeight;
         mvPosition.x += gust * bend * uWind;
         mvPosition.z += gust * bend * uWind * 0.42;
         mvPosition = modelViewMatrix * mvPosition;
         gl_Position = projectionMatrix * mvPosition;`,
      )
  }
  // Distinguish this program from any other MeshStandardMaterial in the scene,
  // so three doesn't hand us a cached shader compiled without the wind.
  material.customProgramCacheKey = () => 'grass-wind'

  const [minHeight, maxHeight] = bladeHeightM
  const tint = new Color()

  const mesh = scatter(geometry, material, {
    count,
    seed,
    minRadiusM,
    maxRadiusM,
    distribution: 'log',
    heightAt,
    accept,
    place(dummy, _x, _y, _z, random) {
      const height = minHeight + random() * (maxHeight - minHeight)
      dummy.rotation.y = random() * Math.PI * 2
      // A slight lean stops the field looking like a bed of nails.
      dummy.rotation.z = (random() - 0.5) * 0.35
      dummy.scale.set(0.8 + random() * 0.5, height, 1)
    },
    colorAt(_x, _z, random, target) {
      const shade = 0.72 + random() * 0.52
      target.copy(tint.setRGB(shade, shade * (0.94 + random() * 0.12), shade * 0.86))
    },
  })
  mesh.name = 'grass'
  mesh.castShadow = false
  mesh.receiveShadow = false

  return {
    mesh,
    update(elapsed) {
      uniforms.uTime.value = elapsed
    },
    dispose() {
      geometry.dispose()
      material.dispose()
    },
  }
}
