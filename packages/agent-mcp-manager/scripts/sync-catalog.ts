#!/usr/bin/env bun
/**
 * Regenerate `src/_vendor/catalog.ts` from `src/_vendor/config.yml` plus
 * the hand-authored `scripts/lib/supported-transports.ts` table.
 *
 * Usage:
 *   bun run sync-catalog          # regenerate catalog.ts
 *   bun run sync-catalog:check    # exit non-zero if catalog.ts is stale
 *
 * Every catalog entry's write shape (parent key, tag key, injected
 * fields, field renames, command-as-array flag) is derived by executing
 * upstream Docker's yq.set expression against a canonical STDIO probe
 * binding and inspecting the resulting document. Every catalog entry's
 * transport-capability set (`supportedTransports`) is looked up from
 * `supported-transports.ts` (hand-authored, cited).
 *
 * The generator throws when: a yq expression uses a construct outside
 * our nine-primitive grammar (novel yq syntax); a client id in the YAML
 * has no entry in `SUPPORTED_TRANSPORTS`; the inferred shape has a
 * combination we don't recognise. All three failure modes force a
 * human to extend the generator, the table, or (rarely) mark the
 * client unsupported.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import YAML from 'yaml'
import {
  type InferredShape,
  inferShape,
  STDIO_PROBE,
} from './lib/infer-shape.ts'
import { SUPPORTED_TRANSPORTS } from './lib/supported-transports.ts'
import { evaluate, parse, YqError } from './lib/yq.ts'

interface UpstreamYq {
  list?: string
  set: string
  del?: string
}

interface UpstreamSystemBlock {
  displayName?: string
  displayname?: string
  installCheckPaths?: string[]
  paths: {
    darwin?: string[]
    linux?: string[]
    windows?: string[]
  }
  yq: UpstreamYq
}

interface UpstreamProjectBlock {
  displayName?: string
  displayname?: string
  projectfile?: string
  projectFile?: string
  yq: UpstreamYq
}

interface UpstreamConfig {
  system: Record<string, UpstreamSystemBlock>
  project: Record<string, UpstreamProjectBlock>
}

/** The generated catalog entry shape. */
export interface GeneratedEntry {
  id: string
  displayName: string
  installCheckPaths: {
    darwin?: string[]
    linux?: string[]
    win32?: string[]
  }
  systemPaths: {
    darwin?: string[]
    linux?: string[]
    win32?: string[]
  }
  projectFile?: string
  emitterId: 'json' | 'yaml-continue' | 'yaml-goose' | 'toml-codex'
  emitterConfig: EmitterConfigOut
  projectEmitterConfig?: EmitterConfigOut
  supportedTransports?: ReadonlyArray<'stdio' | 'sse' | 'http'>
  projectSupportedTransports?: ReadonlyArray<'stdio' | 'sse' | 'http'>
}

export interface EmitterConfigOut {
  parentKey: string
  transportTagKey?: 'type' | 'transport'
  injectFields?: Record<string, unknown>
  keyTransform?: 'simpleName'
  commandAsArray?: boolean
  fieldRenames?: { command?: string; args?: string; env?: string }
}

// -------------------------------------------------------------------
// Generator entry point
// -------------------------------------------------------------------

export interface GenerateResult {
  entries: GeneratedEntry[]
  /** Upstream sha at the time the vendored YAML was captured, if a comment records it. */
  upstreamSha?: string
}

export function generateCatalog(yamlSource: string): GenerateResult {
  const doc = YAML.parse(yamlSource) as UpstreamConfig
  if (!doc.system) throw new Error('upstream YAML missing `system:` root')

  const entries: GeneratedEntry[] = []
  for (const [id, block] of Object.entries(doc.system)) {
    entries.push(generateSystemEntry(id, block))
  }
  // Second pass: attach project overrides onto the matching system entries.
  for (const [id, block] of Object.entries(doc.project ?? {})) {
    const target = entries.find((e) => e.id === id)
    if (!target) {
      throw new Error(
        `project entry for "${id}" has no matching system entry; upstream schema drift?`,
      )
    }
    const shape = inferForBlock(id, block.yq.set, 'project')
    target.projectFile = block.projectfile ?? block.projectFile
    target.projectEmitterConfig = shapeToEmitterConfig(shape)
    const t = SUPPORTED_TRANSPORTS[id]
    if (t?.project) target.projectSupportedTransports = t.project
  }

  // Post-processing: codex (not in the YAML; handled by pkg/client/codex_handler.go
  // in upstream Docker, which uses TOML). Emit a hand-authored entry so
  // catalog consumers see a uniform surface.
  entries.push(codexEntry())

  return { entries: entries.sort((a, b) => a.id.localeCompare(b.id)) }
}

function generateSystemEntry(
  id: string,
  block: UpstreamSystemBlock,
): GeneratedEntry {
  const displayName = block.displayName ?? block.displayname ?? id
  const shape = inferForBlock(id, block.yq.set, 'system')
  const emitterConfig = shapeToEmitterConfig(shape)
  const t = SUPPORTED_TRANSPORTS[id]
  if (!t) {
    throw new Error(
      `catalog client "${id}" is present in upstream YAML but has no entry in scripts/lib/supported-transports.ts. ` +
        `Add supportedTransports for "${id}" with a citation to the client's first-party MCP docs.`,
    )
  }
  const emitterId = pickEmitterId(shape, block.yq.set)
  return {
    id,
    displayName,
    installCheckPaths: transformOsPaths(block.installCheckPaths),
    systemPaths: transformPathsMap(block.paths),
    emitterId,
    emitterConfig,
    supportedTransports: t.system,
  }
}

function inferForBlock(
  clientId: string,
  setExpr: string,
  scope: 'system' | 'project',
): InferredShape {
  try {
    const trace = evaluate(parse(setExpr), STDIO_PROBE as never)
    return inferShape(trace)
  } catch (err) {
    if (err instanceof YqError) {
      throw new Error(
        `Failed to evaluate yq.set for "${clientId}" (${scope} scope): ${err.message}\n` +
          `Expression: ${setExpr}\n` +
          `Extend scripts/lib/yq.ts or scripts/lib/infer-shape.ts.`,
      )
    }
    throw err
  }
}

function shapeToEmitterConfig(shape: InferredShape): EmitterConfigOut {
  if (shape.parentPath.length !== 1) {
    throw new Error(
      `nested parent paths not yet supported (got ${JSON.stringify(shape.parentPath)})`,
    )
  }
  const cfg: EmitterConfigOut = { parentKey: shape.parentPath[0] as string }
  if (shape.transportTagKey) cfg.transportTagKey = shape.transportTagKey
  if (Object.keys(shape.injectFields).length > 0)
    cfg.injectFields = shape.injectFields
  if (shape.keyTransform === 'simpleName') cfg.keyTransform = 'simpleName'
  if (shape.commandAsArray) cfg.commandAsArray = true
  if (
    shape.fieldRenames.command ||
    shape.fieldRenames.args ||
    shape.fieldRenames.env
  ) {
    cfg.fieldRenames = { ...shape.fieldRenames }
  }
  return cfg
}

function pickEmitterId(
  shape: InferredShape,
  setExpr: string,
): GeneratedEntry['emitterId'] {
  if (shape.arrayShape) return 'yaml-continue'
  if (shape.keyTransform === 'simpleName') return 'yaml-goose'
  // Any expression writing into a YAML file uses one of the yaml emitters
  // (continue or goose). Everything else is JSON.
  if (setExpr.includes('$SIMPLE_NAME')) return 'yaml-goose'
  return 'json'
}

function transformPathsMap(
  paths: UpstreamSystemBlock['paths'],
): GeneratedEntry['systemPaths'] {
  return {
    darwin: paths.darwin,
    linux: paths.linux,
    win32: paths.windows,
  }
}

function transformOsPaths(
  installCheckPaths: string[] | undefined,
): GeneratedEntry['installCheckPaths'] {
  if (!installCheckPaths || installCheckPaths.length === 0) return {}
  // Upstream `installCheckPaths` is a flat list applied to every OS. We
  // partition heuristically by env-var prefixes: $USERPROFILE / $APPDATA /
  // $LOCALAPPDATA are Windows; $HOME is unix; other paths use runtime
  // resolution and go into all lists.
  const out: GeneratedEntry['installCheckPaths'] = {
    darwin: [],
    linux: [],
    win32: [],
  }
  for (const p of installCheckPaths) {
    if (
      p.startsWith('$USERPROFILE') ||
      p.startsWith('$APPDATA') ||
      p.startsWith('$LOCALAPPDATA')
    ) {
      out.win32?.push(p)
    } else {
      out.darwin?.push(p)
      out.linux?.push(p)
    }
  }
  // Drop empty arrays for cleanliness.
  if (out.darwin?.length === 0) delete out.darwin
  if (out.linux?.length === 0) delete out.linux
  if (out.win32?.length === 0) delete out.win32
  return out
}

function codexEntry(): GeneratedEntry {
  return {
    id: 'codex',
    displayName: 'Codex',
    installCheckPaths: {
      darwin: ['$HOME/.codex'],
      linux: ['$HOME/.codex'],
      win32: ['$USERPROFILE\\.codex'],
    },
    systemPaths: {
      darwin: ['$HOME/.codex/config.toml'],
      linux: ['$HOME/.codex/config.toml'],
      win32: ['$USERPROFILE\\.codex\\config.toml'],
    },
    emitterId: 'toml-codex',
    emitterConfig: { parentKey: 'mcp_servers' },
    supportedTransports: SUPPORTED_TRANSPORTS.codex?.system,
  }
}

// -------------------------------------------------------------------
// Emitter (writes catalog.ts source)
// -------------------------------------------------------------------

export function emitCatalogSource(result: GenerateResult): string {
  const header = `/**
 * v0.0.4+ catalog. Generated by scripts/sync-catalog.ts from
 * src/_vendor/config.yml. Do NOT edit by hand; re-run
 * \`bun run sync-catalog\` after updating the vendored YAML.
 *
 * Docker's config.yml is the source of truth for the WRITE SHAPE
 * (parent key, tag key, injects, field renames). Transport-capability
 * sets live in scripts/lib/supported-transports.ts (hand-authored,
 * cited). See THIRD_PARTY_NOTICES.md for the upstream sha at capture.
 */
import type { AgentId } from '../types.ts'
`

  const bodyLines: string[] = []
  bodyLines.push(
    `export type EmitterId = 'json' | 'yaml-continue' | 'yaml-goose' | 'toml-codex'`,
  )
  bodyLines.push('')
  bodyLines.push(`export const CATALOG_V004 = [`)
  for (const e of result.entries) {
    bodyLines.push(`  ${JSON.stringify(e, null, 2).replace(/\n/g, '\n  ')},`)
  }
  bodyLines.push(`] as const`)
  bodyLines.push('')
  bodyLines.push(
    `export const CATALOG_CLIENT_IDS = [${result.entries.map((e) => `'${e.id}'`).join(', ')}] as const satisfies ReadonlyArray<AgentId>`,
  )
  bodyLines.push('')
  return `${header}\n${bodyLines.join('\n')}\n`
}

// -------------------------------------------------------------------
// CLI
// -------------------------------------------------------------------

const HERE = new URL('.', import.meta.url).pathname
const PKG_ROOT = resolve(HERE, '..')
const YAML_PATH = join(PKG_ROOT, 'src/_vendor/config.yml')
const CATALOG_OUT = join(PKG_ROOT, 'src/_vendor/catalog.generated.ts')

async function main() {
  const args = new Set(process.argv.slice(2))
  const checkOnly = args.has('--check')

  if (!existsSync(YAML_PATH)) {
    console.error(`missing ${YAML_PATH}. Run vendor step first.`)
    process.exit(1)
  }
  const yaml = readFileSync(YAML_PATH, 'utf8')
  const result = generateCatalog(yaml)
  const emitted = emitCatalogSource(result)

  if (checkOnly) {
    const onDisk = existsSync(CATALOG_OUT)
      ? readFileSync(CATALOG_OUT, 'utf8')
      : ''
    if (onDisk === emitted) {
      console.log(`sync-catalog check: OK (${result.entries.length} entries)`)
      process.exit(0)
    }
    console.error(
      `sync-catalog check FAILED. Run \`bun run sync-catalog\` to update ${CATALOG_OUT}.`,
    )
    process.exit(1)
  }
  writeFileSync(CATALOG_OUT, emitted, 'utf8')
  console.log(
    `wrote ${result.entries.length} catalog entries -> ${CATALOG_OUT}`,
  )
}

// Only run when invoked directly.
if (import.meta.main) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
