import http from 'node:http'
import path from 'node:path'
import { readdir, rm, writeFile } from 'node:fs/promises'
import { defineBookTools } from '../lib/tool.js'

const root = process.cwd()
const input = path.resolve(root, 'samples/sample-en.pdf')
const outputDir = path.resolve(root, 'tmp-e2e-book')

const requests = []
const server = http.createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  const messages = body.messages ?? []
  const user = String(messages.at(-1)?.content ?? '')
  const system = String(messages.find(message => message.role === 'system')?.content ?? '')
  const jsonMode = body.response_format?.type === 'json_object'
  let content
  if (jsonMode) {
    const items = JSON.parse(user)
    content = JSON.stringify(Object.fromEntries(items.map((item, index) => [String(item.id), `这是第${index + 1}段译文：${item.text}`])))
  } else {
    content = '本章介绍 PDF 翻译插件的段落识别、代码保留与排版重建流程。'
  }
  requests.push({ model: body.model, jsonMode, count: jsonMode ? JSON.parse(user).length : 0, system })
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 10, completion_tokens: 20 },
  }))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

const ctx = { get: () => undefined }
const config = () => ({
  apiKey: 'e2e-test-key',
  baseUrl: `http://127.0.0.1:${port}`,
  model: 'mock-model',
  langPair: 'en→zh',
  concurrency: 2,
  maxRetries: 0,
  timeoutMs: 5000,
  pythonBin: 'python',
})
const tools = defineBookTools({ ctx, config })
const byName = Object.fromEntries(tools.map(tool => [tool.name, tool]))
const signal = new AbortController().signal

function show(label, value) {
  console.log(`\n=== ${label} ===`)
  console.log(JSON.stringify(value, null, 2).slice(0, 3000))
}

await rm(outputDir, { recursive: true, force: true })
const outline = await byName.pdf_book_outline.execute({ input, outputDir }, { signal })
show('outline first', outline)

await writeFile(
  path.join(outputDir, 'termbase.json'),
  JSON.stringify([{ src: 'PDF', dst: '便携文档格式', locked: false }]),
  'utf8',
)

const scopeRequired = await byName.pdf_book_translate.execute({ input, outputDir }, { signal })
show('scope required', scopeRequired)

const part1 = await byName.pdf_book_translate.execute({ input, outputDir, pages: '1-2' }, { signal })
show('translate 1-2', part1)

const part1Again = await byName.pdf_book_translate.execute({ input, outputDir, pages: '1-2' }, { signal })
show('translate 1-2 again', part1Again)

const part2 = await byName.pdf_book_translate.execute({ input, outputDir, pages: '3' }, { signal })
show('translate page 3', part2)

const status = await byName.pdf_book_status.execute({ input, outputDir }, { signal })
show('status', status)

console.log('\n=== requests ===')
console.log(JSON.stringify(requests, null, 2))
if (!requests.some(request => request.jsonMode && request.system.includes('便携文档格式'))) {
  throw new Error('termbase was not injected into the translation prompt')
}
console.log('TERMBASE_OK')
console.log('\n=== output files ===')
console.log(await readdir(outputDir))

server.close()
