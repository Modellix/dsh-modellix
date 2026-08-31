import { isBuiltin } from 'node:module'
import { defineConfig } from 'tsdown'

const packageId = 'dsh-modellix'

const productionPackages = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-api-remotes',
  '@deepseek-ai/dsh-anonymous-user-id',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-attachment',
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-input-trigger',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-tool',
  '@deepseek-ai/dsh-credentials',
  '@deepseek-ai/dsh-host-apiproxy',
  '@deepseek-ai/dsh-invariants',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-llm-pi-ai',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-storage',
  '@deepseek-ai/dsh-storage-domain',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-web',
  '@deepseek-ai/schemastery',
  'zod',
] as const

const clientExternals = new Set([
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-api-remotes/client',
  '@deepseek-ai/dsh-client-connection/client',
  '@deepseek-ai/dsh-client-locale/client',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-ui-conversation/client',
  '@deepseek-ai/dsh-client-ui-input-trigger/client',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-settings/client',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-tool/client',
  'react',
  'react/jsx-runtime',
])

function matchesPackage(packages: readonly string[], specifier: string): boolean {
  return packages.some(name => specifier === name || specifier.startsWith(`${name}/`))
}

function buildFace(value: unknown): 'host' | 'client' {
  if (value === undefined || value === 'host') return 'host'
  if (value === 'client') return 'client'
  throw new Error(`tsdown: DSH_BUILD_FACE must be host or client, received ${String(value)}`)
}

export default defineConfig(({ env }) => {
  const face = buildFace(env?.DSH_BUILD_FACE)
  if (face === 'host') {
    return {
      name: `${packageId}/host`,
      entry: { index: 'src/index.ts' },
      outDir: 'lib',
      format: 'esm',
      platform: 'node',
      target: 'es2024',
      tsconfig: 'tsconfig.host.json',
      fixedExtension: false,
      dts: { sourcemap: false },
      sourcemap: true,
      clean: true,
      deps: {
        neverBundle: specifier => matchesPackage(productionPackages, specifier),
        alwaysBundle: specifier => !isBuiltin(specifier) && !matchesPackage(productionPackages, specifier),
      },
    }
  }

  return {
    name: `${packageId}/client`,
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2024',
    tsconfig: 'tsconfig.client.json',
    outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
    dts: { sourcemap: false },
    sourcemap: true,
    clean: false,
    deps: {
      neverBundle: specifier => clientExternals.has(specifier),
      alwaysBundle: specifier => !clientExternals.has(specifier),
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    banner: {
      js: `window.__ModuleLoader__.load({
  id: ${JSON.stringify(packageId)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;`,
    },
    footer: { js: 'return module.exports; } });' },
  }
})
