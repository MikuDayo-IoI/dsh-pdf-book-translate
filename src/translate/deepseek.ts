import { parseBatchResponse } from './prompts.js'

export type ErrorKind = 'rate-limit' | 'server' | 'timeout' | 'auth' | 'network' | 'invalid-response'

export class DeepSeekError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'DeepSeekError'
  }
}

export function classifyError(e: unknown): ErrorKind {
  if (e instanceof DeepSeekError) {
    if (e.status === 429) return 'rate-limit'
    if (e.status === 401 || e.status === 403) return 'auth'
    if (e.status !== undefined && e.status >= 500) return 'server'
    return 'invalid-response'
  }
  const msg = e instanceof Error ? e.message : String(e)
  if (/timeout|abort/i.test(msg)) return 'timeout'
  return 'network'
}

export interface DeepSeekConfig {
  apiKey: string
  baseUrl: string
  model: string
  timeoutMs: number
  maxRetries: number
  retryBaseMs?: number
}

export interface ChatMessage {
  role: 'system' | 'user'
  content: string
}

export interface BatchInput {
  paragraphs: { id: number; text: string }[]
  systemPrompt?: string
}

export interface BatchOutput {
  translations: Map<number, string>
  usage: { promptTokens: number; completionTokens: number }
}

export interface ChatOutput {
  content: string
  usage: { promptTokens: number; completionTokens: number }
}

export class DeepSeekClient {
  constructor(
    private readonly config: DeepSeekConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async translateBatch(input: BatchInput, signal: AbortSignal): Promise<BatchOutput> {
    const { content, usage } = await this.chat([
      {
        role: 'system',
        content: input.systemPrompt ?? '你是文档翻译引擎。仅返回 JSON，键为段落 id（数字），值为译文。',
      },
      {
        role: 'user',
        content: JSON.stringify(input.paragraphs.map(p => ({ id: String(p.id), text: p.text }))),
      },
    ], signal, true)
    const translations = parseBatchResponse(content, input.paragraphs.map(p => p.id))
    return {
      translations,
      usage: { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens },
    }
  }

  async complete(system: string, user: string, signal: AbortSignal): Promise<ChatOutput> {
    return this.chat([
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], signal, false)
  }

  private async chat(messages: ChatMessage[], signal: AbortSignal, jsonMode: boolean): Promise<ChatOutput> {
    const { apiKey, baseUrl, model, timeoutMs, maxRetries } = this.config
    const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`
    const body: Record<string, unknown> = { model, messages }
    if (jsonMode) body.response_format = { type: 'json_object' }

    let lastError: unknown
    let retryAfterMs = 0
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (signal.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new DOMException('aborted', 'AbortError')
      }
      if (attempt > 0) {
        const base = this.config.retryBaseMs ?? 500
        await new Promise(r => setTimeout(r, Math.max(base * 2 ** (attempt - 1) + Math.random() * 100, retryAfterMs)))
      }
      try {
        const controller = new AbortController()
        const timeoutError = new Error(`request timeout after ${timeoutMs}ms`)
        let timer: ReturnType<typeof setTimeout> | undefined
        let resp: Response
        try {
          resp = await Promise.race([
            this.fetchImpl(url, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${apiKey}`,
              },
              body: JSON.stringify(body),
              signal: AbortSignal.any([signal, controller.signal]),
            }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                reject(timeoutError)
                controller.abort()
              }, timeoutMs)
            }),
          ])
        } finally {
          clearTimeout(timer)
        }
        if (resp.status === 429 || resp.status >= 500) {
          const detail = await resp.text().catch(() => '')
          if (resp.status === 429) {
            const ra = Number(resp.headers.get('retry-after'))
            if (Number.isFinite(ra) && ra > 0) retryAfterMs = Math.max(retryAfterMs, ra * 1000)
          }
          lastError = new DeepSeekError(
            `http ${resp.status}${detail ? `: ${detail.trim().slice(0, 200)}` : ''}`,
            resp.status,
          )
          continue
        }
        if (resp.status === 401 || resp.status === 403) {
          throw new DeepSeekError(`auth failed: ${resp.status}`, resp.status)
        }
        if (!resp.ok) throw new DeepSeekError(`http ${resp.status}`, resp.status)
        let data: {
          choices?: { message?: { content?: string } }[]
          usage?: { prompt_tokens?: number; completion_tokens?: number }
        }
        try {
          data = (await resp.json()) as typeof data
        } catch {
          throw new DeepSeekError('invalid response: body is not JSON')
        }
        const content = data.choices?.[0]?.message?.content
        if (content === undefined || content.trim() === '') {
          throw new DeepSeekError('empty response content')
        }
        return {
          content,
          usage: {
            promptTokens: data.usage?.prompt_tokens ?? 0,
            completionTokens: data.usage?.completion_tokens ?? 0,
          },
        }
      } catch (e) {
        if (signal.aborted) {
          throw signal.reason instanceof Error ? signal.reason : new DOMException('aborted', 'AbortError')
        }
        lastError = e
        const kind = classifyError(e)
        if (kind !== 'rate-limit' && kind !== 'server' && kind !== 'timeout') throw e
      }
    }
    throw lastError
  }
}
