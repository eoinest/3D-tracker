import './style.css'

import { HeadTracker, type HeadSample } from './core/headTracker'
import { loadModelFromFiles, type LoadedModel } from './core/modelLoader'
import { computeDisplayGeometry, physicalScreenSize, type DisplayGeometry } from './core/screen'
import { SettingsStore, type Settings } from './core/settings'
import { Viewer } from './core/viewer'
import { BUILT_IN_SCENES, findScene, uploadScene } from './scenes'
import type { SceneDefinition } from './scenes/types'
import { DebugOverlay } from './ui/debugOverlay'
import { ControlPanel, type LibraryEntry } from './ui/panel'
import { disposeObject } from './scenes/shared'
import { filesFromDataTransfer } from './ui/dropFiles'

/**
 * Distance at which depth gain is neutral. Scaling *deviation* from a nominal
 * distance rather than the distance itself means gain 0 pins you at a normal
 * viewing distance instead of collapsing the world onto the glass.
 */
const NOMINAL_DISTANCE_M = 0.55
const MIN_DISTANCE_M = 0.15
const MAX_DISTANCE_M = 3

const store = new SettingsStore()
const settings = store.values

const canvas = document.querySelector<HTMLCanvasElement>('#view')!
const shell = document.querySelector<HTMLElement>('#app')!

const viewer = new Viewer(canvas, settings)
const tracker = new HeadTracker()
document.body.appendChild(tracker.video)

const overlay = new DebugOverlay()
const uploads = new Map<string, { model: LoadedModel; definition: SceneDefinition }>()

const panel = new ControlPanel(store, {
  onSelect: selectScene,
  onStartCamera: startCamera,
  onStopCamera: stopCamera,
  onFiles: (files) => void ingestFiles(files),
  onRemove: removeUpload,
  onCalibrate: calibrate,
  onReset: () => {
    store.reset()
    panel.toast('Settings restored to defaults.', 'success')
  },
  onFullscreen: toggleFullscreen,
})

const panelToggle = document.querySelector<HTMLButtonElement>('#panel-toggle')!
panelToggle.addEventListener('click', () => togglePanel())

shell.append(panel.element, panel.toasts, overlay.element)

// ── Head position ────────────────────────────────────────────────────────────

/** Pointer-mode virtual viewer, in display space. */
const pointer = { x: 0, y: 0, z: NOMINAL_DISTANCE_M, seen: false }
let lastSample: HeadSample | null = null

window.addEventListener('pointermove', (event) => {
  const { widthM, heightM } = physicalScreenSize(settings)
  pointer.x = (event.clientX / window.innerWidth - 0.5) * widthM * 1.4
  pointer.y = (0.5 - event.clientY / window.innerHeight) * heightM * 1.4
  pointer.seen = true
})

window.addEventListener(
  'wheel',
  (event) => {
    if (settings.headSource !== 'pointer') return
    if ((event.target as HTMLElement | null)?.closest('.panel')) return
    event.preventDefault()
    pointer.z = clamp(pointer.z + event.deltaY * 0.0008, MIN_DISTANCE_M, MAX_DISTANCE_M)
  },
  { passive: false },
)

function resolveEye(geometry: DisplayGeometry, nowMs: number): { x: number; y: number; z: number } {
  let raw = { x: 0, y: 0, z: NOMINAL_DISTANCE_M }

  if (settings.headSource === 'camera') {
    lastSample = tracker.update(settings, geometry, nowMs)
    if (lastSample) {
      raw = { x: lastSample.x, y: lastSample.y, z: lastSample.z }
    } else if (pointer.seen) {
      // No face yet — fall back to the pointer so the scene still responds
      // instead of sitting dead centre while the model warms up.
      raw = { x: pointer.x, y: pointer.y, z: pointer.z }
    }
  } else if (settings.headSource === 'pointer') {
    raw = { x: pointer.x, y: pointer.y, z: pointer.z }
  }

  return {
    x: raw.x * settings.parallaxGain,
    y: raw.y * settings.parallaxGain,
    z: clamp(
      NOMINAL_DISTANCE_M + (raw.z - NOMINAL_DISTANCE_M) * settings.depthGain,
      MIN_DISTANCE_M,
      MAX_DISTANCE_M,
    ),
  }
}

// ── Scene library ────────────────────────────────────────────────────────────

function libraryEntries(): LibraryEntry[] {
  const entries: LibraryEntry[] = BUILT_IN_SCENES.map((scene) => ({
    id: scene.id,
    name: scene.name,
    description: scene.description,
    badge: scene.badge,
    group: scene.kind === 'world' ? 'Worlds' : 'Sample models',
  }))

  for (const [id, upload] of uploads) {
    entries.push({
      id,
      name: upload.definition.name,
      description: upload.definition.description,
      group: 'Your uploads',
      removable: true,
    })
  }
  return entries
}

function refreshLibrary(): void {
  panel.setLibrary(libraryEntries())
  panel.setActive(viewer.activeSceneId)
}

function resolveScene(id: string): SceneDefinition | undefined {
  return uploads.get(id)?.definition ?? findScene(id)
}

function selectScene(id: string): void {
  const definition = resolveScene(id)
  if (!definition) return
  viewer.setScene(definition)
  store.set('sceneId', id)
  panel.setActive(id)
}

// ── Uploads ──────────────────────────────────────────────────────────────────

let uploadCounter = 0

async function ingestFiles(files: File[]): Promise<void> {
  if (!files.length) return
  panel.toast(`Loading ${files.length} file${files.length > 1 ? 's' : ''}…`)
  try {
    const model = await loadModelFromFiles(files, viewer.renderer)
    const id = `upload:${++uploadCounter}`
    const { triangles, meshes } = model.stats
    const definition = uploadScene(
      {
        id,
        name: model.name || `Model ${uploadCounter}`,
        description: `${meshes} mesh${meshes === 1 ? '' : 'es'} · ${formatCount(triangles)} triangles`,
      },
      model.object,
    )
    uploads.set(id, { model, definition })
    refreshLibrary()
    selectScene(id)
    panel.toast(`Loaded ${definition.name}.`, 'success')
  } catch (err) {
    console.error(err)
    panel.toast(err instanceof Error ? err.message : 'Could not load that model.', 'error')
  }
}

function removeUpload(id: string): void {
  const upload = uploads.get(id)
  if (!upload) return

  if (viewer.activeSceneId === id) selectScene('portal-room')
  uploads.delete(id)
  disposeObject(upload.model.object)
  upload.model.release()
  refreshLibrary()
}

// ── Camera control ───────────────────────────────────────────────────────────

async function startCamera(): Promise<void> {
  store.set('headSource', 'camera')
  try {
    await tracker.start(settings)
    panel.toast('Face tracking active.', 'success')
  } catch {
    store.set('headSource', 'pointer')
    panel.toast(tracker.error ?? 'Could not start the camera.', 'error')
  }
}

function stopCamera(): void {
  tracker.stop()
  lastSample = null
  store.set('headSource', 'pointer')
}

function calibrate(distanceCm: number): void {
  if (!Number.isFinite(distanceCm) || distanceCm <= 0) {
    panel.toast('Enter the distance from your eyes to the screen, in centimetres.', 'error')
    return
  }
  const focalNorm = tracker.calibrateFocalFromDistance(distanceCm / 100, settings)
  if (focalNorm === null) {
    panel.toast('Start the camera and make sure your face is detected first.', 'error')
    return
  }
  store.set('focalNorm', clamp(focalNorm, 0.3, 3))
  panel.toast(`Calibrated: focal length ${focalNorm.toFixed(3)}×width.`, 'success')
}

// ── Chrome ───────────────────────────────────────────────────────────────────

function togglePanel(force?: boolean): void {
  const hidden = force ?? !shell.classList.contains('panel-hidden')
  shell.classList.toggle('panel-hidden', hidden)
  panelToggle.setAttribute('aria-expanded', String(!hidden))
  panelToggle.title = hidden ? 'Show controls (H)' : 'Hide controls (H)'
}

function toggleFullscreen(): void {
  if (document.fullscreenElement) void document.exitFullscreen()
  else void document.documentElement.requestFullscreen().catch(() => undefined)
}

document.addEventListener('keydown', (event) => {
  if (isTyping(event.target) || event.metaKey || event.ctrlKey || event.altKey) return

  switch (event.code) {
    case 'KeyH':
      togglePanel()
      return
    case 'KeyF':
      toggleFullscreen()
      return
    case 'KeyC':
      if (tracker.state === 'running') stopCamera()
      else void startCamera()
      return
    case 'KeyD':
      store.set('showDebug', !settings.showDebug)
      return
    case 'KeyP':
      store.set('headSource', settings.headSource === 'pointer' ? 'camera' : 'pointer')
      return
    default:
      break
  }

  if (viewer.handleKey(event, true)) event.preventDefault()
})

document.addEventListener('keyup', (event) => {
  if (isTyping(event.target)) return
  if (viewer.handleKey(event, false)) event.preventDefault()
})

// Drag and drop anywhere on the page.
let dragDepth = 0
window.addEventListener('dragenter', (event) => {
  event.preventDefault()
  dragDepth += 1
  shell.classList.add('is-dragging')
})
window.addEventListener('dragover', (event) => {
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
})
window.addEventListener('dragleave', (event) => {
  event.preventDefault()
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) shell.classList.remove('is-dragging')
})
window.addEventListener('drop', (event) => {
  event.preventDefault()
  dragDepth = 0
  shell.classList.remove('is-dragging')
  void filesFromDataTransfer(event.dataTransfer).then(ingestFiles)
})

store.subscribe((_values, changed) => {
  if (changed.has('showDebug')) overlay.setVisible(settings.showDebug)
  if (changed.has('delegate') && tracker.state === 'running') {
    void tracker.setDelegate(settings.delegate).catch(() => {
      panel.toast('Could not switch inference backend.', 'error')
    })
  }
  if (changed.has('headSource') && settings.headSource === 'camera' && tracker.state === 'idle') {
    void startCamera()
  }
})

// ── Frame loop ───────────────────────────────────────────────────────────────

let previousMs = performance.now()
let elapsed = 0
let renderFps = 60
let overlayDue = 0

function frame(nowMs: number): void {
  const dt = Math.min(0.1, (nowMs - previousMs) / 1000)
  previousMs = nowMs
  elapsed += dt
  if (dt > 0) renderFps += (1 / dt - renderFps) * 0.08

  // Layout reads first, DOM writes later — otherwise the overlay's text updates
  // force a reflow on every single frame.
  viewer.resizeToDisplay()
  const geometry = computeDisplayGeometry(settings, canvas)
  const eye = resolveEye(geometry, nowMs)

  viewer.render(eye, geometry, settings, dt, elapsed)

  if (nowMs >= overlayDue) {
    overlayDue = nowMs + 100
    overlay.update({ tracker, settings, geometry, eye, sample: lastSample, renderFps })
    panel.setTrackerStatus({
      state: tracker.state,
      error: tracker.error,
      hasFace: tracker.hasFace,
      detectFps: tracker.detectFps,
      distanceM: lastSample?.z ?? null,
    })
  }

  requestAnimationFrame(frame)
}

// ── Boot ─────────────────────────────────────────────────────────────────────

overlay.setVisible(settings.showDebug)
selectScene(findScene(settings.sceneId) ? settings.sceneId : 'portal-room')
refreshLibrary()
requestAnimationFrame(frame)

document.body.classList.remove('is-booting')

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  if (!element) return false
  const tag = element.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

declare global {
  interface Window {
    /** Escape hatch for poking at state from the console. */
    tracker3d?: { viewer: Viewer; tracker: HeadTracker; settings: Settings }
  }
}
window.tracker3d = { viewer, tracker, settings }
