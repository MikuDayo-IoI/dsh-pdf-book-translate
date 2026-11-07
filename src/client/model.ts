export interface SettingsSecret {
  path: readonly string[]
  set: boolean
}

/**
 * A client-safe copy of one Host configuration entry, as exposed by the
 * `configForms` client service. Secret values are never included in `value`;
 * `secrets` reports whether each secret is configured.
 */
export interface SettingsSnapshot {
  status?: string
  value?: Record<string, unknown>
  base?: Record<string, unknown>
  user?: Record<string, unknown>
  secrets?: readonly SettingsSecret[]
  revision?: number
  writable?: boolean
}

export type ConfigOp =
  | { op: 'set'; path: string[]; value: unknown }
  | { op: 'unset'; path: string[] }

/** The subset of the Host-owned configuration form used by this card. */
export interface ConfigForm {
  getSnapshot(): SettingsSnapshot
  subscribe(listener: () => void): () => void
  mutate(ops: readonly ConfigOp[], expectedRevision?: number): Promise<boolean>
  dispose?(): void | Promise<void>
}

export type SettingsSaveResult =
  | { ok: true; changed: number }
  | { ok: false; changed: 0; invalid: string[] }

const numericFields = new Set(['concurrency', 'maxRetries', 'timeoutMs'])

function asText(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined
}

export function stagedFromScope(scope: SettingsSnapshot): Record<string, string> {
  return Object.fromEntries(
    Object.entries(scope.value ?? {}).flatMap(([field, value]) => {
      const text = asText(value)
      return text === undefined ? [] : [[field, text]]
    }),
  )
}

/**
 * Converts a staged text value only at the settings write boundary.
 * Numeric fields reject empty and non-finite drafts so NaN never reaches the Host.
 */
export function settingsValue(field: string, value: string): string | number | undefined {
  if (!numericFields.has(field)) return value
  if (value.trim() === '') return undefined

  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : undefined
}

export function stageDiff(
  staged: Record<string, unknown>,
  base: Record<string, unknown>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(staged).flatMap(([field, value]) => {
      const text = asText(value)
      return text === undefined || text === asText(base[field]) ? [] : [[field, text]]
    }),
  )
}

/**
 * Build one atomic settings mutation from the staged text, clearing fields whose
 * draft equals the deployment default. An untouched secret is represented by an
 * empty draft and is never overwritten with an empty string.
 */
export async function saveSettings(
  form: Pick<ConfigForm, 'mutate'>,
  staged: Record<string, string>,
  snapshot: SettingsSnapshot,
  fields: readonly string[],
): Promise<SettingsSaveResult> {
  // Built as one atomic mutation so a failed write never leaves half a form
  // committed (the Host validates and applies the whole op list).
  const base = snapshot.base ?? {}
  const user = snapshot.user ?? {}
  const secretSet = new Set(
    (snapshot.secrets ?? []).filter(secret => secret.set).map(secret => secret.path[0]),
  )
  const ops: ConfigOp[] = []
  const invalid: string[] = []

  for (const field of fields) {
    if (!(field in staged)) continue
    const text = staged[field] ?? ''
    if (field === 'apiKey' && text.trim() === '' && secretSet.has(field)) continue

    const typedValue = settingsValue(field, text)
    if (numericFields.has(field) && text.trim() !== '' && typedValue === undefined) {
      invalid.push(field)
      continue
    }
    if (numericFields.has(field) && text.trim() === '') {
      if (field in user) ops.push({ op: 'unset', path: [field] })
      continue
    }

    if (text === asText(base[field])) {
      if (field in user) ops.push({ op: 'unset', path: [field] })
      continue
    }
    if (text === '' && !(field in base) && !(field in user)) continue
    ops.push({ op: 'set', path: [field], value: typedValue })
  }

  if (invalid.length > 0) return { ok: false, changed: 0, invalid }
  if (ops.length === 0) return { ok: true, changed: 0 }

  const ok = await form.mutate(ops, snapshot.revision)
  return ok
    ? { ok: true, changed: ops.length }
    : { ok: false, changed: 0, invalid: [] }
}

/** Clear every configurable field, restoring deployment defaults. */
export function resetSettings(
  form: Pick<ConfigForm, 'mutate'>,
  snapshot: SettingsSnapshot,
  fields: readonly string[],
): Promise<boolean> {
  const ops: ConfigOp[] = fields.map(field => ({ op: 'unset', path: [field] }))
  return form.mutate(ops, snapshot.revision)
}
