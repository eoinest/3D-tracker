import {
  Color,
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  ShaderMaterial,
  SphereGeometry,
  UniformsLib,
  UniformsUtils,
  Vector3,
} from 'three'

import { fbm2D } from './noise'
import {
  createGround,
  createRadialGrid,
  createSkyDome,
  rollingHeightField,
  scatter,
} from './outdoorKit'
import { createWindowReveal } from './reveal'
import { disposeObject } from './shared'
import type { SceneContext, SceneDefinition, SceneInstance } from './types'

/**
 * A beach at the end of the afternoon, with open water to the horizon.
 *
 * The other two scenes get their depth from things — blades, trunks. Water has
 * no landmarks at all, so this one relies on the swell: waves are large near
 * the shore and shrink to nothing with distance, which is a texture gradient
 * your visual system reads as depth without being told. Leaning shifts the sun
 * glitter across the surface, which nothing flat can fake.
 */
export const shoreScene: SceneDefinition = {
  id: 'shore',
  name: 'Shoreline',
  description: 'Open water to the horizon, with the sun on the swell.',
  badge: 'Window',
  kind: 'world',
  minFarM: 900,
  create: createShore,
}

const BASE_EYE_HEIGHT_M = 0.4
const EYE_HEIGHT_PER_DEPTH = 0.55
const FOG_COLOR = 0xc9c0ac
/** Outer edge of the sand disc, in metres. */
const WATERLINE_M = 20
/** Sand height directly below the window. */
const SAND_CREST_M = 0.34
/** Metres of drop per metre out; the waterline is where the sand hits zero. */
const BEACH_GRADIENT = 0.03

function createShore(ctx: SceneContext): SceneInstance {
  const root = new Group()
  root.name = 'shore'

  const sky = createSkyDome({
    // Low and nearly straight ahead, so the sun sits inside the window's
    // ~31° horizontal view and lays a glitter path back toward the viewer.
    elevationDeg: 7,
    azimuthDeg: 262,
    // Low turbidity and weak Mie keep the halo around the low sun tight;
    // hazier settings smear it across the entire upper half of the frame.
    turbidity: 2.6,
    rayleigh: 2.2,
    mieCoefficient: 0.0035,
    mieDirectionalG: 0.78,
    cloudCoverage: 0.34,
    cloudDensity: 0.4,
    cloudSpeed: 0.00008,
  })
  root.add(sky.object)

  root.add(new HemisphereLight(0xe8d8c4, 0x9a8763, 1.7))

  const sun = new DirectionalLight(0xffdcae, 2.9)
  sun.position.copy(sky.sunDirection).multiplyScalar(80)
  root.add(sun, sun.target)

  // ── Sand ──────────────────────────────────────────────────────────────────
  // Ripples only; a beach that rolls like a meadow looks wrong.
  const dunes = rollingHeightField(0x1c4e, {
    amplitudeM: 0.4,
    scaleM: 26,
    detail: 4,
    taperFromM: 6,
    taperToM: WATERLINE_M,
  })
  const grain = fbm2D(0x5a2b, { octaves: 3, frequency: 1 / 3.5 })

  /**
   * Beach height, sloping down through the waterline.
   *
   * The sand has to pass *below* the water plane rather than meeting it, or
   * the two coplanar sheets z-fight along the entire shore. Sloping it under
   * also gives the waterline for free: it's wherever this crosses zero.
   */
  const heightAt = (x: number, z: number): number =>
    SAND_CREST_M - Math.hypot(x, z) * BEACH_GRADIENT + dunes(x, z) + grain(x, z) * 0.02

  const sandLight = new Color(0xd8c5a0)
  const sandDark = new Color(0xa8926e)
  const wet = new Color(0x7d6f57)

  const sand = createGround({
    heightAt,
    innerRadiusM: 1,
    outerRadiusM: WATERLINE_M + 2,
    rings: 46,
    colorAt(x, z, _height, _slope, target) {
      const patch = (grain(x * 0.4, z * 0.4) + 1) / 2
      target.copy(sandDark).lerp(sandLight, patch)
      // Darken as the sand approaches the water, where it stays damp.
      const waterline = SAND_CREST_M / BEACH_GRADIENT
      const damp = smoothstep((Math.hypot(x, z) - waterline * 0.72) / (waterline * 0.3))
      if (damp > 0) target.lerp(wet, Math.min(1, damp))
    },
  })
  sand.mesh.name = 'sand'

  // ── Water ─────────────────────────────────────────────────────────────────
  const water = createWater(sky.sunDirection)
  root.add(water.mesh)

  // ── Rocks ─────────────────────────────────────────────────────────────────
  const rockGeometry = new SphereGeometry(1, 9, 6)
  const rockMaterial = new MeshStandardMaterial({ roughness: 0.9, metalness: 0, flatShading: true })
  const stone = new Color()
  const rocks = scatter(rockGeometry, rockMaterial, {
    count: 120,
    seed: 0x3b8f,
    minRadiusM: 3,
    maxRadiusM: WATERLINE_M * 0.95,
    distribution: 'log',
    heightAt,
    place(dummy, _x, y, _z, random) {
      const size = 0.05 + random() ** 2 * 0.26
      // Bed them into the sand rather than resting them on top.
      dummy.position.y = y - size * 0.45
      dummy.scale.set(size, size * (0.5 + random() * 0.4), size * (0.7 + random() * 0.5))
      dummy.rotation.set(random(), random() * Math.PI, random() * 0.4)
    },
    colorAt(_x, _z, random, target) {
      const t = 0.2 + random() * 0.16
      target.copy(stone.setRGB(t, t * 0.96, t * 0.88))
    },
  })
  rocks.name = 'rocks'

  // ── Window ────────────────────────────────────────────────────────────────
  const reveal = createWindowReveal({ depthM: 0.085, color: 0xece2cf, sillColor: 0xc2b193 })
  reveal.layout(ctx)
  root.add(reveal.group)

  const world = new Group()
  world.name = 'shore-world'
  world.add(sand.mesh, rocks)
  root.add(world)

  const layout = (c: SceneContext): void => {
    reveal.layout(c)
    const eyeHeight = BASE_EYE_HEIGHT_M + c.roomDepthM * EYE_HEIGHT_PER_DEPTH
    world.position.y = -eyeHeight
    water.mesh.position.y = -eyeHeight
    sun.target.position.set(0, -eyeHeight, -30)
    sun.target.updateMatrixWorld()
  }
  layout(ctx)

  return {
    root,
    // Linear fog, not exponential: it lets the far water be pinned to exactly
    // the horizon colour so the join is invisible.
    fog: new Fog(FOG_COLOR, 40, 620),
    exposure: 0.3,
    environmentIntensity: 0.1,
    resize: layout,
    update(_dt, elapsed, c) {
      sky.update(elapsed)
      water.update(elapsed)
      reveal.setVisible(c.settings.showRoom)
    },
    dispose() {
      sky.dispose()
      water.dispose()
      disposeObject(root)
    },
  }
}

function smoothstep(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t
  return c * c * (3 - 2 * c)
}

/**
 * A radial water sheet with Gerstner waves in the vertex shader.
 *
 * Wave amplitude fades out with distance. Not for looks — the radial grid's
 * outer rings are tens of metres apart, and displacing them with a 4m
 * wavelength aliases into a mess of spikes. Beyond the fade the surface is a
 * flat mirror of the sky, which is what deep water looks like at range anyway.
 */
function createWater(sunDirection: Vector3): {
  mesh: Mesh
  update(elapsed: number): void
  dispose(): void
} {
  const geometry = createRadialGrid({
    innerRadiusM: 0.5,
    outerRadiusM: 700,
    rings: 150,
    segments: 160,
  })

  const material = new ShaderMaterial({
    fog: true,
    uniforms: UniformsUtils.merge([
      UniformsLib['fog']!,
      {
        uTime: { value: 0 },
        uSunDirection: { value: sunDirection.clone() },
        uShallow: { value: new Color(0x2f6f7a) },
        uDeep: { value: new Color(0x0e3346) },
        uSky: { value: new Color(0xbcd2e4) },
      },
    ]),
    vertexShader: /* glsl */ `
      #include <common>
      #include <fog_pars_vertex>

      uniform float uTime;

      varying vec3 vWorldPos;
      varying vec3 vNormal;

      // Gerstner wave: returns the displacement and accumulates the analytic
      // surface tangents, which is cheaper and cleaner than a normal map.
      vec3 gerstner( vec2 pos, vec2 dir, float steepness, float wavelength,
                     float time, inout vec3 tangent, inout vec3 binormal ) {
        float k = 2.0 * PI / wavelength;
        float c = sqrt( 9.81 / k );
        vec2 d = normalize( dir );
        float f = k * ( dot( d, pos ) - c * time );
        float a = steepness / k;

        tangent += vec3(
          -d.x * d.x * steepness * sin( f ),
           d.x * steepness * cos( f ),
          -d.x * d.y * steepness * sin( f )
        );
        binormal += vec3(
          -d.x * d.y * steepness * sin( f ),
           d.y * steepness * cos( f ),
          -d.y * d.y * steepness * sin( f )
        );
        return vec3( d.x * a * cos( f ), a * sin( f ), d.y * a * cos( f ) );
      }

      void main() {
        vec3 pos = position;
        float dist = length( pos.xz );
        // Kill the displacement before the grid gets too coarse to carry it.
        float fade = 1.0 - smoothstep( 25.0, 110.0, dist );

        vec3 tangent = vec3( 1.0, 0.0, 0.0 );
        vec3 binormal = vec3( 0.0, 0.0, 1.0 );
        vec3 offset = vec3( 0.0 );
        offset += gerstner( pos.xz, vec2(  1.0,  0.35 ), 0.085, 6.5, uTime, tangent, binormal );
        offset += gerstner( pos.xz, vec2(  0.7, -0.8  ), 0.065, 3.4, uTime, tangent, binormal );
        offset += gerstner( pos.xz, vec2( -0.4,  1.0  ), 0.050, 1.9, uTime, tangent, binormal );
        offset += gerstner( pos.xz, vec2(  1.0, -0.15 ), 0.040, 0.9, uTime, tangent, binormal );
        pos += offset * fade;

        vNormal = normalize( mix( vec3( 0.0, 1.0, 0.0 ),
                                  normalize( cross( binormal, tangent ) ), fade ) );

        vec4 worldPosition = modelMatrix * vec4( pos, 1.0 );
        vWorldPos = worldPosition.xyz;

        vec4 mvPosition = viewMatrix * worldPosition;
        gl_Position = projectionMatrix * mvPosition;

        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <fog_pars_fragment>

      uniform vec3 uSunDirection;
      uniform vec3 uShallow;
      uniform vec3 uDeep;
      uniform vec3 uSky;

      varying vec3 vWorldPos;
      varying vec3 vNormal;

      void main() {
        vec3 normal = normalize( vNormal );
        vec3 viewDir = normalize( cameraPosition - vWorldPos );

        // Schlick: glancing angles mirror the sky, steep ones show the body
        // colour. This is most of what makes water look like water.
        float fresnel = pow( 1.0 - clamp( dot( normal, viewDir ), 0.0, 1.0 ), 4.0 );
        fresnel = mix( 0.03, 1.0, fresnel );

        float depthMix = smoothstep( 4.0, 60.0, length( vWorldPos.xz ) );
        vec3 body = mix( uShallow, uDeep, depthMix );
        vec3 color = mix( body, uSky, fresnel );

        // Sun glitter. The tight exponent is what makes it break into
        // individual sparkles that slide as the viewer moves.
        vec3 halfway = normalize( normalize( uSunDirection ) + viewDir );
        float specular = pow( max( dot( normal, halfway ), 0.0 ), 220.0 );
        color += vec3( 1.0, 0.92, 0.78 ) * specular * 2.6;

        gl_FragColor = vec4( color, 1.0 );

        #include <fog_fragment>
      }
    `,
  })

  const mesh = new Mesh(geometry, material)
  mesh.name = 'water'
  mesh.frustumCulled = false

  return {
    mesh,
    update(elapsed) {
      material.uniforms['uTime']!.value = elapsed
    },
    dispose() {
      geometry.dispose()
      material.dispose()
    },
  }
}
