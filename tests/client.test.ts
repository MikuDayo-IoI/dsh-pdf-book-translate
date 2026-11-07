import { describe, expect, it, vi } from 'vitest'
import { apply, inject, type ClientContext } from '../src/client/index.js'
import { enDict, zhDict } from '../src/client/locales.js'
import {
  resetSettings,
  saveSettings,
  settingsValue,
  stageDiff,
  stagedFromScope,
  type ConfigForm,
  type SettingsSnapshot,
} from '../src/client/model.js'

const fieldNames = [
  'apiKey',
  'baseUrl',
  'model',
  'hostProvider',
  'hostModel',
  'langPair',
  'termbasePath',
  'concurrency',
  'maxRetries',
  'timeoutMs',
  'pythonBin',
]

function fakeForm(
  snapshot: SettingsSnapshot = { status: 'ready', value: {}, base: {}, user: {}, writable: true, revision: 3 },
  mutate = vi.fn(async () => true),
): ConfigForm & { mutate: ReturnType<typeof vi.fn> } {
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    mutate,
    dispose: () => {},
  }
}

describe('client settings model', () => {
  it('stages string and numeric form values as text', () => {
    const staged = stagedFromScope({
      value: { apiKey: 'k', concurrency: 4, enabled: true, nested: {} },
      base: { concurrency: 6 },
      user: {},
    })

    expect(staged).toEqual({ apiKey: 'k', concurrency: '4' })
  })

  it('keeps only staged values that differ from the base layer', () => {
    expect(stageDiff(
      { apiKey: 'k', concurrency: 4 },
      { apiKey: undefined, concurrency: 6 },
    )).toEqual({ apiKey: 'k', concurrency: '4' })
  })

  it('omits unsupported values and fields equal to the base layer', () => {
    expect(stageDiff(
      { apiKey: 'k', concurrency: 4, enabled: true, nested: {} },
      { apiKey: 'k', concurrency: '4' },
    )).toEqual({})
  })

  it('converts configured numeric fields to finite numbers while retaining text values', () => {
    expect(settingsValue('concurrency', '4')).toBe(4)
    expect(settingsValue('maxRetries', '2.5')).toBe(2.5)
    expect(settingsValue('timeoutMs', '1000')).toBe(1000)
    expect(settingsValue('baseUrl', 'https://api.example.test')).toBe('https://api.example.test')
  })

  it('refuses empty and non-finite numeric drafts', () => {
    expect(settingsValue('concurrency', '')).toBeUndefined()
    expect(settingsValue('maxRetries', 'Infinity')).toBeUndefined()
    expect(settingsValue('timeoutMs', 'not-a-number')).toBeUndefined()
  })
})

describe('settings.pdfBookTranslate 双语词典', () => {
  it('zh 与 en 键集合完全一致（locale 运行时要求双语平衡）', () => {
    const zhKeys = Object.keys(zhDict).sort()
    const enKeys = Object.keys(enDict).sort()
    expect(zhKeys).toEqual(enKeys)
    expect(zhKeys.length).toBeGreaterThan(10)
  })

  it('每个键在两种语言下都有非空文案', () => {
    for (const key of Object.keys(zhDict)) {
      expect(zhDict[key as keyof typeof zhDict]?.trim().length ?? 0).toBeGreaterThan(0)
      expect(enDict[key as keyof typeof enDict]?.trim().length ?? 0).toBeGreaterThan(0)
    }
  })
})

describe('PDF Book Translation settings card actions', () => {
  it('saves numeric draft fields and text overrides in one mutation', async () => {
    const form = fakeForm()
    const snapshot = form.getSnapshot()

    const result = await saveSettings(
      form,
      { concurrency: '4', baseUrl: 'https://api.example.test' },
      snapshot,
      fieldNames,
    )

    expect(result).toEqual({ ok: true, changed: 2 })
    expect(form.mutate).toHaveBeenCalledWith([
      { op: 'set', path: ['baseUrl'], value: 'https://api.example.test' },
      { op: 'set', path: ['concurrency'], value: 4 },
    ], 3)
  })

  it('does not write invalid numeric drafts', async () => {
    const form = fakeForm()

    const result = await saveSettings(
      form,
      { concurrency: '', maxRetries: 'Infinity', timeoutMs: 'bad' },
      form.getSnapshot(),
      fieldNames,
    )

    expect(result).toEqual({ ok: false, changed: 0, invalid: ['maxRetries', 'timeoutMs'] })
    expect(form.mutate).not.toHaveBeenCalled()
  })

  it('has nothing to write when every draft equals the deployment default', async () => {
    const form = fakeForm({
      status: 'ready',
      value: { concurrency: 6 },
      base: { concurrency: 6, apiKey: '' },
      user: {},
      writable: true,
      revision: 4,
    })

    const result = await saveSettings(form, { concurrency: '6', apiKey: '' }, form.getSnapshot(), fieldNames)

    expect(result).toEqual({ ok: true, changed: 0 })
    expect(form.mutate).not.toHaveBeenCalled()
  })

  it('does not overwrite a configured secret when its draft is blank', async () => {
    const form = fakeForm({
      status: 'ready',
      value: { baseUrl: 'https://api.deepseek.com' },
      base: { baseUrl: 'https://api.deepseek.com' },
      user: { apiKey: 'old-secret' },
      secrets: [{ path: ['apiKey'], set: true }],
      writable: true,
      revision: 2,
    })

    const result = await saveSettings(form, { apiKey: '' }, form.getSnapshot(), fieldNames)

    expect(result).toEqual({ ok: true, changed: 0 })
    expect(form.mutate).not.toHaveBeenCalled()
  })

  it('resets every configurable field in one mutation', async () => {
    const form = fakeForm()

    const ok = await resetSettings(form, form.getSnapshot(), fieldNames)

    expect(ok).toBe(true)
    expect(form.mutate).toHaveBeenCalledWith(
      fieldNames.map(field => ({ op: 'unset', path: [field] })),
      3,
    )
  })
})

describe('客户端插件挂载', () => {
  it('injects the configForms service and registers only the bundle config slot', () => {
    expect(inject).toEqual(['slots', 'locale', 'configForms'])

    const registered: { name: string; key: string }[] = []
    const form = fakeForm()
    const getForm = vi.fn(() => form)
    const ctx = {
      configForms: { get: getForm },
      locale: {
        register: () => () => {},
        bind: () => (key: string) => key,
        getSnapshot: () => ({ active: 'zh', revision: 0 }),
        subscribe: () => () => {},
      },
      slots: {
        inject: (_name: string, factory: () => unknown) => factory(),
        register: (options: { name: string; key: string }) => {
          registered.push({ name: options.name, key: options.key })
          return () => {}
        },
      },
      effect: (fn: () => () => void) => { fn() },
    } as unknown as ClientContext

    apply(ctx)

    expect(getForm).toHaveBeenCalledWith('pdf-book-translate')
    expect(registered).toEqual([{
      name: 'plugins.bundle.config',
      key: 'dsh-pdf-book-translate',
    }])
  })
})
