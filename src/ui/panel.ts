import { ACCEPT_ATTRIBUTE } from '../core/modelLoader'
import { physicalScreenSize } from '../core/screen'
import type { SettingsStore } from '../core/settings'
import type { TrackerState } from '../core/headTracker'
import { ControlFactory } from './controls'
import { clear, h } from './dom'

export interface LibraryEntry {
  id: string
  name: string
  description: string
  badge?: string
  group: string
  removable?: boolean
}

export interface PanelCallbacks {
  onSelect(id: string): void
  onStartCamera(): void
  onStopCamera(): void
  onFiles(files: File[]): void
  onSplatUrl(url: string): void
  onRemove(id: string): void
  onCalibrate(distanceCm: number): void
  onReset(): void
  onFullscreen(): void
}

export interface TrackerStatus {
  state: TrackerState
  error: string | null
  hasFace: boolean
  detectFps: number
  distanceM: number | null
}

const STATE_LABEL: Record<TrackerState, string> = {
  idle: 'Camera off',
  starting: 'Starting…',
  running: 'Tracking',
  error: 'Camera error',
}

export class ControlPanel {
  readonly element: HTMLElement
  /**
   * Lives outside the panel so messages survive `H`. An upload failing while
   * the controls are hidden is exactly when you most need to be told.
   */
  readonly toasts: HTMLElement

  private readonly controls: ControlFactory
  private readonly libraryList: HTMLElement
  private readonly statusDot: HTMLElement
  private readonly statusText: HTMLElement
  private readonly statusDetail: HTMLElement
  private readonly cameraButton: HTMLButtonElement
  private readonly screenReadout: HTMLElement
  private readonly calibrateInput: HTMLInputElement
  private readonly splatStatusLine: HTMLElement
  private entries: LibraryEntry[] = []
  private activeId: string | null = null
  private readonly items = new Map<string, { row: HTMLElement; pick: HTMLElement }>()

  constructor(
    private readonly store: SettingsStore,
    private readonly callbacks: PanelCallbacks,
  ) {
    this.controls = new ControlFactory(store)

    this.statusDot = h('span', { class: 'status-dot' })
    this.statusText = h('span', { class: 'status-text' }, 'Camera off')
    this.statusDetail = h('span', { class: 'status-detail' })
    this.cameraButton = h(
      'button',
      { type: 'button', class: 'btn btn-primary', onclick: () => this.toggleCamera() },
      'Start camera',
    )
    this.libraryList = h('div', { class: 'library' })
    this.screenReadout = h('small', { class: 'ctl-hint' })
    this.toasts = h('div', { class: 'toasts' })
    this.splatStatusLine = h('div', { class: 'splat-status', hidden: true })
    this.calibrateInput = h('input', {
      type: 'number',
      class: 'ctl-number',
      min: 20,
      max: 200,
      step: 1,
      value: 55,
    })

    this.element = h(
      'aside',
      { class: 'panel', id: 'panel' },
      this.header(),
      h(
        'div',
        { class: 'panel-scroll' },
        this.librarySection(),
        this.viewSection(),
        this.placementSection(),
        this.trackingSection(),
        this.calibrationSection(),
        this.debugSection(),
        this.footer(),
      ),
    )

    store.subscribe(() => this.syncScreenReadout())
    this.syncScreenReadout()
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  setLibrary(entries: LibraryEntry[]): void {
    this.entries = entries
    this.renderLibrary()
  }

  setActive(id: string | null): void {
    this.activeId = id
    // Toggle classes in place rather than re-rendering: rebuilding the list
    // would destroy the button the user just activated, dropping focus and
    // breaking keyboard navigation mid-selection.
    for (const [entryId, { row, pick }] of this.items) {
      const isActive = entryId === id
      row.classList.toggle('is-active', isActive)
      pick.setAttribute('aria-pressed', String(isActive))
    }
  }

  setTrackerStatus(status: TrackerStatus): void {
    this.statusDot.dataset['state'] = status.state
    this.statusDot.classList.toggle('is-face', status.state === 'running' && status.hasFace)
    this.statusText.textContent = STATE_LABEL[status.state]

    if (status.state === 'error' && status.error) {
      this.statusDetail.textContent = status.error
    } else if (status.state === 'running') {
      const distance = status.distanceM ? `${Math.round(status.distanceM * 100)} cm` : 'searching…'
      this.statusDetail.textContent = `${distance} · ${Math.round(status.detectFps)} fps`
    } else if (this.store.values.headSource === 'fixed') {
      this.statusDetail.textContent = 'Fixed viewpoint — the scene will not respond to you.'
    } else {
      this.statusDetail.textContent = 'Pointer parallax is active until you start the camera.'
    }

    this.cameraButton.textContent =
      status.state === 'running' || status.state === 'starting' ? 'Stop camera' : 'Start camera'
    this.cameraButton.disabled = status.state === 'starting'
  }

  /**
   * Loading progress and credit for the active capture. These are other
   * people's scans; the attribution is not optional decoration.
   */
  setSplatStatus(status: {
    state: 'loading' | 'ready' | 'error'
    progress: number | null
    error: string | null
    splatCount: number
    credit: string | null
    creditUrl: string | null
  }): void {
    const show = status.credit !== null
    this.splatStatusLine.hidden = !show
    if (!show) return

    const parts: (Node | string)[] = []
    if (status.state === 'loading') {
      const pct = status.progress === null ? '' : ` ${Math.round(status.progress * 100)}%`
      parts.push(h('span', { class: 'splat-loading' }, `Loading capture${pct}…`))
    } else if (status.state === 'error') {
      parts.push(h('span', { class: 'splat-error' }, status.error ?? 'Capture failed to load.'))
    } else if (status.splatCount) {
      parts.push(
        h('span', {}, `${(status.splatCount / 1000).toFixed(0)}k splats`),
      )
    }

    if (status.credit) {
      parts.push(
        status.creditUrl
          ? h(
              'a',
              { href: status.creditUrl, target: '_blank', rel: 'noreferrer noopener' },
              status.credit,
            )
          : h('span', {}, status.credit),
      )
    }
    this.splatStatusLine.replaceChildren(...parts)
  }

  toast(message: string, kind: 'info' | 'error' | 'success' = 'info'): void {
    const node = h('div', { class: `toast toast-${kind}` }, message)
    this.toasts.appendChild(node)
    window.setTimeout(() => {
      node.classList.add('is-leaving')
      window.setTimeout(() => node.remove(), 300)
    }, kind === 'error' ? 7000 : 3500)
  }

  // ── Sections ───────────────────────────────────────────────────────────────

  private header(): HTMLElement {
    return h(
      'header',
      { class: 'panel-header' },
      h(
        'div',
        { class: 'brand' },
        h('span', { class: 'brand-mark' }),
        h(
          'div',
          {},
          h('h1', {}, '3D Tracker'),
          h('p', {}, 'Head-tracked window'),
        ),
      ),
      h(
        'div',
        { class: 'status' },
        h('div', { class: 'status-line' }, this.statusDot, this.statusText),
        this.statusDetail,
      ),
      h(
        'div',
        { class: 'row' },
        this.cameraButton,
        h(
          'button',
          {
            type: 'button',
            class: 'btn',
            title: 'Fullscreen (F)',
            onclick: () => this.callbacks.onFullscreen(),
          },
          'Fullscreen',
        ),
      ),
    )
  }

  private librarySection(): HTMLElement {
    const fileInput = h('input', {
      type: 'file',
      multiple: true,
      accept: ACCEPT_ATTRIBUTE,
      class: 'visually-hidden',
      onchange: () => {
        const files = Array.from(fileInput.files ?? [])
        if (files.length) this.callbacks.onFiles(files)
        fileInput.value = ''
      },
    })

    const dropzone = h(
      'div',
      {
        class: 'dropzone',
        tabindex: 0,
        role: 'button',
        onclick: () => fileInput.click(),
        onkeydown: (event: KeyboardEvent) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            fileInput.click()
          }
        },
      },
      h('strong', {}, 'Upload a model'),
      h('span', {}, 'Drop files anywhere, or click to browse'),
      h('small', {}, '.glb .gltf .obj .fbx .stl .ply — include .bin and textures'),
    )

    const urlInput = h('input', {
      type: 'url',
      class: 'ctl-text',
      placeholder: 'https://…/capture.spz',
      spellcheck: false,
      onkeydown: (event: KeyboardEvent) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          submitUrl()
        }
      },
    })

    const submitUrl = (): void => {
      const url = urlInput.value.trim()
      if (!url) return
      this.callbacks.onSplatUrl(url)
      urlInput.value = ''
    }

    return section(
      'Library',
      true,
      this.libraryList,
      this.splatStatusLine,
      dropzone,
      fileInput,
      h(
        'div',
        { class: 'ctl' },
        h('span', { class: 'ctl-label' }, 'Load a capture by URL'),
        h(
          'div',
          { class: 'row' },
          urlInput,
          h('button', { type: 'button', class: 'btn btn-small', onclick: submitUrl }, 'Load'),
        ),
        h(
          'small',
          { class: 'ctl-hint' },
          'Any .spz, .ply, .splat or .ksplat Gaussian splat, served with CORS enabled.',
        ),
      ),
    )
  }

  private viewSection(): HTMLElement {
    const c = this.controls
    return section(
      'View',
      true,
      c.segmented({
        key: 'contentMode',
        label: 'Content',
        choices: [
          { value: 'window', label: 'Window', title: 'Everything stays behind the glass' },
          { value: 'popout', label: 'Pop-out', title: 'Let geometry cross the screen plane' },
        ],
        hint: 'Window mode clips anything in front of the screen plane.',
      }),
      c.slider({
        key: 'roomDepthM',
        label: 'Depth',
        min: 0.15,
        max: 3,
        step: 0.05,
        format: (v) => `${Math.round(v * 100)} cm`,
        hint: 'How far the world extends behind the screen.',
      }),
      c.slider({
        key: 'modelScale',
        label: 'Model scale',
        min: 0.1,
        max: 3,
        step: 0.05,
        format: (v) => `${v.toFixed(2)}×`,
      }),
      c.toggle({ key: 'autoRotate', label: 'Auto-rotate model' }),
      c.toggle({
        key: 'showRoom',
        label: 'Show frame & walls',
        hint: 'The window reveal and room walls. Turning them off costs you most of the near-field parallax.',
      }),
    )
  }

  private placementSection(): HTMLElement {
    const c = this.controls
    return section(
      'Placement',
      false,
      h(
        'p',
        { class: 'note' },
        'Seats a captured place in the window. Scans carry no agreed scale or up-axis, so a pasted URL almost always needs these.',
      ),
      c.logSlider({
        key: 'splatScale',
        label: 'Scale',
        min: 0.02,
        max: 50,
        format: (v) => (v >= 10 ? `${v.toFixed(1)}×` : `${v.toFixed(2)}×`),
      }),
      c.slider({
        key: 'splatYawDeg',
        label: 'Turn',
        min: -180,
        max: 180,
        step: 1,
        format: (v) => `${v.toFixed(0)}°`,
      }),
      c.slider({
        key: 'splatPitchDeg',
        label: 'Tilt',
        min: -90,
        max: 90,
        step: 1,
        format: (v) => `${v.toFixed(0)}°`,
      }),
      c.slider({
        key: 'splatHeightM',
        label: 'Height',
        min: -8,
        max: 8,
        step: 0.05,
        format: (v) => `${v.toFixed(2)} m`,
      }),
      c.slider({
        key: 'splatDistanceM',
        label: 'Distance',
        min: -20,
        max: 20,
        step: 0.1,
        format: (v) => `${v.toFixed(1)} m`,
      }),
      h(
        'button',
        {
          type: 'button',
          class: 'btn',
          onclick: () =>
            this.store.patch({
              splatScale: 1,
              splatYawDeg: 0,
              splatPitchDeg: 0,
              splatHeightM: 0,
              splatDistanceM: 0,
            }),
        },
        'Reset placement',
      ),
    )
  }

  private trackingSection(): HTMLElement {
    const c = this.controls
    return section(
      'Tracking',
      true,
      c.segmented({
        key: 'headSource',
        label: 'Head source',
        choices: [
          { value: 'camera', label: 'Camera' },
          { value: 'pointer', label: 'Pointer' },
          { value: 'fixed', label: 'Fixed' },
        ],
        hint: 'Pointer mode fakes a viewer with the mouse — handy for demos and screenshots.',
      }),
      c.segmented({
        key: 'poseSource',
        label: 'Estimator',
        choices: [
          { value: 'matrix', label: 'Face mesh', title: 'Rigid fit of the whole face mesh' },
          { value: 'iris', label: 'Iris', title: 'Back-project the two iris landmarks' },
        ],
        hint: 'Face mesh votes hundreds of landmarks into one pose and is much steadier. Iris uses two points and is easier to reason about.',
      }),
      c.slider({
        key: 'predictMs',
        label: 'Latency compensation',
        min: 0,
        max: 120,
        step: 5,
        format: (v) => (v === 0 ? 'off' : `${v.toFixed(0)} ms`),
        hint: 'Extrapolates your head forward to cancel pipeline lag. Too much overshoots when you change direction.',
      }),
      c.slider({
        key: 'parallaxGain',
        label: 'Parallax gain',
        min: 0.25,
        max: 3,
        step: 0.05,
        format: (v) => `${v.toFixed(2)}×`,
        hint: 'Above 1 exaggerates side-to-side movement. 1 is physically true.',
      }),
      c.slider({
        key: 'depthGain',
        label: 'Depth gain',
        min: 0.25,
        max: 3,
        step: 0.05,
        format: (v) => `${v.toFixed(2)}×`,
      }),
      c.slider({
        key: 'smoothMinCutoff',
        label: 'Smoothing',
        min: 0.1,
        max: 6,
        step: 0.05,
        format: (v) => v.toFixed(2),
        hint: 'Lower is smoother when still; raise it if tracking feels laggy.',
      }),
      c.slider({
        key: 'smoothBeta',
        label: 'Responsiveness',
        min: 0,
        max: 0.3,
        step: 0.005,
        format: (v) => v.toFixed(3),
        hint: 'How aggressively smoothing backs off during fast movement.',
      }),
      c.segmented({
        key: 'delegate',
        label: 'Inference',
        choices: [
          { value: 'GPU', label: 'GPU' },
          { value: 'CPU', label: 'CPU' },
        ],
        hint: 'Takes effect on the next camera start.',
      }),
      c.slider({
        key: 'trackFps',
        label: 'Detect rate',
        min: 15,
        max: 120,
        step: 5,
        format: (v) => `${v} fps`,
      }),
    )
  }

  private calibrationSection(): HTMLElement {
    const c = this.controls
    return section(
      'Calibration',
      false,
      h(
        'p',
        { class: 'note' },
        'The illusion is geometry, not guesswork: it only lines up if the app knows how big your screen is and where the webcam sits.',
      ),
      c.slider({
        key: 'screenDiagonalIn',
        label: 'Screen diagonal',
        min: 9,
        max: 60,
        step: 0.1,
        format: (v) => `${v.toFixed(1)}"`,
      }),
      this.screenReadout,
      c.toggle({ key: 'manualScreenSize', label: 'Enter width/height manually' }),
      c.number({ key: 'screenWidthMm', label: 'Screen width', suffix: 'mm', min: 50, step: 1 }),
      c.number({ key: 'screenHeightMm', label: 'Screen height', suffix: 'mm', min: 50, step: 1 }),
      c.number({
        key: 'cameraBezelMm',
        label: 'Camera above screen',
        suffix: 'mm',
        min: -200,
        step: 1,
        hint: 'Distance from the top edge of the picture to the webcam lens.',
      }),
      c.number({ key: 'cameraOffsetXMm', label: 'Camera offset X', suffix: 'mm', step: 1 }),
      c.number({
        key: 'ipdMm',
        label: 'Your eye spacing',
        suffix: 'mm',
        min: 45,
        max: 80,
        step: 0.5,
        hint: 'Used by the iris estimator only.',
      }),
      c.slider({
        key: 'focalNorm',
        label: 'Webcam focal length',
        min: 0.4,
        max: 2,
        step: 0.005,
        format: (v) => v.toFixed(3),
        hint: 'Iris estimator only. Use the measurement below rather than guessing.',
      }),
      h(
        'div',
        { class: 'ctl ctl-inline' },
        h('span', { class: 'ctl-label' }, 'Measure at'),
        h(
          'span',
          { class: 'ctl-field' },
          this.calibrateInput,
          h('span', { class: 'ctl-suffix' }, 'cm'),
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-small',
              onclick: () => this.callbacks.onCalibrate(Number(this.calibrateInput.value)),
            },
            'Set',
          ),
        ),
        h(
          'small',
          { class: 'ctl-hint' },
          'Sit at that exact distance with the camera running, then press Set. This solves whichever single scale factor the active estimator needs.',
        ),
      ),
      c.segmented({
        key: 'canvasPlacement',
        label: 'Canvas position',
        choices: [
          { value: 'auto', label: 'Auto' },
          { value: 'fill-screen', label: 'Fills screen' },
        ],
        hint: 'Auto locates the browser window on the display. Switch to "Fills screen" if the geometry looks offset in fullscreen.',
      }),
      c.toggle({
        key: 'mirrorCamera',
        label: 'Mirror camera',
        hint: 'Turn this off if the scene moves the wrong way when you lean.',
      }),
    )
  }

  private debugSection(): HTMLElement {
    const c = this.controls
    return section(
      'Debug',
      false,
      c.toggle({ key: 'showDebug', label: 'Show tracking overlay' }),
      c.toggle({ key: 'showVideo', label: 'Show camera preview' }),
      c.toggle({ key: 'showStats', label: 'Show frame stats' }),
      c.slider({
        key: 'nearM',
        label: 'Near plane',
        min: 0.005,
        max: 0.2,
        step: 0.005,
        format: (v) => `${(v * 100).toFixed(1)} cm`,
      }),
      c.slider({
        key: 'farM',
        label: 'Far plane',
        min: 2,
        max: 200,
        step: 1,
        format: (v) => `${v.toFixed(0)} m`,
      }),
      h(
        'button',
        { type: 'button', class: 'btn btn-danger', onclick: () => this.callbacks.onReset() },
        'Reset all settings',
      ),
    )
  }

  private footer(): HTMLElement {
    const keys: [string, string][] = [
      ['H', 'hide panel'],
      ['F', 'fullscreen'],
      ['C', 'toggle camera'],
      ['D', 'debug overlay'],
      ['P', 'pointer / camera'],
      ['WASD', 'drive (arena)'],
    ]
    return h(
      'footer',
      { class: 'panel-footer' },
      h(
        'dl',
        { class: 'shortcuts' },
        ...keys.flatMap(([key, label]) => [h('dt', {}, h('kbd', {}, key)), h('dd', {}, label)]),
      ),
    )
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  private renderLibrary(): void {
    clear(this.libraryList)
    this.items.clear()
    const groups = new Map<string, LibraryEntry[]>()
    for (const entry of this.entries) {
      const list = groups.get(entry.group) ?? []
      list.push(entry)
      groups.set(entry.group, list)
    }

    for (const [group, items] of groups) {
      this.libraryList.appendChild(h('h3', { class: 'library-group' }, group))
      for (const entry of items) {
        this.libraryList.appendChild(this.libraryItem(entry))
      }
    }
  }

  private libraryItem(entry: LibraryEntry): HTMLElement {
    const isActive = entry.id === this.activeId
    const pick = h(
      'button',
      {
        type: 'button',
        class: 'library-pick',
        'aria-pressed': String(isActive),
        onclick: () => this.callbacks.onSelect(entry.id),
      },
      h(
        'span',
        { class: 'library-title' },
        entry.name,
        entry.badge ? h('span', { class: 'badge' }, entry.badge) : null,
      ),
      h('span', { class: 'library-desc' }, entry.description),
    )

    const row = h(
      'div',
      { class: `library-item${isActive ? ' is-active' : ''}` },
      pick,
      entry.removable
        ? h(
            'button',
            {
              type: 'button',
              class: 'library-remove',
              title: `Remove ${entry.name}`,
              'aria-label': `Remove ${entry.name}`,
              onclick: () => this.callbacks.onRemove(entry.id),
            },
            '×',
          )
        : null,
    )

    this.items.set(entry.id, { row, pick })
    return row
  }

  private syncScreenReadout(): void {
    const { widthM, heightM } = physicalScreenSize(this.store.values)
    this.screenReadout.textContent = `≈ ${Math.round(widthM * 1000)} × ${Math.round(heightM * 1000)} mm of picture`
  }

  private toggleCamera(): void {
    const label = this.cameraButton.textContent ?? ''
    if (label.startsWith('Stop')) this.callbacks.onStopCamera()
    else this.callbacks.onStartCamera()
  }
}

function section(title: string, open: boolean, ...children: (Node | null)[]): HTMLElement {
  return h(
    'details',
    { class: 'section', open },
    h('summary', {}, title),
    h('div', { class: 'section-body' }, ...children),
  )
}
