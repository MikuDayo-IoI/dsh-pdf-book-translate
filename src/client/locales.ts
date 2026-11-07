/**
 * 设置卡片双语词典（settings.pdfBookTranslate 命名空间）。
 * zh 与 en 键集合必须一致（tests/client.test.ts 断言两者键集相同）。
 */
export interface PdfBookTranslateDict {
  title: string
  subtitle: string
  ariaLabel: string
  'group.connection': string
  'group.execution': string
  'field.apiKey': string
  'field.baseUrl': string
  'field.model': string
  'field.hostProvider': string
  'field.hostModel': string
  'field.langPair': string
  'field.termbasePath': string
  'field.concurrency': string
  'field.maxRetries': string
  'field.timeoutMs': string
  'field.pythonBin': string
  save: string
  reset: string
  'status.saving': string
  'status.saved': string
  'status.saveFailed': string
  'status.invalid': string
  'status.reset': string
  secretNote: string
}

export const zhDict: PdfBookTranslateDict = {
  title: 'PDF 书籍翻译',
  subtitle: '章节扫描、断点续译与排版保持。API Key 留空时使用当前会话的 Host 模型；密钥仅保存在本地。',
  ariaLabel: 'PDF 书籍翻译设置',
  'group.connection': '模型与术语表',
  'group.execution': '执行配置',
  'field.apiKey': 'API Key（可选）',
  'field.baseUrl': 'API 地址',
  'field.model': 'API 模型',
  'field.hostProvider': 'Host Provider（可选）',
  'field.hostModel': 'Host 模型（可选）',
  'field.langPair': '默认语言对',
  'field.termbasePath': '默认术语表路径',
  'field.concurrency': '并发数',
  'field.maxRetries': '最大重试',
  'field.timeoutMs': '请求超时(ms)',
  'field.pythonBin': 'Python 可执行文件',
  save: '保存',
  reset: '重置',
  'status.saving': '保存中…',
  'status.saved': '已保存。',
  'status.saveFailed': '保存失败，请检查数值后重试。',
  'status.invalid': '以下数值无效：',
  'status.reset': '已恢复默认值。',
  secretNote: 'API Key 仅保存在本地配置，不会写入会话日志；留空则使用 Host LLM。',
}

export const enDict: PdfBookTranslateDict = {
  title: 'PDF Book Translation',
  subtitle: 'Chapter outlining, resumable translation and layout preservation. Leave the API key empty to use the current Host model; the key stays local.',
  ariaLabel: 'PDF Book Translation settings',
  'group.connection': 'Model and glossary',
  'group.execution': 'Execution',
  'field.apiKey': 'API Key (optional)',
  'field.baseUrl': 'API base URL',
  'field.model': 'API model',
  'field.hostProvider': 'Host provider (optional)',
  'field.hostModel': 'Host model (optional)',
  'field.langPair': 'Default language pair',
  'field.termbasePath': 'Default termbase path',
  'field.concurrency': 'Concurrency',
  'field.maxRetries': 'Max retries',
  'field.timeoutMs': 'Timeout (ms)',
  'field.pythonBin': 'Python executable',
  save: 'Save',
  reset: 'Reset',
  'status.saving': 'Saving…',
  'status.saved': 'Saved.',
  'status.saveFailed': 'Saving failed; check the values and try again.',
  'status.invalid': 'These values are invalid:',
  'status.reset': 'Defaults restored.',
  secretNote: 'The API key is stored locally only. Leave it empty to use the Host LLM.',
}
