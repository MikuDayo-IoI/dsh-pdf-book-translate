import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Persistent translation memory.
 *
 * `.translate-cache.json` stays a plain `{ "sha256": "译文" }` map for
 * portability. Every completed paragraph is also appended immediately to
 * `.translate-cache.jsonl`, so a hard kill between batch flushes loses nothing.
 * The journal is compacted into the JSON map after every batch and truncated
 * once that atomic write succeeds.
 */
export class TranslationCache {
  private map = new Map<string, string>()
  private readonly journalPath: string | null
  private writeQueue: Promise<void> = Promise.resolve()
  private journalQueue: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string | null) {
    this.journalPath = filePath === null ? null : `${filePath}l`
  }

  key(text: string, langPair: string): string {
    return createHash('sha256').update(`${langPair}\u0000${text}`).digest('hex')
  }

  get(key: string): string | undefined {
    return this.map.get(key)
  }

  get size(): number {
    return this.map.size
  }

  /** Adds one translated paragraph durably before returning. */
  async put(key: string, text: string): Promise<void> {
    this.map.set(key, text)
    if (this.journalPath === null) return
    const line = JSON.stringify({ k: key, v: text }) + '\n'
    const run = async (): Promise<void> => {
      await mkdir(dirname(this.journalPath!), { recursive: true })
      await appendFile(this.journalPath!, line, 'utf8')
    }
    this.journalQueue = this.journalQueue.then(run, run)
    await this.journalQueue
  }

  async load(): Promise<void> {
    if (this.filePath === null) return
    this.map = new Map()
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as unknown
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === 'string') this.map.set(k, v)
        }
      }
    } catch {
      // Missing/corrupt cache is simply an empty cache.
    }
    if (this.journalPath === null) return
    try {
      const raw = await readFile(this.journalPath, 'utf8')
      for (const line of raw.split(/\r?\n/)) {
        if (line.trim() === '') continue
        try {
          const entry = JSON.parse(line) as { k?: unknown; v?: unknown }
          if (typeof entry.k === 'string' && typeof entry.v === 'string') {
            this.map.set(entry.k, entry.v)
          }
        } catch {
          // A torn final line after SIGKILL is expected; ignore just that line.
        }
      }
    } catch {
      // No journal yet.
    }
  }

  /** Atomically materializes the complete map, then compacts the journal. */
  async save(): Promise<void> {
    if (this.filePath === null) return
    const entries = Object.fromEntries(this.map)
    const snapshot = JSON.stringify(entries, null, 2)
    const run = async (): Promise<void> => {
      await mkdir(dirname(this.filePath!), { recursive: true })
      const temp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
      await writeFile(temp, snapshot, 'utf8')
      await rename(temp, this.filePath!)
      await this.compactJournal(entries)
    }
    this.writeQueue = this.writeQueue.then(run, run)
    await this.writeQueue
  }

  /**
   * Drops journal entries already covered by the snapshot, but keeps anything
   * appended after the snapshot was taken. Truncating unconditionally loses a
   * paragraph if a concurrent batch completes between JSON write and truncate.
   */
  private async compactJournal(snapshot: Record<string, string>): Promise<void> {
    if (this.journalPath === null) return
    const run = async (): Promise<void> => {
      let raw = ''
      try {
        raw = await readFile(this.journalPath!, 'utf8')
      } catch {
        return
      }
      const kept: string[] = []
      for (const line of raw.split(/\r?\n/)) {
        if (line.trim() === '') continue
        try {
          const entry = JSON.parse(line) as { k?: unknown; v?: unknown }
          if (
            typeof entry.k === 'string' &&
            typeof entry.v === 'string' &&
            snapshot[entry.k] === entry.v
          ) {
            continue
          }
        } catch {
          // Keep a torn line; load() ignores it and the next save will drop it.
        }
        kept.push(line)
      }
      const temp = `${this.journalPath}.${process.pid}.${Date.now()}.tmp`
      await writeFile(temp, kept.length === 0 ? '' : `${kept.join('\n')}\n`, 'utf8')
      await rename(temp, this.journalPath!)
    }
    this.journalQueue = this.journalQueue.then(run, run)
    await this.journalQueue
  }
}

export function cacheJournalPath(cachePath: string): string {
  return `${cachePath}l`
}
