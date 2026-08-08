import type { Settings } from './settings'

const MM = 0.001
const INCH = 0.0254

/**
 * Where things physically are, in metres, in "display space":
 *
 *   origin  = centre of the physical display
 *   +X      = right, as seen by someone looking at the display
 *   +Y      = up
 *   +Z      = out of the display, toward the viewer
 *
 * The illusion is only as good as these numbers, which is why the panel makes
 * screen size and camera offset first-class settings rather than constants.
 */
export interface DisplayGeometry {
  screenWidthM: number
  screenHeightM: number
  metersPerCssPx: number

  /** The canvas viewport — the actual "window" we project through. */
  windowWidthM: number
  windowHeightM: number
  /** Offset of the canvas centre from the display centre. */
  windowCenterXM: number
  windowCenterYM: number

  /** Webcam optical centre. */
  cameraXM: number
  cameraYM: number
  cameraZM: number
}

export function physicalScreenSize(settings: Settings): { widthM: number; heightM: number } {
  if (settings.manualScreenSize) {
    return {
      widthM: Math.max(0.01, settings.screenWidthMm * MM),
      heightM: Math.max(0.01, settings.screenHeightMm * MM),
    }
  }
  const diag = Math.max(0.05, settings.screenDiagonalIn * INCH)
  const aspect = screenAspectRatio()
  const heightM = diag / Math.hypot(aspect, 1)
  return { widthM: aspect * heightM, heightM }
}

function screenAspectRatio(): number {
  const w = window.screen?.width ?? window.innerWidth
  const h = window.screen?.height ?? window.innerHeight
  if (!w || !h) return 16 / 10
  return w / h
}

export function computeDisplayGeometry(settings: Settings, canvas: HTMLElement): DisplayGeometry {
  const { widthM: screenWidthM, heightM: screenHeightM } = physicalScreenSize(settings)
  const screenCssW = window.screen?.width || window.innerWidth
  const screenCssH = window.screen?.height || window.innerHeight
  const metersPerCssPx = screenWidthM / screenCssW

  let windowWidthM = screenWidthM
  let windowHeightM = screenHeightM
  let windowCenterXM = 0
  let windowCenterYM = 0

  if (settings.canvasPlacement === 'auto') {
    const rect = canvas.getBoundingClientRect()

    // Browser chrome above the viewport. `outerHeight - innerHeight` is the only
    // portable handle on it; it over-counts if the browser has bottom chrome,
    // which is why "fill-screen" exists as an escape hatch.
    const chromeH = Math.max(0, (window.outerHeight || 0) - (window.innerHeight || 0))
    const contentLeftCss = window.screenX ?? 0
    const contentTopCss = (window.screenY ?? 0) + chromeH

    // Canvas centre in display CSS pixels, origin at the display's top-left.
    const cxCss = contentLeftCss + rect.left + rect.width / 2
    const cyCss = contentTopCss + rect.top + rect.height / 2

    windowWidthM = rect.width * metersPerCssPx
    windowHeightM = rect.height * metersPerCssPx
    windowCenterXM = (cxCss - screenCssW / 2) * metersPerCssPx
    windowCenterYM = (screenCssH / 2 - cyCss) * metersPerCssPx
  }

  return {
    screenWidthM,
    screenHeightM,
    metersPerCssPx,
    windowWidthM: Math.max(0.01, windowWidthM),
    windowHeightM: Math.max(0.01, windowHeightM),
    windowCenterXM,
    windowCenterYM,
    cameraXM: settings.cameraOffsetXMm * MM,
    cameraYM: screenHeightM / 2 + settings.cameraBezelMm * MM,
    cameraZM: settings.cameraOffsetZMm * MM,
  }
}
