import type { Context } from '@deepseek-ai/cordis'
import { DeepSeekClient, DeepSeekError } from './deepseek.js'
import { buildSummaryPrompt, parseBatchResponse } from './prompts.js'

export interface EngineConfig {
  apiKey?: string
  baseUrl: string
  model: string
  hostProvider?: string
  hostModel?: string
  maxRetries: number
  timeoutMs: number
}

export interface TranslateInput {
  paragraphs: { id: number; text: string }[]
  systemPrompt: string
}

export interface TranslateOutput {
  translations: Map<number, string>
  usage: { promptTokens: number; completionTokens: number }
}

export interface SummaryInput {
  chapterTitle: string
  pages: string
  sampleText: string
  langPair: string
}

export interface TranslationEngine {
  readonly id: string
  translateBatch(input: TranslateInput, signal: AbortSignal): Promise<TranslateOutput>
  summarize(input: SummaryInput, signal: AbortSignal): Promise<{ text: string; usage: { promptTokens: number; completionTokens: number } }>
}

interface HostChunk {
  type?: string
  text?: string
  block?: { type?: string; text?: string }
  usage?: { inputTokens?: number; outputTokens?: number }
  reason?: { kind?: string; failure?: { message?: string; code?: string } }
}

interface HostLlm {
  stream(options: Record<string, unknown>): AsyncIterable<HostChunk>
}

interface DefaultModel {
  currentSelection(): { provider?: string; model?: string } | undefined
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('aborted', 'AbortError')
}

class OpenAiEngine implements TranslationEngine {
  private readonly client: DeepSeekClient
  readonly id: string

  constructor(private readonly config: EngineConfig) {
    this.client = new DeepSeekClient({
      apiKey: config.apiKey ?? '',
      baseUrl: config.baseUrl,
      model: config.model,
      timeoutMs: config.timeoutMs,
      maxRetries: config.maxRetries,
    })
    this.id = `openai-compatible:${config.model}`
  }

  async translateBatch(input: TranslateInput, signal: AbortSignal): Promise<TranslateOutput> {
    let lastError: unknown
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      if (signal.aborted) throw abortError(signal)
      try {
        return await this.client.translateBatch(
          { paragraphs: input.paragraphs, systemPrompt: input.systemPrompt },
          signal,
        )
      } catch (e) {
        if (signal.aborted) throw abortError(signal)
        if (e instanceof DeepSeekError && (e.status === 401 || e.status === 403)) throw e
        lastError = e
        if (attempt < this.config.maxRetries) await sleep(400 * 2 ** attempt)
      }
    }
    throw lastError
  }

  async summarize(input: SummaryInput, signal: AbortSignal): Promise<{ text: string; usage: { promptTokens: number; completionTokens: number } }> {
    const prompt = buildSummaryPrompt(input.chapterTitle, input.pages, input.sampleText, input.langPair)
    const result = await this.client.complete(prompt.system, prompt.user, signal)
    return {
      text: result.content.trim(),
      usage: { promptTokens: result.usage.promptTokens, completionTokens: result.usage.completionTokens },
    }
  }
}

class HostEngine implements TranslationEngine {
  readonly id: string
  private readonly provider: string
  private readonly model: string

  constructor(
    private readonly llm: HostLlm,
    selection: { provider?: string; model?: string } | undefined,
    private readonly config: EngineConfig,
  ) {
    this.provider = config.hostProvider?.trim() || selection?.provider || ''
    this.model = config.hostModel?.trim() || selection?.model || ''
    if (this.provider === '' || this.model === '') {
      throw new Error('Host LLM 未就绪：请先选择会话默认模型，或在插件设置里填写 hostProvider/hostModel，或填写 API Key 使用 OpenAI 兼容接口。')
    }
    this.id = `host:${this.provider}/${this.model}`
  }

  private async complete(system: string, user: string, signal: AbortSignal): Promise<{ text: string; usage: { promptTokens: number; completionTokens: number } }> {
    let text = ''
    let sawDelta = false
    let inputTokens = 0
    let outputTokens = 0
    let finish: HostChunk['reason'] | undefined
    const stream = this.llm.stream({
      provider: this.provider,
      model: this.model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      signal,
    })
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        text += chunk.text
        sawDelta = true
      } else if (chunk.type === 'block-end' && !sawDelta && chunk.block?.type === 'text' && typeof chunk.block.text === 'string') {
        text += chunk.block.text
      } else if (chunk.type === 'usage' && chunk.usage !== undefined) {
        inputTokens += chunk.usage.inputTokens ?? 0
        outputTokens += chunk.usage.outputTokens ?? 0
      } else if (chunk.type === 'finish') {
        finish = chunk.reason
      }
    }
    if (finish === undefined) throw new Error('Host LLM stream ended without finish chunk')
    if (finish.kind === 'aborted') throw abortError(signal)
    if (finish.kind !== 'stop') {
      throw new Error(`Host LLM 调用失败（${finish.kind ?? 'error'}）：${finish.failure?.message ?? finish.failure?.code ?? 'no detail'}`)
    }
    if (text.trim() === '') throw new Error('Host LLM 返回空内容')
    return { text, usage: { promptTokens: inputTokens, completionTokens: outputTokens } }
  }

  async translateBatch(input: TranslateInput, signal: AbortSignal): Promise<TranslateOutput> {
    let lastError: unknown
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      if (signal.aborted) throw abortError(signal)
      try {
        const result = await this.complete(input.systemPrompt, JSON.stringify(input.paragraphs), signal)
        const translations = parseBatchResponse(result.text, input.paragraphs.map(p => p.id))
        return { translations, usage: result.usage }
      } catch (e) {
        if (signal.aborted) throw abortError(signal)
        lastError = e
        if (attempt < this.config.maxRetries) await sleep(400 * 2 ** attempt)
      }
    }
    throw lastError
  }

  async summarize(input: SummaryInput, signal: AbortSignal): Promise<{ text: string; usage: { promptTokens: number; completionTokens: number } }> {
    const prompt = buildSummaryPrompt(input.chapterTitle, input.pages, input.sampleText, input.langPair)
    const result = await this.complete(prompt.system, prompt.user, signal)
    return { text: result.text.trim(), usage: result.usage }
  }
}

export function createEngine(ctx: Context, config: EngineConfig): TranslationEngine {
  const apiKey = config.apiKey?.trim() ?? ''
  if (apiKey !== '') return new OpenAiEngine(config)

  const get = (ctx as unknown as { get(name: string): unknown }).get
  const llm = get.call(ctx, 'llm') as HostLlm | undefined
  const defaultModel = get.call(ctx, 'agentDefaultModel') as DefaultModel | undefined
  if (llm === undefined || typeof llm.stream !== 'function') {
    throw new Error('没有可用的翻译引擎：插件设置里未填 API Key，且当前 Host 未提供 llm 服务。请填写 API Key（OpenAI 兼容）或在支持 Host LLM 的 DSH 中运行。')
  }
  return new HostEngine(llm, defaultModel?.currentSelection(), config)
}
