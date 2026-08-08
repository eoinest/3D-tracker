import type { Settings, SettingsStore } from '../core/settings'
import { h } from './dom'

/**
 * Form controls wired directly to the settings store.
 *
 * Each control both writes on input and re-reads on external change, so a
 * "Reset" or a keyboard shortcut updates the widgets without any extra
 * bookkeeping at the call sites.
 */
export class ControlFactory {
  private refresh: (() => void)[] = []

  constructor(private readonly store: SettingsStore) {
    store.subscribe(() => {
      for (const fn of this.refresh) fn()
    })
  }

  slider(options: {
    key: NumericKey
    label: string
    min: number
    max: number
    step: number
    hint?: string
    /** Formats the value shown next to the label. */
    format?: (value: number) => string
  }): HTMLElement {
    const { key, label, min, max, step, hint, format = (v) => v.toFixed(2) } = options
    const readout = h('output', { class: 'ctl-value' })
    const input = h('input', {
      type: 'range',
      min,
      max,
      step,
      oninput: () => this.store.set(key, Number(input.value) as Settings[NumericKey]),
    })

    const sync = (): void => {
      const value = this.store.values[key]
      input.value = String(value)
      readout.textContent = format(value)
    }
    this.refresh.push(sync)
    sync()

    return h(
      'label',
      { class: 'ctl ctl-slider' },
      h('span', { class: 'ctl-head' }, h('span', { class: 'ctl-label' }, label), readout),
      input,
      hint ? h('small', { class: 'ctl-hint' }, hint) : null,
    )
  }

  number(options: {
    key: NumericKey
    label: string
    min?: number
    max?: number
    step?: number
    suffix?: string
    hint?: string
  }): HTMLElement {
    const { key, label, min, max, step = 1, suffix, hint } = options
    const input = h('input', {
      type: 'number',
      class: 'ctl-number',
      min,
      max,
      step,
      onchange: () => {
        const parsed = Number(input.value)
        if (Number.isFinite(parsed)) this.store.set(key, parsed as Settings[NumericKey])
      },
    })

    const sync = (): void => {
      input.value = String(round(this.store.values[key], 3))
    }
    this.refresh.push(sync)
    sync()

    return h(
      'label',
      { class: 'ctl ctl-inline' },
      h('span', { class: 'ctl-label' }, label),
      h('span', { class: 'ctl-field' }, input, suffix ? h('span', { class: 'ctl-suffix' }, suffix) : null),
      hint ? h('small', { class: 'ctl-hint' }, hint) : null,
    )
  }

  toggle(options: { key: BooleanKey; label: string; hint?: string }): HTMLElement {
    const { key, label, hint } = options
    const input = h('input', {
      type: 'checkbox',
      onchange: () => this.store.set(key, input.checked as Settings[BooleanKey]),
    })

    const sync = (): void => {
      input.checked = this.store.values[key]
    }
    this.refresh.push(sync)
    sync()

    return h(
      'label',
      { class: 'ctl ctl-toggle' },
      input,
      h('span', { class: 'ctl-switch' }),
      h('span', { class: 'ctl-label' }, label),
      hint ? h('small', { class: 'ctl-hint' }, hint) : null,
    )
  }

  segmented<K extends keyof Settings>(options: {
    key: K
    label: string
    choices: { value: Settings[K]; label: string; title?: string }[]
    hint?: string
  }): HTMLElement {
    const { key, label, choices, hint } = options
    const buttons = choices.map((choice) =>
      h(
        'button',
        {
          type: 'button',
          class: 'seg-item',
          title: choice.title ?? choice.label,
          onclick: () => this.store.set(key, choice.value),
        },
        choice.label,
      ),
    )

    const sync = (): void => {
      const current = this.store.values[key]
      buttons.forEach((button, i) => {
        button.classList.toggle('is-active', Object.is(choices[i]?.value, current))
      })
    }
    this.refresh.push(sync)
    sync()

    return h(
      'div',
      { class: 'ctl ctl-segmented' },
      h('span', { class: 'ctl-label' }, label),
      h('div', { class: 'seg' }, ...buttons),
      hint ? h('small', { class: 'ctl-hint' }, hint) : null,
    )
  }

  /** Re-runs every control's sync — used after a bulk external change. */
  syncAll(): void {
    for (const fn of this.refresh) fn()
  }
}

type NumericKey = {
  [K in keyof Settings]: Settings[K] extends number ? K : never
}[keyof Settings]

type BooleanKey = {
  [K in keyof Settings]: Settings[K] extends boolean ? K : never
}[keyof Settings]

function round(value: number, digits: number): number {
  const f = 10 ** digits
  return Math.round(value * f) / f
}
