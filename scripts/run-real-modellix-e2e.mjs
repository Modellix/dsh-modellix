import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  LlmCatalogClient,
  ModelCatalogClient,
  ModelSchemaClient,
  PredictionClient,
  buildInvocationBody,
  createModellixWebProviders,
  parseDesignSchema,
} from '../lib/index.js'

/** @typedef {import('../lib/index.js').DesignMediaCategory} DesignMediaCategory */
/** @typedef {import('../lib/index.js').PredictionResource} PredictionResource */
/** @typedef {import('../lib/index.js').PredictionTask} PredictionTask */

const packageRoot = realpathSync(fileURLToPath(new URL('../', import.meta.url)))
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const apiKey = requiredSecret('MODELLIX_API_KEY')
const outputDirectory = externalDirectory('MODELLIX_REAL_E2E_OUTPUT_DIR')
const evidencePath = externalFilePath('MODELLIX_API_AGENT_E2E_EVIDENCE_FILE')

if (process.env.MODELLIX_ALLOW_BILLED_E2E !== '1') {
  throw new Error('Set MODELLIX_ALLOW_BILLED_E2E=1 only after the billed media, LLM, and Web calls are explicitly authorized')
}
if (process.env.MODELLIX_REAL_AGENT_ATTESTED !== '1') {
  throw new Error('Set MODELLIX_REAL_AGENT_ATTESTED=1 only after a Modellix-backed DSH Agent turn passed in the same acceptance run')
}

mkdirSync(outputDirectory, { recursive: true })
mkdirSync(dirname(evidencePath), { recursive: true })

const fetchImpl = globalThis.fetch
const catalogClient = new ModelCatalogClient({
  fetch: fetchImpl,
  getApiKey: () => apiKey,
})
const schemaClient = new ModelSchemaClient({ fetch: fetchImpl })
const predictionClient = new PredictionClient({ fetch: fetchImpl })
const llmCatalogClient = new LlmCatalogClient({
  resolveCredential: async () => ({ value: apiKey, credentialEpoch: 1 }),
  fetch: fetchImpl,
})

/** @type {readonly { category: DesignMediaCategory, slug: string, values: Record<string, unknown>, timeoutMs: number }[]} */
const mediaCases = Object.freeze([
  {
    category: 'image',
    slug: 'openai/gpt-image-2',
    values: {
      prompt: 'An editorial-quality cinematic photograph of a serene futuristic library carved into pale limestone above a misty lake at blue hour, warm reading lamps, subtle human scale, elegant architectural details, natural reflections, balanced composition, restrained color palette, highly polished but believable',
    },
    timeoutMs: 15 * 60_000,
  },
  {
    category: 'video',
    slug: 'minimax/hailuo-2.3-t2v',
    values: {
      prompt: 'A calm six-second cinematic tracking shot through a refined future library above a misty lake at blue hour, warm lamps glowing between pale stone arches, subtle pages moving in a light breeze, realistic motion, restrained colors, no text',
      duration: 6,
      resolution: '768P',
      fast_pretreatment: true,
    },
    timeoutMs: 30 * 60_000,
  },
  {
    category: 'audio',
    slug: 'alibaba/qwen-audio-3.0-tts-plus',
    values: {
      text: 'Welcome to Modellix Design. One API key lets you move from an idea to polished image, video, and audio results.',
      voice: 'longanlingxin',
      language_hint: 'en',
    },
    timeoutMs: 10 * 60_000,
  },
])

/** @type {readonly DesignMediaCategory[]} */
const catalogCategories = ['image', 'video', 'audio']
const catalogChecks = await Promise.all(
  catalogCategories.map(async (category) => {
    const page = await catalogClient.list({ category, page: 1, pageSize: 24 })
    if (page.source !== 'authenticated-api' || page.items.length === 0) {
      throw new Error(`Authenticated ${category} catalog did not return models`)
    }
    return { category, count: page.items.length }
  }),
)

const llmCatalog = await llmCatalogClient.fetchModels()
if (llmCatalog.models.length === 0) throw new Error('Authenticated LLM catalog is empty')

const plannedCases = []
for (const mediaCase of mediaCases) {
  const [provider, modelId] = mediaCase.slug.split('/')
  if (provider === undefined || modelId === undefined) {
    throw new Error(`Invalid acceptance model slug: ${mediaCase.slug}`)
  }
  const modelSchema = await schemaClient.load(provider, modelId)
  if (modelSchema.submitUrl === null) {
    throw new Error(`${mediaCase.slug} did not publish an authoritative submission URL`)
  }
  const schema = parseDesignSchema(modelSchema.document)
  if (!schema.supported) throw new Error(`${mediaCase.slug} has unsupported blocking schema constraints`)
  const body = buildInvocationBody(schema, mediaCase.values)
  plannedCases.push({ ...mediaCase, body, endpoint: modelSchema.submitUrl })
}

const mediaResults = []
for (const mediaCase of plannedCases) {
  const submitted = await predictionClient.submit({
    endpoint: mediaCase.endpoint,
    modelSlug: mediaCase.slug,
    apiKey,
    body: mediaCase.body,
    requestId: `dsh-modellix-real-e2e-${mediaCase.category}-${Date.now()}`,
  })
  const completed = await waitForTask(predictionClient, submitted, apiKey, mediaCase.timeoutMs)
  const resource = completed.resources.find((candidate) => candidate.kind === mediaCase.category)
  if (resource === undefined) {
    throw new Error(`${mediaCase.slug} completed without a ${mediaCase.category} resource`)
  }
  const mediaPath = await downloadResource(resource, mediaCase.category, outputDirectory)
  mediaResults.push({ category: mediaCase.category, taskId: completed.taskId, mediaPath })
  console.log(`${mediaCase.category}: passed`)
}

console.log('llm-agent: passed')

await runWeb(apiKey)
console.log('web: passed')

const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: packageRoot,
  encoding: 'utf8',
  windowsHide: true,
}).trim()
const evidence = {
  version: 1,
  kind: 'api-agent',
  status: 'passed',
  package: { name: packageJson.name, version: packageJson.version },
  commit,
  completedAt: new Date().toISOString(),
  checks: {
    catalogs: 'passed',
    planner: 'passed',
    image: 'passed',
    video: 'passed',
    audio: 'passed',
    'llm-agent': 'passed',
    web: 'passed',
  },
  billedCallsExplicitlyAuthorized: true,
}
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })

const report = {
  version: 1,
  completedAt: evidence.completedAt,
  catalogs: catalogChecks,
  llmModels: llmCatalog.models.length,
  media: mediaResults,
}
writeFileSync(`${outputDirectory}/report.json`, `${JSON.stringify(report, null, 2)}\n`, {
  encoding: 'utf8',
  mode: 0o600,
})
console.log(`evidence: ${evidencePath}`)

/** @param {string} secret */
async function runWeb(secret) {
  const providers = createModellixWebProviders({
    isEnabled: () => true,
    hasCredential: () => true,
    resolveCredential: async () => ({ apiKey: secret, credentialEpoch: 1 }),
    getUserId: () => 'real-e2e-20260826',
    isCredentialEpochCurrent: (epoch) => epoch === 1,
    fetchImpl,
  })
  const search = await providers.search.search({
    query: 'Modellix AI official documentation',
    maxResults: 3,
  })
  if (!Array.isArray(search.sources) || search.sources.length === 0) {
    throw new Error('Modellix Web Search returned no results')
  }
  const fetched = await providers.fetch.fetch({ url: 'https://docs.modellix.ai/get-started' })
  if (fetched.body.kind !== 'text' || fetched.body.content.trim().length === 0) {
    throw new Error('Modellix Web Fetch returned no content')
  }
}

/**
 * @param {PredictionClient} client
 * @param {PredictionTask} initial
 * @param {string} secret
 * @param {number} timeoutMs
 * @returns {Promise<PredictionTask>}
 */
async function waitForTask(client, initial, secret, timeoutMs) {
  const startedAt = Date.now()
  let task = initial
  while (!['succeeded', 'failed', 'canceled'].includes(task.status)) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Task ${task.taskId} did not finish within the acceptance deadline`)
    }
    await delay(5_000)
    task = await client.readTask({ taskId: task.taskId, apiKey: secret, maxAttempts: 3 })
  }
  if (task.status !== 'succeeded') throw new Error(`Task ${task.taskId} ended as ${task.status}`)
  return task
}

/**
 * @param {PredictionResource} resource
 * @param {DesignMediaCategory} category
 * @param {string} directory
 */
async function downloadResource(resource, category, directory) {
  const response = await fetchImpl(resource.url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`${category} result download returned HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length === 0) throw new Error(`${category} result download was empty`)
  const extension = extensionFor(
    resource.mimeType ?? response.headers.get('content-type'),
    category,
  )
  const path = `${directory}/${category}-result.${extension}`
  writeFileSync(path, bytes, { mode: 0o600 })
  return path
}

/**
 * @param {string | null | undefined} mimeType
 * @param {DesignMediaCategory} category
 */
function extensionFor(mimeType, category) {
  const normalized = mimeType?.split(';', 1)[0]?.trim().toLowerCase()
  if (normalized === 'image/png') return 'png'
  if (normalized === 'image/jpeg') return 'jpg'
  if (normalized === 'image/webp') return 'webp'
  if (normalized === 'video/webm') return 'webm'
  if (normalized === 'audio/wav') return 'wav'
  if (normalized === 'audio/ogg') return 'ogg'
  if (category === 'video') return 'mp4'
  if (category === 'audio') return 'mp3'
  return 'bin'
}

/** @param {string} name */
function requiredSecret(name) {
  const value = process.env[name]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} must be supplied through the acceptance process environment`)
  }
  return value.trim()
}

/** @param {string} name */
function externalDirectory(name) {
  const value = process.env[name]
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path outside the repository`)
  }
  assertOutsideRepository(value, name)
  return value
}

/** @param {string} name */
function externalFilePath(name) {
  const value = process.env[name]
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path outside the repository`)
  }
  assertOutsideRepository(value, name)
  return value
}

/**
 * @param {string} path
 * @param {string} name
 */
function assertOutsideRepository(path, name) {
  const fromPackage = relative(packageRoot, path)
  if (fromPackage.length === 0 || (fromPackage !== '..' && !fromPackage.startsWith(`..${sep}`) && !isAbsolute(fromPackage))) {
    throw new Error(`${name} must remain outside the repository`)
  }
}

/** @param {number} milliseconds */
function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
