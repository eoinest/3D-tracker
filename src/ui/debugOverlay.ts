import type { HeadSample, HeadTracker } from '../core/headTracker'
import type { DisplayGeometry } from '../core/screen'
import type { Settings } from '../core/settings'
import { h } from './dom'

const PREVIEW_W = 260
const PREVIEW_H = 146

/**
 * The "is it actually working?" panel: a mirrored camera preview with the mesh
 * drawn on it, plus the numbers the projection is being fed.
 *
 * Worth keeping visible while calibrating — a distance readout that disagrees
 * with a tape measure is the fastest way to spot a wrong focal length.
 */
export class DebugOverlay {
  readonly element: HTMLElement

  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly stats: HTMLElement

  constructor() {
    this.canvas = h('canvas', { class: 'debug-canvas', width: PREVIEW_W, height: PREVIEW_H })
    this.ctx = this.canvas.getContext('2d')!
    this.stats = h('div', { class: 'debug-stats' })
    this.element = h('div', { class: 'debug', hidden: true }, this.canvas, this.stats)
  }

  setVisible(visible: boolean): void {
    this.element.hidden = !visible
  }

  update(input: {
    tracker: HeadTracker
    settings: Settings
    geometry: DisplayGeometry
    eye: { x: number; y: number; z: number }
    sample: HeadSample | null
    renderFps: number
  }): void {
    const { tracker, settings, geometry, eye, sample, renderFps } = input
    if (this.element.hidden) return

    this.canvas.hidden = !settings.showVideo
    this.stats.hidden = !settings.showStats

    if (settings.showVideo) this.drawPreview(tracker, sample)
    if (settings.showStats) this.drawStats({ tracker, settings, geometry, eye, sample, renderFps })
  }

  private drawPreview(tracker: HeadTracker, sample: HeadSample | null): void {
    const ctx = this.ctx
    const video = tracker.video

    ctx.clearRect(0, 0, PREVIEW_W, PREVIEW_H)
    ctx.fillStyle = '#0a0f18'
    ctx.fillRect(0, 0, PREVIEW_W, PREVIEW_H)

    if (tracker.state !== 'running' || video.readyState < 2) {
      ctx.fillStyle = '#5b6b85'
      ctx.font = '12px ui-sans-serif, system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(
        tracker.state === 'error' ? 'camera error' : 'camera off',
        PREVIEW_W / 2,
        PREVIEW_H / 2,
      )
      return
    }

    // Mirrored, because a preview of your own face that moves the "wrong" way
    // is genuinely disorienting to calibrate against.
    ctx.save()
    ctx.translate(PREVIEW_W, 0)
    ctx.scale(-1, 1)
    ctx.drawImage(video, 0, 0, PREVIEW_W, PREVIEW_H)
    ctx.restore()

    const landmarks = tracker.lastResult?.faceLandmarks?.[0]
    if (!landmarks) return

    const px = (x: number): number => (1 - x) * PREVIEW_W
    const py = (y: number): number => y * PREVIEW_H

    ctx.fillStyle = 'rgba(76, 201, 240, 0.55)'
    for (let i = 0; i < landmarks.length; i += 3) {
      const point = landmarks[i]!
      ctx.fillRect(px(point.x) - 0.5, py(point.y) - 0.5, 1.4, 1.4)
    }

    // Irises drive the whole depth estimate, so call them out.
    for (const index of [468, 473]) {
      const point = landmarks[index]
      if (!point) continue
      ctx.beginPath()
      ctx.arc(px(point.x), py(point.y), 3.4, 0, Math.PI * 2)
      ctx.strokeStyle = '#ffd166'
      ctx.lineWidth = 1.5
      ctx.stroke()
    }

    if (sample) {
      const cx = px(sample.u)
      const cy = py(sample.v)
      ctx.strokeStyle = '#4ad66d'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(cx - 9, cy)
      ctx.lineTo(cx + 9, cy)
      ctx.moveTo(cx, cy - 9)
      ctx.lineTo(cx, cy + 9)
      ctx.stroke()
    }
  }

  private drawStats(input: {
    tracker: HeadTracker
    settings: Settings
    geometry: DisplayGeometry
    eye: { x: number; y: number; z: number }
    sample: HeadSample | null
    renderFps: number
  }): void {
    const { tracker, geometry, eye, sample, renderFps } = input
    const cm = (v: number): string => `${(v * 100).toFixed(1)}`

    const rows: [string, string][] = [
      ['eye x / y', `${cm(eye.x)} / ${cm(eye.y)} cm`],
      ['distance', `${cm(eye.z)} cm`],
      ['window', `${cm(geometry.windowWidthM)} × ${cm(geometry.windowHeightM)} cm`],
      ['offset', `${cm(geometry.windowCenterXM)} / ${cm(geometry.windowCenterYM)} cm`],
      ['render', `${renderFps.toFixed(0)} fps`],
      ['detect', tracker.state === 'running' ? `${tracker.detectFps.toFixed(0)} fps` : '—'],
      ['iris sep', sample ? `${sample.separationPx.toFixed(1)} px` : '—'],
    ]

    this.stats.replaceChildren(
      ...rows.flatMap(([label, value]) => [
        h('span', { class: 'debug-key' }, label),
        h('span', { class: 'debug-val' }, value),
      ]),
    )
  }
}
