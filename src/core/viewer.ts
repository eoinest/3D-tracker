import {
  ACESFilmicToneMapping,
  Color,
  PCFShadowMap,
  PerspectiveCamera,
  Plane,
  PMREMGenerator,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Texture,
} from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'

import { applyOffAxisCamera, type WindowRect } from './offAxis'
import type { DisplayGeometry } from './screen'
import type { Settings } from './settings'
import { registerSplatHost } from './splatRuntime'
import type { SceneContext, SceneDefinition, SceneInstance } from '../scenes/types'

/**
 * Owns the renderer, the active scene, and the off-axis camera.
 *
 * The camera never rotates and never has a field of view of its own — see
 * `offAxis.ts`. Everything here exists to keep the scene's idea of the window
 * in sync with the physical one.
 */
export class Viewer {
  readonly renderer: WebGLRenderer
  readonly scene: Scene
  readonly camera: PerspectiveCamera

  /** The eye position actually used for the last frame, in display space. */
  readonly eye = new Vector3(0, 0, 0.6)

  private instance: SceneInstance | null = null
  private definition: SceneDefinition | null = null
  private context: SceneContext
  private environment: Texture | null = null
  private readonly glassPlane = new Plane(new Vector3(0, 0, -1), 0)
  private lastWindow = { w: 0, h: 0, depth: 0 }

  constructor(canvas: HTMLCanvasElement, settings: Settings) {
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
    })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.outputColorSpace = SRGBColorSpace
    this.renderer.toneMapping = ACESFilmicToneMapping
    this.renderer.toneMappingExposure = BASE_EXPOSURE
    this.renderer.shadowMap.enabled = true
    // PCFSoftShadowMap was deprecated in r185 and silently downgrades to this.
    this.renderer.shadowMap.type = PCFShadowMap

    this.scene = new Scene()
    this.scene.background = new Color(0x05070c)

    // A generic room IBL so uploaded PBR models are lit sensibly without the
    // user having to supply an HDRI.
    const pmrem = new PMREMGenerator(this.renderer)
    this.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    this.scene.environment = this.environment
    this.scene.environmentIntensity = BASE_ENV_INTENSITY
    pmrem.dispose()

    this.camera = new PerspectiveCamera(50, 1, settings.nearM, settings.farM)
    this.camera.matrixAutoUpdate = false
    this.scene.add(this.camera)

    // Gaussian splat support is loaded on demand — see splatRuntime.ts. Spark
    // derives its splat footprint from projectionMatrix[0][0] / [1][1] rather
    // than from camera.fov, which is exactly what an off-axis frustum needs:
    // the shear lives in the matrix's third column and leaves those focal
    // terms untouched, so splats render correctly under head tracking with no
    // special handling.
    registerSplatHost(this.renderer, this.scene)

    this.context = {
      windowWidthM: 0.3,
      windowHeightM: 0.19,
      roomDepthM: settings.roomDepthM,
      settings,
      renderer: this.renderer,
    }
  }

  get activeSceneId(): string | null {
    return this.definition?.id ?? null
  }

  get activeScene(): SceneDefinition | null {
    return this.definition
  }

  setScene(definition: SceneDefinition): void {
    if (this.instance) {
      this.scene.remove(this.instance.root)
      this.instance.dispose?.()
    }
    this.definition = definition
    this.instance = definition.create(this.context)
    this.scene.add(this.instance.root)

    // Fog, exposure and environment strength belong to the Scene and the
    // renderer rather than to any object, so they're applied here and reset
    // for scenes that don't ask for them.
    this.scene.fog = this.instance.fog ?? null
    this.scene.environmentIntensity = this.instance.environmentIntensity ?? BASE_ENV_INTENSITY
    this.renderer.toneMappingExposure = this.instance.exposure ?? BASE_EXPOSURE
  }

  /** Forward a key event to the active scene. Returns true if it was consumed. */
  handleKey(event: KeyboardEvent, down: boolean): boolean {
    return this.instance?.onKey?.(event, down) ?? false
  }

  /** Match the drawing buffer to the canvas' CSS size. */
  resizeToDisplay(): void {
    const canvas = this.renderer.domElement
    const width = canvas.clientWidth
    const height = canvas.clientHeight
    if (!width || !height) return
    const size = this.renderer.getSize(sizeScratch)
    if (size.x !== width || size.y !== height) {
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
      this.renderer.setSize(width, height, false)
    }
  }

  render(
    eye: { x: number; y: number; z: number },
    geometry: DisplayGeometry,
    settings: Settings,
    dt: number,
    elapsed: number,
  ): void {
    this.context.settings = settings
    this.context.windowWidthM = geometry.windowWidthM
    this.context.windowHeightM = geometry.windowHeightM
    this.context.roomDepthM = settings.roomDepthM

    const changed =
      this.lastWindow.w !== geometry.windowWidthM ||
      this.lastWindow.h !== geometry.windowHeightM ||
      this.lastWindow.depth !== settings.roomDepthM
    if (changed) {
      this.lastWindow = {
        w: geometry.windowWidthM,
        h: geometry.windowHeightM,
        depth: settings.roomDepthM,
      }
      this.instance?.resize?.(this.context)
    }

    this.instance?.update?.(dt, elapsed, this.context)

    // In window mode nothing may cross the glass; in popout mode that is the
    // entire point, so the clip plane comes off.
    this.renderer.clippingPlanes =
      settings.contentMode === 'window' ? [this.glassPlane] : EMPTY_PLANES

    this.eye.set(eye.x, eye.y, eye.z)
    const rect: WindowRect = {
      widthM: geometry.windowWidthM,
      heightM: geometry.windowHeightM,
      centerXM: geometry.windowCenterXM,
      centerYM: geometry.windowCenterYM,
    }
    // A scene may need to see further than the user's setting allows; take
    // whichever is greater rather than letting a landscape clip at 60m.
    const far = Math.max(settings.farM, this.definition?.minFarM ?? 0)
    applyOffAxisCamera(this.camera, this.eye, rect, settings.nearM, far)

    this.renderer.render(this.scene, this.camera)
  }

  dispose(): void {
    if (this.instance) {
      this.scene.remove(this.instance.root)
      this.instance.dispose?.()
      this.instance = null
    }
    this.environment?.dispose()
    this.renderer.dispose()
  }
}

const EMPTY_PLANES: Plane[] = []
const sizeScratch = new Vector2()

const BASE_EXPOSURE = 1.05
const BASE_ENV_INTENSITY = 0.45
