import { fromMarkdown } from 'mdast-util-from-markdown'
import { posix } from 'node:path'

export const DOCUMENTATION_FILES = Object.freeze([
  'README.md',
  'README.zh-CN.md',
  'docs/en-US/LOCAL_USAGE.md',
  'docs/en-US/USER_GUIDE.md',
  'docs/zh-CN/LOCAL_USAGE.md',
  'docs/zh-CN/USER_GUIDE.md',
])

export const SCREENSHOT_FILES = Object.freeze([
  'docs/assets/design-desktop-en.webp',
  'docs/assets/design-desktop-zh.webp',
  'docs/assets/design-proposal-en.webp',
  'docs/assets/design-proposal-zh.webp',
  'docs/assets/design-results-media-en.webp',
  'docs/assets/design-results-media-zh.webp',
  'docs/assets/llm-model-selector-en.webp',
  'docs/assets/llm-model-selector-zh.webp',
  'docs/assets/settings-ready-en.webp',
  'docs/assets/settings-ready-zh.webp',
  'docs/assets/web-tools-en.webp',
  'docs/assets/web-tools-zh.webp',
])

const ENGLISH_SCREENSHOTS = Object.freeze(SCREENSHOT_FILES.filter(path => path.endsWith('-en.webp')))
const CHINESE_SCREENSHOTS = Object.freeze(SCREENSHOT_FILES.filter(path => path.endsWith('-zh.webp')))

/**
 * READMEs carry one representative product view; the detailed bilingual
 * guides are the durable home for the complete screenshot set.
 */
export const DOCUMENTATION_SCREENSHOT_RULES = Object.freeze({
  'README.md': Object.freeze(['docs/assets/design-desktop-en.webp']),
  'README.zh-CN.md': Object.freeze(['docs/assets/design-desktop-zh.webp']),
  'docs/en-US/USER_GUIDE.md': ENGLISH_SCREENSHOTS,
  'docs/zh-CN/USER_GUIDE.md': CHINESE_SCREENSHOTS,
})

const TOKEN_PATTERNS = Object.freeze([
  { label: 'private-key block', pattern: /-----BEGIN (?:EC |OPENSSH |PGP |RSA )?PRIVATE KEY-----/u },
  { label: 'AWS access key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u },
  { label: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{32,}\b/u },
  { label: 'OpenAI-style secret', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/u },
  { label: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u },
  { label: 'literal Bearer credential', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}\b/u },
])

const PLACEHOLDER_VALUE = /^(?:<[^>]+>|YOUR(?:_|-)|EXAMPLE(?:_|-)|FAKE(?:_|-)|TEST(?:_|-)|REDACTED\b|REMOVED\b)/iu
const CODE_REFERENCE = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/u
const SECRET_LITERAL = String.raw`(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([A-Za-z0-9._~+/=-]+))`
const MODELLIX_ASSIGNMENT = new RegExp(
  String.raw`(?:"MODELLIX_API_KEY"|'MODELLIX_API_KEY'|\bMODELLIX_API_KEY\b)\s*(?:=|:)\s*${SECRET_LITERAL}`,
  'giu',
)
const SECRET_NAMED_ASSIGNMENT = new RegExp(
  String.raw`(?:["'](?:api[-_]?key|authorization|credential|password|secret|token)["']|\b(?:apiKey|api_key|authorization|credential|password|secret|token)\b)\s*:\s*${SECRET_LITERAL}`,
  'giu',
)

/**
 * Return visible CommonMark image destinations. HTML comments, fenced code,
 * inline code, and ordinary links are represented by other AST node types and
 * therefore cannot satisfy screenshot policy.
 *
 * @param {string} markdown
 * @returns {readonly string[]}
 */
export function visibleMarkdownImageReferences(markdown) {
  const tree = fromMarkdown(markdown)
  /** @type {Map<string, string>} */
  const definitions = new Map()
  walk(tree, (node) => {
    if (node.type === 'definition' && typeof node.identifier === 'string' && typeof node.url === 'string') {
      definitions.set(node.identifier, node.url)
    }
  })

  /** @type {string[]} */
  const references = []
  walk(tree, (node) => {
    if (node.type === 'image' && typeof node.url === 'string') references.push(node.url)
    if (node.type === 'imageReference' && typeof node.identifier === 'string') {
      const target = definitions.get(node.identifier)
      if (target !== undefined) references.push(target)
    }
  })
  return Object.freeze(references)
}

/**
 * Resolve a local Markdown image to a portable package-relative path.
 * HTTPS images are external and return null; every other scheme, absolute
 * path, backslash, malformed escape, and package escape is rejected.
 *
 * @param {string} documentPath
 * @param {string} reference
 * @returns {string | null}
 */
export function resolveLocalMarkdownImage(documentPath, reference) {
  const document = safePackagePath(documentPath, 'documentation path')
  const trimmed = reference.trim()
  if (/^https:\/\//iu.test(trimmed)) return null
  if (/^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/\/)/u.test(trimmed)) {
    throw new Error(`documentation image must be package-relative or HTTPS (${reference})`)
  }
  const rawPath = trimmed.split(/[?#]/u, 1)[0]
  if (rawPath === undefined || rawPath.length === 0) {
    throw new Error(`documentation image has no local path (${reference})`)
  }
  let decoded
  try {
    decoded = decodeURIComponent(rawPath)
  } catch {
    throw new Error(`documentation image has malformed URL escaping (${reference})`)
  }
  if (decoded.includes('\\') || decoded.startsWith('/') || /^[A-Za-z]:/u.test(decoded)) {
    throw new Error(`documentation image has a non-portable path (${reference})`)
  }
  const target = posix.normalize(posix.join(posix.dirname(document), decoded))
  return safePackagePath(target, `documentation image ${reference}`)
}

/**
 * Validate all local visible images plus the per-document screenshot policy.
 *
 * @param {Readonly<Record<string, string>>} documents
 * @param {ReadonlySet<string>} packedFiles
 * @param {Readonly<Record<string, readonly string[]>>} [rules]
 * @returns {ReadonlyMap<string, ReadonlySet<string>>}
 */
export function verifyDocumentationImages(
  documents,
  packedFiles,
  rules = DOCUMENTATION_SCREENSHOT_RULES,
) {
  /** @type {Map<string, ReadonlySet<string>>} */
  const resolvedByDocument = new Map()
  for (const [document, requiredImages] of Object.entries(rules)) {
    const markdown = documents[document]
    if (typeof markdown !== 'string') throw new Error(`documentation text is unavailable (${document})`)
    const visibleImages = new Set()
    for (const reference of visibleMarkdownImageReferences(markdown)) {
      const target = resolveLocalMarkdownImage(document, reference)
      if (target === null) continue
      if (!packedFiles.has(target)) {
        throw new Error(`${document} references an unpacked local image (${target})`)
      }
      visibleImages.add(target)
    }
    const missing = requiredImages.filter(path => !visibleImages.has(path))
    if (missing.length > 0) {
      throw new Error(`${document} omits visible screenshots [${missing.join(', ')}]`)
    }
    resolvedByDocument.set(document, visibleImages)
  }
  return resolvedByDocument
}

/**
 * @param {string} text
 * @returns {{ readonly label: string } | null}
 */
export function findSensitiveContent(text) {
  const token = TOKEN_PATTERNS.find(candidate => candidate.pattern.test(text))
  if (token !== undefined) return { label: token.label }
  if (containsSecretAssignment(text, MODELLIX_ASSIGNMENT)) {
    return { label: 'literal MODELLIX_API_KEY assignment' }
  }
  if (containsSecretAssignment(text, SECRET_NAMED_ASSIGNMENT)) {
    return { label: 'literal JSON Secret assignment' }
  }
  return null
}

/**
 * Parse a Source Map and scan its unescaped embedded source text. Scanning the
 * serialized JSON alone is insufficient because quoted assignments are escaped.
 *
 * @param {string} text
 * @returns {{ readonly label: string } | null}
 */
export function findSensitiveSourceMapContent(text) {
  let sourceMap
  try {
    sourceMap = JSON.parse(text)
  } catch {
    throw new Error('source map must contain valid JSON')
  }
  if (!isRecord(sourceMap)) throw new Error('source map root must be an object')
  if (sourceMap.sourcesContent === undefined) return null
  if (!Array.isArray(sourceMap.sourcesContent)) {
    throw new Error('source map sourcesContent must be an array when present')
  }
  for (const source of sourceMap.sourcesContent) {
    if (source === null) continue
    if (typeof source !== 'string') {
      throw new Error('source map sourcesContent entries must be strings or null')
    }
    const finding = findSensitiveContent(source)
    if (finding !== null) return { label: `${finding.label} in Source Map source` }
  }
  return null
}

/**
 * @param {string} text
 * @param {RegExp} pattern
 * @returns {boolean}
 */
function containsSecretAssignment(text, pattern) {
  pattern.lastIndex = 0
  for (const match of text.matchAll(pattern)) {
    const value = (match[1] ?? match[2] ?? match[3] ?? '').trim()
    if (match[3] !== undefined && CODE_REFERENCE.test(value)) continue
    if (value.length >= 12 && !PLACEHOLDER_VALUE.test(value)) return true
  }
  return false
}

/**
 * @param {unknown} node
 * @param {(node: Record<string, unknown>) => void} visitor
 */
function walk(node, visitor) {
  if (!isRecord(node)) return
  visitor(node)
  if (!Array.isArray(node.children)) return
  for (const child of node.children) walk(child, visitor)
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @param {string} value
 * @param {string} label
 */
function safePackagePath(value, label) {
  const normalized = value.replaceAll('\\', '/')
  if (
    normalized.length === 0 || normalized.startsWith('/') || /^[A-Za-z]:\//u.test(normalized) ||
    normalized === '..' || normalized.startsWith('../') ||
    normalized.split('/').some(part => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`${label} escapes the package`)
  }
  return normalized
}
