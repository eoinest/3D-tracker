import {
  FaceLandmarker,
  FilesetResolver,
  type FaceLandmarkerResult,
  type NormalizedLandmark,
} from '@mediapipe/tasks-vision'

import { calibrateMetersPerUnit, headPoseFromMatrix } from './headPose'
import { OneEuroVec3 } from './oneEuro'
import { eyeFromLandmarkPair } from './pinhole'
import { VelocityPredictor } from './predict'
import type { DisplayGeometry } from './screen'
import type { Settings } from './settings'

/**
 * Webcam face tracking → an eye position in display space (metres).
 *
 * Detection is driven by `requestVideoFrameCallback`, not by the render loop.
 * That matters for more than tidiness: rVFC fires once per *camera* frame
 * rather than once per display refresh, so no frame is ever processed twice or
 * skipped, and its metadata carries the frame's capture timestamp — which is
 * the only way to measure the pipeline's true latency instead of guessing at
 * it. That measurement then drives the forward prediction in `predict.ts`.
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

/** How long a face may go missing before the scene recentres. */
const FACE_HOLD_MS = 500

export type TrackerState = 'idle' | 'starting' | 'running' | 'error'

export interface HeadSample {
  /** Eye midpoint in display space (metres). Smoothed and predicted. */
  x: number
  y: number
  z: number
  /** Same point before filtering — useful for judging jitter. */
  rawX: number
  rawY: number
  rawZ: number
  /** Eye midpoint in normalised image coords, for the debug overlay. */
  u: number
  v: number
  /** Apparent eye separation in pixels; the iris estimator's depth signal. */
  separationPx: number
  /** Which estimator produced this sample. */
  source: 'matrix' | 'iris'
  timestampMs: number
}

export class HeadTracker {
  readonly video: HTMLVideoElement

  state: TrackerState = 'idle'
  error: string | null = null
  lastResult: FaceLandmarkerResult | null = null
  /** Face detections per second, smoothed. */
  detectFps = 0
  /**
   * Measured camera-to-detection latency in milliseconds, smoothed.
   * Only available where the browser reports `captureTime`.
   */
  latencyMs = 0
  /** Head speed in m/s, from the predictor. */
  speed = 0

  private landmarker: FaceLandmarker | null = null
  private stream: MediaStream | null = null
  private readonly filter = new OneEuroVec3()
  private readonly predictor = new VelocityPredictor()
  private sample: HeadSample | null = null
  private lastDetectMs = 0
  private lostSince: number | null = null
  private startPromise: Promise<void> | null = null
  private frameHandle: number | null = null
  private lastMatrix: number[] | null = null

  /** Set by the owner so detection can use current settings and geometry. */
  settings: Settings | null = null
  geometry: DisplayGeometry | null = null

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
          // A faster camera is the cheapest latency win available: 60fps halves
          // the worst-case wait for a fresh frame compared with 30.
          frameRate: { ideal: 60, min: 24 },
        },
      })
      this.video.srcObject = this.stream
      await this.video.play()

      this.landmarker = await createLandmarker(settings.delegate)
      this.state = 'running'
      this.scheduleFrame()
    } catch (err) {
      this.state = 'error'
      this.error = describeError(err)
      this.stopStream()
      throw err
    }
  }

  stop(): void {
    if (this.frameHandle !== null && 'cancelVideoFrameCallback' in this.video) {
      this.video.cancelVideoFrameCallback(this.frameHandle)
    }
    this.frameHandle = null
    this.landmarker?.close()
    this.landmarker = null
    this.stopStream()
    this.lastResult = null
    this.lastMatrix = null
    this.sample = null
    this.filter.reset()
    this.predictor.reset()
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
   * Latest head position, already predicted forward to `nowMs`.
   *
   * Detection runs on its own schedule, so this is cheap to call every frame
   * and returns a fresh extrapolation each time rather than a stale sample.
   */
  currentSample(nowMs: number, settings: Settings): HeadSample | null {
    const sample = this.sample
    if (!sample) return null

    // Prediction covers the gap between the frame the pose came from and the
    // frame about to be drawn, plus the measured pipeline latency.
    const leadMs = settings.predictMs > 0 ? settings.predictMs + (nowMs - sample.timestampMs) : 0
    if (leadMs <= 0) return sample

    const predicted = this.predictor.predict(sample, Math.min(leadMs, 250) / 1000)
    return { ...sample, x: predicted.x, y: predicted.y, z: predicted.z }
  }

  private scheduleFrame(): void {
    if (this.state !== 'running') return
    if (!('requestVideoFrameCallback' in this.video)) {
      // Safari < 15.4 and some embedded webviews. Fall back to polling at
      // display rate; detection then dedupes on currentTime.
      this.frameHandle = window.setTimeout(() => this.onFrame(performance.now(), null), 16)
      return
    }
    this.frameHandle = this.video.requestVideoFrameCallback((now, metadata) => {
      this.onFrame(now, metadata)
    })
  }

  private onFrame(nowMs: number, metadata: VideoFrameCallbackMetadata | null): void {
    if (this.state !== 'running' || !this.landmarker) return

    const settings = this.settings
    const geometry = this.geometry
    if (!settings || !geometry) {
      this.scheduleFrame()
      return
    }

    const minInterval = 1000 / Math.max(1, settings.trackFps)
    if (nowMs - this.lastDetectMs < minInterval) {
      this.scheduleFrame()
      return
    }

    const dt = nowMs - this.lastDetectMs
    this.lastDetectMs = nowMs
    if (dt > 0 && dt < 1000) this.detectFps += (1000 / dt - this.detectFps) * 0.1

    if (this.video.readyState >= 2 && this.video.videoWidth) {
      this.detect(nowMs, metadata, settings, geometry)
    }
    this.scheduleFrame()
  }

  private detect(
    nowMs: number,
    metadata: VideoFrameCallbackMetadata | null,
    settings: Settings,
    geometry: DisplayGeometry,
  ): void {
    let result: FaceLandmarkerResult
    try {
      result = this.landmarker!.detectForVideo(this.video, nowMs)
    } catch {
      // A transient failure (GPU context loss, a resize race) shouldn't tear
      // down tracking — reuse the previous sample.
      return
    }
    this.lastResult = result

    // captureTime is when the sensor grabbed the frame, so this is the real
    // camera-to-here latency rather than an assumption.
    if (metadata?.captureTime !== undefined) {
      const measured = performance.now() - metadata.captureTime
      if (measured >= 0 && measured < 500) {
        this.latencyMs += (measured - this.latencyMs) * 0.1
      }
    }

    const landmarks = result.faceLandmarks?.[0]
    if (!landmarks || landmarks.length < 468) {
      // Hold the last position briefly so a blink or a quick occlusion doesn't
      // snap the whole scene back to centre.
      this.lostSince ??= nowMs
      if (nowMs - this.lostSince > FACE_HOLD_MS) {
        this.sample = null
        this.lastMatrix = null
        this.filter.reset()
        this.predictor.reset()
      }
      return
    }
    this.lostSince = null

    this.lastMatrix = result.facialTransformationMatrixes?.[0]?.data ?? null
    this.sample = this.solve(landmarks, settings, geometry, nowMs)
  }

  private solve(
    landmarks: NormalizedLandmark[],
    settings: Settings,
    geom: DisplayGeometry,
    nowMs: number,
  ): HeadSample | null {
    const hasIris = landmarks.length >= 478
    const a = landmarks[hasIris ? IRIS_RIGHT : CANTHUS_RIGHT]
    const b = landmarks[hasIris ? IRIS_LEFT : CANTHUS_LEFT]

    // Image-space eye midpoint, kept for the debug overlay regardless of which
    // estimator ends up supplying the position.
    const u = a && b ? (a.x + b.x) / 2 : 0.5
    const v = a && b ? (a.y + b.y) / 2 : 0.5

    let raw: { x: number; y: number; z: number } | null = null
    let source: HeadSample['source'] = 'matrix'
    let separationPx = 0

    if (settings.poseSource === 'matrix' && this.lastMatrix) {
      raw = headPoseFromMatrix(this.lastMatrix, {
        metersPerUnit: settings.metersPerUnit,
        mirror: settings.mirrorCamera,
        cameraXM: geom.cameraXM,
        cameraYM: geom.cameraYM,
        cameraZM: geom.cameraZM,
      })
    }

    if (!raw && a && b) {
      const iris = eyeFromLandmarkPair(a, b, {
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
      if (iris) {
        raw = { x: iris.x, y: iris.y, z: iris.z }
        separationPx = iris.separationPx
        source = 'iris'
      }
    }

    if (!raw) return this.sample

    this.filter.configure({
      minCutoff: settings.smoothMinCutoff,
      beta: settings.smoothBeta,
      dCutoff: 1,
    })
    const seconds = nowMs / 1000
    const [x, y, z] = this.filter.filter(raw.x, raw.y, raw.z, seconds)

    // Feed the predictor the *smoothed* track: extrapolating raw samples
    // amplifies exactly the jitter the filter just removed.
    this.predictor.update(x, y, z, seconds)
    this.speed = this.predictor.speed

    return {
      x,
      y,
      z,
      rawX: raw.x,
      rawY: raw.y,
      rawZ: raw.z,
      u,
      v,
      separationPx,
      source,
      timestampMs: nowMs,
    }
  }

  /**
   * Solves the active estimator's one free scale factor from a known distance.
   * Far more reliable than asking someone to guess their webcam's field of view.
   */
  calibrate(distanceM: number, settings: Settings): { key: 'metersPerUnit' | 'focalNorm'; value: number } | null {
    if (!(distanceM > 0)) return null

    if (settings.poseSource === 'matrix' && this.lastMatrix) {
      const value = calibrateMetersPerUnit(this.lastMatrix, distanceM)
      return value === null ? null : { key: 'metersPerUnit', value }
    }

    const sample = this.sample
    const vw = this.video.videoWidth
    if (!sample || !sample.separationPx || !vw) return null
    const focalPx = (distanceM * sample.separationPx) / (settings.ipdMm / 1000)
    return { key: 'focalNorm', value: focalPx / vw }
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
    // The metric head pose. Costs almost nothing on top of the landmarks and
    // is a far steadier position estimate than two iris points.
    outputFacialTransformationMatrixes: true,
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
