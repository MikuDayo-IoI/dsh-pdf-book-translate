# dsh-pdf-book-translate

DSH（DeepSeek Harness）插件：把**有文本层的 PDF 书籍**按章/节拆解，生成章节纪要，再按用户指定的范围并发翻译，保持原 PDF 的段落位置、字号、颜色、粗体、对齐、图片、背景、矢量图形与链接。

无需 OCR；扫描版 PDF 不在支持范围内。

## 0.1.1 排版引擎

- **段落级重排**：提取时把 PDF 的视觉硬换行还原为连续语义段落（代码段保留换行），翻译后按原栏宽/字号/对齐重新折行，不再把原文的每一行映射成译文的一行。
- **版式避让**：重排会参考同栏段落确定可用宽度，并避开右侧的图片、矢量图和相邻栏；纵向增长时限制到下一个段落/图形之前，优先保持原字号，空间不足才小幅缩字号。
- **矢量图保留**：redaction 只作用于文本层；图片、背景、表格线和矢量图仍是 PDF 中的原生 image/path 对象，输出后由阅读器按矢量重绘，不栅格化、不被白块覆盖。
- **测试**：新增去硬换行、连字符断词、CJK 连接、段落重排、矢量图避让等回归测试。

## 功能

- **章节扫描**：优先读取 PDF 自带目录（TOC），没有目录时按标题字号/位置启发式识别“章”和“节”，两者都没有时回退为单章全书。识别结果、每章摘要和断点状态写入 `zhan_jie.md`。
- **范围门禁**：`pdf_book_translate` 必须收到 `pages`、`chapters`、`sections` 之一或 `all=true`；什么都不传时返回 `scope_required` 和可用章节，让 Agent 先询问用户。
- **范围合并**：同一本书多次翻译不同页码范围会合并到同一份译文 PDF；状态中保留每次范围与已完成页的并集。
- **段落级重排**：翻译前把 PDF 视觉硬换行还原为连续段落（代码段保留换行），翻译后按原栏宽、字号、颜色、粗体与对齐重新折行，不按原文视觉行逐行替换；空间不足时优先轻微缩字号/行距，仍放不下才记排版警告。
- **字体与矢量图**：只 redact 文本层，字体优先沿用原字体，中文缺字回退微软雅黑；图片、背景和矢量图在重建后仍为原生 PDF 路径/对象，不栅格化、不覆盖。
- **并发批翻译**：按 8 段 / 3000 字符组批，默认并发 6（设置可调），每批一次模型请求。
- **断点续译**：每个段落完成即以 `sha256(langPair + 原文)` 为键进入缓存并立即追加 `.translate-cache.jsonl` journal；每批结束和任务收尾时再把缓存原子合并到 `.translate-cache.json`。即使进程被强杀，重跑也能重放 journal、跳过已翻译段落，只补缺失部分。
- **断点恢复**：`.pdf-book-state.json` 和 `zhan_jie.md` 内嵌的状态快照互为备份，任一份损坏/丢失都能恢复章节纪要与已翻译页。开始翻译时会先把本次范围记为“进行中页”；即使中断后改译另一个范围，重跑仍会重新提取这些页并用缓存补全，不会丢失上次已完成的部分。
- **术语表**：支持 JSON 数组、`{原文: 译文}` 对象和 TXT（制表符/逗号分隔），支持 `locked` 禁止翻译；未显式指定时自动发现输出目录的 `termbase.json`、`glossary.json`、`术语表.json`、`termbase.txt` 等。
- **模型来源**：API Key 留空时使用当前会话的 Host 模型（`ctx.llm` + 会话默认 provider/model）；填写 API Key 时使用任意 OpenAI 兼容 `/chat/completions` 端点。Host 模式要求该 provider 已在 DSH 的 Models 页面配置凭据，或启动环境中存在对应环境变量（例如 `DEEPSEEK_API_KEY`）；否则工具会返回可操作错误。
- **对照 PDF**：翻译后生成原版/译文左右并排的 `<书名>.<目标语言>.compare.pdf`。
- **统计回报**：向 Agent 返回段落总数、新译/缓存命中/失败/跳过、缓存命中率、API 调用、token、耗时、累计范围、排版警告等。

## 工作流程

```text
pdf_book_outline
  ├─ 检查文本层（无文本层直接拒绝）
  ├─ worker outline：TOC → 标题启发式 → 单章回退
  ├─ AI 为每章生成 180–350 字摘要（逐章落盘，失败写节选回退）
  └─ 写 zhan_jie.md + .pdf-book-state.json，返回章节列表
        ↓
   询问用户翻译范围（页 / 章 / 节 / 全书）
        ↓
pdf_book_translate（必须显式范围）
  ├─ 读取 zhan_jie.md / state，解析并合并范围
  ├─ extract：只提取本次页与历史已翻译页的段落
  ├─ 查缓存 → 未命中段落组批 → 并发翻译 → 每段立即写缓存
  ├─ rebuild：只重写有译文的段落，其余原页内容不动
  ├─ compare：生成左右对照 PDF
  └─ 合并已翻译页，写回 state / zhan_jie.md，返回统计
        ↓
pdf_book_status（中断后查看进度）
```

## 工具

### `pdf_book_outline`

| 参数 | 必填 | 说明 |
|---|---|---|
| `input` | ✅ | 输入 PDF 路径（绝对路径或工作区相对路径） |
| `outputDir` | 可选 | 输出目录，默认 PDF 同目录下 `<文件名>-translation` |
| `langPair` | 可选 | 语言对，如 `en→zh`；默认使用插件设置或已有项目 |
| `rescan` | 可选 | `true` 重新识别结构（保留能按 id+title 匹配的旧摘要） |

### `pdf_book_translate`

| 参数 | 必填 | 说明 |
|---|---|---|
| `input` | ✅ | 输入 PDF 路径 |
| `outputDir` | 可选 | 输出目录 |
| `langPair` | 可选 | 语言对；默认沿用已有 `zhan_jie.md` |
| `pages` | 范围之一 | 1-based 页码范围，如 `1-20,35,40-45` |
| `chapters` | 范围之一 | 章 id 或标题，逗号分隔，如 `ch-1,ch-3` |
| `sections` | 范围之一 | 节 id 或标题，逗号分隔 |
| `all` | 范围之一 | 全书；只有用户明确要求整本时才传 `true` |
| `termbase` | 可选 | 术语表路径；缺省读取设置或输出目录自动发现 |

不传任何范围时返回 `status=scope_required`，不会默认整本翻译。

### `pdf_book_status`

查看章节纪要、已翻译页并集、范围列表、缓存条目数、输出文件是否存在、上次统计，用于中断后续跑。

## 输出文件

输出目录默认为 `<PDF 同目录>/<书名>-translation`：

| 文件 | 作用 |
|---|---|
| `zhan_jie.md` | 人读的章节纪要 + 内嵌 base64 断点状态 |
| `.pdf-book-state.json` | 机器可读的完整断点状态 |
| `.translate-cache.json` | 段落翻译缓存 `{hash: 译文}` |
| `.translate-cache.jsonl` | 每段完成即追加的 journal，崩溃恢复用 |
| `<书名>.<目标语言>.pdf` | 译文 PDF（保留原版非文字内容） |
| `<书名>.<目标语言>.compare.pdf` | 原版/译文左右对照 PDF |
| `.translate.lock` | 单写者锁，防止两个任务同时改同一项目 |

## 术语表格式

JSON 数组：

```json
[
  { "src": "transformer", "dst": "Transformer", "locked": false },
  { "src": "DeepSeek", "dst": "DeepSeek", "locked": true }
]
```

JSON 对象：

```json
{ "transformer": "Transformer", "token": "词元" }
```

TXT（制表符或逗号分隔，第三列可写 `locked`）：

```text
transformer	Transformer
DeepSeek	DeepSeek	locked
```

## 安装与构建

环境要求：

- Python 3.10+，并安装 PyMuPDF：`python -m pip install pymupdf`
- Node.js 22+，pnpm/npm

```bash
npm install
npm run build
npm test
```

构建产物：

- `lib/index.js`：Host 插件入口
- `lib/client.js`：Web 设置卡片
- `worker/*.py`：PyMuPDF worker

作为 DSH 插件安装时，将包含 `lib/`、`worker/`、`cordis.patch.yml` 和 `package.json` 的包目录通过插件管理器以 bundle 形式安装。插件 id 为 `pdf-book-translate`，配置命名空间为 `pdf-book-translate`，设置卡文案的 locale 命名空间为 `settings.pdfBookTranslate`。设置卡挂在该 bundle 的配置页（`plugins.bundle.config`，key 为包名 `dsh-pdf-book-translate`）；新安装后刷新一次 Web GUI 即可看到。

> 运行时不应把本项目的 devDependencies 一起安装；DSH 宿主已提供 cordis/dsh-tools/dsh-settings。发布包只保留 `@deepseek-ai/schemastery` 作为 dependency。

## 设置

| 设置 | 默认 | 说明 |
|---|---|---|
| `apiKey` | 空 | 留空使用 Host 模型；填写则走 OpenAI 兼容 API |
| `baseUrl` | `https://api.deepseek.com` | OpenAI 兼容端点 |
| `model` | `deepseek-chat` | API 模式模型名 |
| `hostProvider` / `hostModel` | 空 | 覆盖当前会话默认 provider/model |
| `langPair` | `en→zh` | 默认语言对 |
| `concurrency` | `6` | 并发批次，1–16 |
| `maxRetries` | `3` | 429/5xx/超时重试次数 |
| `timeoutMs` | `60000` | 单次请求超时 |
| `termbasePath` | 空 | 默认术语表路径 |
| `pythonBin` | `python` | Python 可执行文件（需能 import pymupdf） |

## 测试

```bash
npm test                  # 84 个 TypeScript 测试
python -m pytest worker/tests -q   # 45 个 Python worker 测试
node scripts/e2e-book.mjs # mock 模型端到端：范围/缓存/术语表/译文/对照 PDF
```

## 已知限制

- 仅文本型 PDF，无 OCR。
- 同一段落内混合字体样式（例如半句加粗）会按首 span 样式统一写回。
- 极长译文可能触发缩字号/溢出警告；日志会列入 `warnings`，不会静默丢失。
- 文本型 PDF 中的表格按文本行/单元格几何处理，不重建表格结构。
- 缓存键只含“原文 + 语言对”，不包含术语表或章节上下文；修改术语表后如需重译，请删除对应缓存条目或换输出目录。

## 目录结构

```text
src/
  index.ts                 Host 插件入口 / 设置
  tool.ts                  三个工具与术语表加载
  pipeline.ts              outline / translate 流水线
  book.ts                  路径、状态、范围、锁、zhan_jie.md
  worker.ts                Python worker JSON 协议
  types.ts                 共享类型
  translate/
    engine.ts              HostEngine / OpenAiEngine
    deepseek.ts            OpenAI 兼容客户端
    prompts.ts             翻译/摘要 prompt
    cache.ts               缓存 + journal
    chunker.ts             段落分批
    concurrency.ts         有界并发池
    source-text.ts         PDF 视觉行 → 连续段落文本
  client/                  Web 设置卡片
worker/
  main.py                  JSON 行协议入口
  extract.py               段落/样式/栏检测
  outline.py               章/节识别与采样
  rebuild.py               redaction + 样式重写
  compare.py               左右对照 PDF
```

## License

MIT
