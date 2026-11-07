import type { Context } from '@deepseek-ai/cordis'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { defineBookTools, type ToolConfig } from './tool.js'

export const name = 'pdf-book-translate'
export const inject = ['tools', 'jobs']
export const NS = settingsNamespace('pdf-book-translate')

export interface Config extends ToolConfig {}

const configSchema: z<Config> = z.object({
  apiKey: z.string().role('secret'),
  baseUrl: z.string().default('https://api.deepseek.com'),
  model: z.string().default('deepseek-chat'),
  hostProvider: z.string().default(''),
  hostModel: z.string().default(''),
  langPair: z.string().default('en→zh'),
  concurrency: z.number().step(1).min(1).max(16).default(6),
  maxRetries: z.number().step(1).min(0).max(10).default(3),
  timeoutMs: z.number().step(1).min(1000).default(60000),
  termbasePath: z.string().default(''),
  pythonBin: z.string().default('python'),
})

export const Config = Object.defineProperty(configSchema, 'schema', {
  value: configSchema,
  enumerable: false,
}) as z<Config> & { readonly schema: z<Config> }

export function apply(ctx: Context, config: Config): void {
  let source = (): Config => config
  installSettingsSection(ctx, NS, Config, config, {
    setSource: (current) => { source = current },
    onChange: () => {},
  })
  for (const tool of defineBookTools({ ctx, config: () => source() })) {
    ctx.tools.register(tool)
  }
}
