/**
 * All user-tunable state, persisted to localStorage.
 *
 * Everything the user types is in human units (inches, millimetres, degrees);
 * everything the renderer consumes is in metres. The conversion happens in
 * `screen.ts` / `headTracker.ts`, never in the UI.
 */

export type HeadSource = 'camera' | 'pointer' | 'fixed'
export type ContentMode = 'window' | 'popout'
export type CanvasPlacement = 'auto' | 'fill-screen'
export type Delegate = 'GPU' | 'CPU'

export interface Settings {
  // ── Physical display ──────────────────────────────────────────────────────
  screenDiagonalIn: number
  manualScreenSize: boolean
  screenWidthMm: number
  screenHeightMm: number
  canvasPlacement: CanvasPlacement

  /** Webcam position relative to the centre of the display, in mm. */
  cameraOffsetXMm: number
  /** Height of the camera above the *top edge* of the display (bezel). */
  cameraBezelMm: number
  cameraOffsetZMm: number

  // ── Head tracking ─────────────────────────────────────────────────────────
  headSource: HeadSource
  /** Interpupillary distance. Adult mean ≈ 63mm; this sets the depth scale. */
  ipdMm: number
  /** Focal length of the webcam in pixels, divided by the video width. */
  focalNorm: number
  /** Webcams face you, so image-space +x is your left. True = un-mirror it. */
  mirrorCamera: boolean
  delegate: Delegate
  /** Cap on face-detection rate; rendering always runs at display rate. */
  trackFps: number

  // 1€ filter
  smoothMinCutoff: number
  smoothBeta: number

  // ── Projection ────────────────────────────────────────────────────────────
  /** Multiplies head displacement parallel to the screen. 1 = physically true. */
  parallaxGain: number
  /** Multiplies head distance from the screen. 1 = physically true. */
  depthGain: number
  nearM: number
  farM: number

  // ── Content ───────────────────────────────────────────────────────────────
  sceneId: string
  contentMode: ContentMode
  /** How deep the virtual room extends behind the screen, in metres. */
  roomDepthM: number
  /** Uniform scale applied to loaded models. */
  modelScale: number
  autoRotate: boolean
  showRoom: boolean

  // ── Debug ─────────────────────────────────────────────────────────────────
  showDebug: boolean
  showVideo: boolean
  showStats: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  screenDiagonalIn: 14,
  manualScreenSize: false,
  screenWidthMm: 302,
  screenHeightMm: 189,
  canvasPlacement: 'auto',

  cameraOffsetXMm: 0,
  cameraBezelMm: 8,
  cameraOffsetZMm: 0,

  headSource: 'pointer',
  ipdMm: 63,
  focalNorm: 0.85,
  mirrorCamera: true,
  delegate: 'GPU',
  trackFps: 60,

  smoothMinCutoff: 1.2,
  smoothBeta: 0.035,

  parallaxGain: 1,
  depthGain: 1,
  nearM: 0.02,
  farM: 60,

  sceneId: 'window-box',
  contentMode: 'window',
  roomDepthM: 0.9,
  modelScale: 1,
  autoRotate: false,
  showRoom: true,

  showDebug: false,
  showVideo: true,
  showStats: true,
}

const STORAGE_KEY = '3d-tracker/settings/v1'

type Listener = (settings: Settings, changed: ReadonlySet<keyof Settings>) => void

export class SettingsStore {
  readonly values: Settings
  private listeners = new Set<Listener>()

  constructor() {
    this.values = { ...DEFAULT_SETTINGS, ...load() }
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    if (Object.is(this.values[key], value)) return
    this.values[key] = value
    this.emit(new Set<keyof Settings>([key]))
  }

  patch(partial: Partial<Settings>): void {
    const changed = new Set<keyof Settings>()
    for (const [k, v] of Object.entries(partial) as [keyof Settings, never][]) {
      if (v === undefined || Object.is(this.values[k], v)) continue
      this.values[k] = v
      changed.add(k)
    }
    if (changed.size) this.emit(changed)
  }

  reset(): void {
    this.patch(DEFAULT_SETTINGS)
  }

  private emit(changed: ReadonlySet<keyof Settings>): void {
    save(this.values)
    for (const fn of this.listeners) fn(this.values, changed)
  }
}

function load(): Partial<Settings> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    // Only keep keys we still know about, so old payloads can't smuggle in junk.
    const out: Partial<Settings> = {}
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
      const v = (parsed as Record<string, unknown>)[key]
      if (v !== undefined && typeof v === typeof DEFAULT_SETTINGS[key]) {
        out[key] = v as never
      }
    }
    return out
  } catch {
    return {}
  }
}

let saveTimer: number | undefined
function save(settings: Settings): void {
  clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
    } catch {
      /* private mode / quota — settings just won't persist */
    }
  }, 150)
}
