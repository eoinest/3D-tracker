import {
  FaceLandmarker,
  FilesetResolver,
  type FaceLandmarkerResult,
  type NormalizedLandmark,
} from '@mediapipe/tasks-vision'

import { OneEuroVec3 } from './oneEuro'
import { eyeFromLandmarkPair } from './pinhole'
import type { DisplayGeometry } from './screen'
import type { Settings } from './settings'

/**
 * Webcam face tracking → an eye position in display space (metres).
 *
 * Depth comes from apparent interpupillary distance: the iris landmarks are a
 * near-rigid pair of known real-world separation, so `z = ipd · f / d`. We take
 * the *3D* landmark separation rather than the 2D one, because when you turn
 * your head the projected distance between the irises shrinks and a 2D estimate
 * would read that as "you moved a foot backwards".
 */

const MODEL_URL =
  (import.meta.env['VITE_FACE_MODEL_URL'] as string | undefined) ??
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'

/** Landmark indices in MediaPipe's 478-point canonical face mesh. */
const IRIS_RIGHT = 468 // subject's right eye (image left when un-mirrored)
const IRIS_LEFT = 473
const CANTHUS_RIGHT = 33
const CANTHUS_LEFT = 263
/** Outer canthal distance ÷ interpupillary distance, for the no-iris fallback. */
const CANTHAL_RATIO = 1.43

export type TrackerState = 'idle' | 'starting' | 'running' | 'error'

export interface HeadSample {
  /** Eye midpoint in display space (metres). Smoothed. */
  x: number
  y: number
  z: number
  /** Same point before the 1€ filter — useful for judging jitter. */
  rawX: number
  rawY: number
  rawZ: number
  /** Eye midpoint in normalised image coords, for the debug overlay. */
  u: number
  v: number
  /** Apparent eye separation in pixels; the raw depth signal. */
  separationPx: number
  timestampMs: number
}

export class HeadTracker {
  readonly video: HTMLVideoElement

  state: TrackerState = 'idle'
  error: string | null = null
  lastResult: FaceLandmarkerResult | null = null
  /** Face detections per second, smoothed. */
  detectFps = 0

  private landmarker: FaceLandmarker | null = null
  private stream: MediaStream | null = null
  private filter = new OneEuroVec3()
  private sample: HeadSample | null = null
  private lastVideoTime = -1
  private lastDetectMs = 0
  private lostSince: number | null = null
  private startPromise: Promise<void> | null = null

  constructor() {
    const video = document.createElement('video')
    video.autoplay = true
    video.muted = true
    video.playsInline = true
    video.style.display = 'none'
    this.video = video
  }

  get hasFace(): boolean {
    return this.sample !== null
  }

  /** Idempotent: repeated calls while starting share the same promise. */
  async start(settings: Settings): Promise<void> {
    if (this.state === 'running') return
    if (this.startPromise) return this.startPromise

    this.startPromise = this.doStart(settings).finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  private async doStart(settings: Settings): Promise<void> {
    this.state = 'starting'
    this.error = null
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error(
          'This browser has no camera API here. A secure context (https:// or localhost) is required.',
        )
      }

      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: 'user',
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 60 },
        },
      })
      this.video.srcObject = this.stream
      await this.video.play()

      this.landmarker = await createLandmarker(settings.delegate)
      this.state = 'running'
    } catch (err) {
      this.state = 'error'
      this.error = describeError(err)
      this.stopStream()
      throw err
    }
  }

  stop(): void {
    this.landmarker?.close()
    this.landmarker = null
    this.stopStream()
    this.lastResult = null
    this.sample = null
    this.lastVideoTime = -1
    this.filter.reset()
    this.state = 'idle'
  }

  private stopStream(): void {
    for (const track of this.stream?.getTracks() ?? []) track.stop()
    this.stream = null
    this.video.srcObject = null
  }

  /** Rebuild the landmarker when the GPU/CPU delegate changes. */
  async setDelegate(delegate: Settings['delegate']): Promise<void> {
    if (this.state !== 'running') return
    const next = await createLandmarker(delegate)
    this.landmarker?.close()
    this.landmarker = next
  }

  /**
   * Run detection if a fresh video frame is available, then return the current
   * head position. Cheap to call every animation frame.
   */
  update(settings: Settings, geom: DisplayGeometry, nowMs: number): HeadSample | null {
    if (this.state !== 'running' || !this.landmarker) return null

    const video = this.video
    if (video.readyState < 2 || !video.videoWidth) return this.sample

    const minInterval = 1000 / Math.max(1, settings.trackFps)
    const isNewFrame = video.currentTime !== this.lastVideoTime
    if (!isNewFrame || nowMs - this.lastDetectMs < minInterval) return this.sample

    this.lastVideoTime = video.currentTime
    const dt = nowMs - this.lastDetectMs
    this.lastDetectMs = nowMs
    if (dt > 0 && dt < 1000) this.detectFps += (1000 / dt - this.detectFps) * 0.1

    let result: FaceLandmarkerResult
    try {
      result = this.landmarker.detectForVideo(video, nowMs)
    } catch {
      // A transient detect failure (GPU context loss, resize race) shouldn't
      // tear down tracking — just reuse the previous sample.
      return this.sample
    }
    this.lastResult = result

    const landmarks = result.faceLandmarks?.[0]
    if (!landmarks || landmarks.length < 468) {
      // Hold the last known position briefly so a blink or a quick occlusion
      // doesn't snap the whole scene back to centre.
      this.lostSince ??= nowMs
      if (nowMs - this.lostSince > 500) {
        this.sample = null
        this.filter.reset()
      }
      return this.sample
    }
    this.lostSince = null

    this.sample = this.landmarksToHead(landmarks, settings, geom, nowMs)
    return this.sample
  }

  private landmarksToHead(
    landmarks: NormalizedLandmark[],
    settings: Settings,
    geom: DisplayGeometry,
    nowMs: number,
  ): HeadSample | null {
    const hasIris = landmarks.length >= 478
    const a = landmarks[hasIris ? IRIS_RIGHT : CANTHUS_RIGHT]
    const b = landmarks[hasIris ? IRIS_LEFT : CANTHUS_LEFT]
    if (!a || !b) return this.sample

    const raw = eyeFromLandmarkPair(a, b, {
      videoWidth: this.video.videoWidth,
      videoHeight: this.video.videoHeight,
      // The no-iris fallback measures the outer eye corners, a wider baseline.
      baselineM: (settings.ipdMm / 1000) * (hasIris ? 1 : CANTHAL_RATIO),
      focalNorm: settings.focalNorm,
      mirror: settings.mirrorCamera,
      cameraXM: geom.cameraXM,
      cameraYM: geom.cameraYM,
      cameraZM: geom.cameraZM,
    })
    if (!raw) return this.sample

    this.filter.configure({
      minCutoff: settings.smoothMinCutoff,
      beta: settings.smoothBeta,
      dCutoff: 1,
    })
    const [x, y, z] = this.filter.filter(raw.x, raw.y, raw.z, nowMs / 1000)

    return {
      x,
      y,
      z,
      rawX: raw.x,
      rawY: raw.y,
      rawZ: raw.z,
      u: raw.u,
      v: raw.v,
      separationPx: raw.separationPx,
      timestampMs: nowMs,
    }
  }

  /**
   * Solve for the camera's focal length from a known viewing distance.
   * Far more reliable than asking someone to guess their webcam's field of view.
   */
  calibrateFocalFromDistance(distanceM: number, settings: Settings): number | null {
    const sample = this.sample
    if (!sample || !(distanceM > 0)) return null
    const vw = this.video.videoWidth
    if (!vw) return null
    const baselineM = settings.ipdMm / 1000
    const focalPx = (distanceM * sample.separationPx) / baselineM
    return focalPx / vw
  }
}

async function createLandmarker(delegate: Settings['delegate']): Promise<FaceLandmarker> {
  const wasmRoot = `${import.meta.env.BASE_URL}mediapipe/wasm`
  const fileset = await FilesetResolver.forVisionTasks(wasmRoot)
  const modelAssetPath = await resolveModelUrl()

  const options = {
    baseOptions: { modelAssetPath, delegate },
    runningMode: 'VIDEO' as const,
    numFaces: 1,
    minFaceDetectionConfidence: 0.4,
    minFacePresenceConfidence: 0.4,
    minTrackingConfidence: 0.4,
    outputFaceBlendshapes: false,
    outputFacialTransformationMatrixes: false,
  }

  try {
    return await FaceLandmarker.createFromOptions(fileset, options)
  } catch (err) {
    if (delegate === 'CPU') throw err
    console.warn('[headTracker] GPU delegate failed, falling back to CPU', err)
    return FaceLandmarker.createFromOptions(fileset, {
      ...options,
      baseOptions: { modelAssetPath, delegate: 'CPU' },
    })
  }
}

/**
 * Prefer a self-hosted model (drop `face_landmarker.task` into
 * `public/mediapipe/`) and fall back to Google's CDN copy.
 */
let cachedModelUrl: string | null = null
async function resolveModelUrl(): Promise<string> {
  if (cachedModelUrl) return cachedModelUrl
  const local = `${import.meta.env.BASE_URL}mediapipe/face_landmarker.task`
  try {
    const res = await fetch(local, { method: 'HEAD' })
    const type = res.headers.get('content-type') ?? ''
    // A dev server happily 200s with index.html for missing files; reject that.
    if (res.ok && !type.includes('text/html')) {
      cachedModelUrl = local
      return local
    }
  } catch {
    /* fall through to the CDN */
  }
  cachedModelUrl = MODEL_URL
  return MODEL_URL
}

function describeError(err: unknown): string {
  if (err instanceof DOMException) {
    switch (err.name) {
      case 'NotAllowedError':
        return 'Camera permission was denied. Allow it in your browser’s site settings, then press Start again.'
      case 'NotFoundError':
        return 'No camera found on this device.'
      case 'NotReadableError':
        return 'The camera is already in use by another app.'
      default:
        return `${err.name}: ${err.message}`
    }
  }
  return err instanceof Error ? err.message : String(err)
}
