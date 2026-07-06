/**
 * Derive an `EmitterConfig` from a yq write trace.
 *
 * Given a canonical stdio spec probe (`$JSON = { command: "__CMD__", args:
 * ["__ARG__"], env: { "__ENV_K__": "__ENV_V__" } }`), evaluate an upstream
 * yq expression and look at what the evaluator wrote. The parent key, tag
 * key, injected static fields, field renames, and command-as-array flag
 * all fall out of comparing the emitted object against the probe.
 *
 * Also produces an `emitterId` decision based on which probe fields
 * survived and where they landed. YAML-vs-JSON is determined externally
 * from the target file extension (`.yaml` -> yaml emitter, `.json`/`.jsonc`
 * -> json emitter, `.toml` -> toml emitter).
 */

import type { EvalTrace } from './yq.ts'

// Probe values chosen to be recognisable in a written blob.
export const STDIO_PROBE = {
  NAME: '__NAME__',
  SIMPLE_NAME: '__SIMPLE_NAME__',
  JSON: {
    command: '__CMD__',
    args: ['__ARG__'],
    env: { __ENV_K__: '__ENV_V__' },
  },
} as const

export interface InferredShape {
  /** Parent key path leading up to the entry key (e.g. ['mcpServers'], ['servers'], ['extensions']). */
  parentPath: string[]
  /** Whether the client uses `$SIMPLE_NAME` (Goose) instead of `$NAME`. */
  keyTransform: 'identity' | 'simpleName'
  /** True when the client wraps entries in an array with a `name` field (Continue.dev). */
  arrayShape: boolean
  /** Static fields injected into every entry (e.g. `{ type: 'stdio' }`, `{ source: 'custom', enabled: true }`). */
  injectFields: Record<string, unknown>
  /** When the client injects a transport tag key, this holds the key name (e.g. `'type'`, `'transport'`). */
  transportTagKey?: 'type' | 'transport'
  /** When the client emits `command` as an array of `[command, ...args]` (OpenCode). */
  commandAsArray: boolean
  /** Renames for spec fields on disk. Empty for standard clients. */
  fieldRenames: {
    command?: string // OpenCode uses `command` but as array
    env?: string // Goose: 'envs', OpenCode: 'environment'
    args?: string
  }
}

class InferError extends Error {}

/**
 * Given a yq evaluation trace against `STDIO_PROBE`, derive the shape.
 * Throws `InferError` if the trace uses a construct we don't yet infer.
 */
export function inferShape(trace: EvalTrace): InferredShape {
  if (trace.writes.length === 0) {
    throw new InferError('yq expression produced no writes')
  }
  // Continue.dev: single append into an array.
  const lastWrite = trace.writes[trace.writes.length - 1]
  if (!lastWrite) throw new InferError('empty writes list')
  if (lastWrite.op === 'append') {
    return inferArrayShape(lastWrite)
  }
  // Standard assign: the last (or only) write is the entry set.
  return inferObjectShape(lastWrite)
}

function inferArrayShape(write: EvalTrace['writes'][number]): InferredShape {
  const parentPath = write.resolvedPath.slice()
  const item = write.written
  if (item == null || typeof item !== 'object' || Array.isArray(item)) {
    throw new InferError('array-append shape: appended item must be an object')
  }
  const obj = item as Record<string, unknown>
  if (obj.name !== STDIO_PROBE.NAME) {
    throw new InferError(
      "array-append shape: expected 'name' field to carry $NAME marker",
    )
  }
  // Same probe-marker skip logic as the object-shape path so spread-in
  // spec fields (command, args, env) are not classified as injects.
  const probeMarkers = new Set<unknown>([
    STDIO_PROBE.JSON.command,
    STDIO_PROBE.JSON.args[0],
  ])
  const { injectFields, transportTagKey } = extractInjectsAndTag(
    obj,
    ['name', 'command', 'args', 'env'],
    probeMarkers,
  )
  return {
    parentPath,
    keyTransform: 'identity',
    arrayShape: true,
    injectFields,
    transportTagKey,
    commandAsArray: false,
    fieldRenames: {},
  }
}

function inferObjectShape(write: EvalTrace['writes'][number]): InferredShape {
  // resolvedPath ends with the entry key: [...parentPath, entryKey].
  if (write.resolvedPath.length === 0) {
    throw new InferError('assign shape: resolvedPath is empty')
  }
  const entryKey = write.resolvedPath[write.resolvedPath.length - 1]
  const parentPath = write.resolvedPath.slice(0, -1)

  // Was the entry key the $NAME marker or the $SIMPLE_NAME marker?
  const keyTransform: 'identity' | 'simpleName' =
    entryKey === STDIO_PROBE.SIMPLE_NAME ? 'simpleName' : 'identity'
  if (entryKey !== STDIO_PROBE.NAME && entryKey !== STDIO_PROBE.SIMPLE_NAME) {
    throw new InferError(
      `assign shape: entry key must be $NAME or $SIMPLE_NAME marker, got "${entryKey}"`,
    )
  }

  const value = write.written
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InferError('assign shape: entry value must be an object')
  }
  const obj = value as Record<string, unknown>

  // OpenCode: command is an array of [__CMD__, ...__ARG__].
  let commandAsArray = false
  const fieldRenames: InferredShape['fieldRenames'] = {}
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v) && v[0] === STDIO_PROBE.JSON.command) {
      commandAsArray = true
    }
    if (v === STDIO_PROBE.JSON.command && k !== 'command')
      fieldRenames.command = k
    if (
      v != null &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      (v as Record<string, unknown>).__ENV_K__ === '__ENV_V__' &&
      k !== 'env'
    ) {
      fieldRenames.env = k
    }
    if (
      Array.isArray(v) &&
      v.length === 1 &&
      v[0] === '__ARG__' &&
      k !== 'args'
    ) {
      fieldRenames.args = k
    }
  }

  const probeMarkers = new Set<unknown>([
    STDIO_PROBE.JSON.command,
    STDIO_PROBE.JSON.env.__ENV_K__,
    STDIO_PROBE.JSON.args[0],
  ])
  const { injectFields, transportTagKey } = extractInjectsAndTag(
    obj,
    [
      'command',
      'args',
      'env',
      fieldRenames.command,
      fieldRenames.args,
      fieldRenames.env,
      // OpenCode array-command shape reuses the key `command` but holds an array.
      // We still treat it as the command field.
      commandAsArray ? 'command' : undefined,
    ].filter((x): x is string => typeof x === 'string'),
    probeMarkers,
  )

  return {
    parentPath,
    keyTransform,
    arrayShape: false,
    injectFields,
    transportTagKey,
    commandAsArray,
    fieldRenames,
  }
}

function extractInjectsAndTag(
  obj: Record<string, unknown>,
  probeKeys: string[],
  probeMarkers?: Set<unknown>,
): {
  injectFields: Record<string, unknown>
  transportTagKey?: 'type' | 'transport'
} {
  const skip = new Set(probeKeys)
  const injectFields: Record<string, unknown> = {}
  let transportTagKey: 'type' | 'transport' | undefined
  for (const [k, v] of Object.entries(obj)) {
    if (skip.has(k)) continue
    // Skip values sourced from the probe (they're not injects; they're spec fields
    // that happened to survive alongside injects).
    if (probeMarkers?.has(v)) continue
    // Transport tag keys carry a value that varies with the transport
    // ('stdio' / 'sse' / 'http'). OpenCode's `type: "local"` is NOT a
    // transport tag; it is a static inject that classifies the entry as
    // running against a local process.
    if (
      (k === 'type' || k === 'transport') &&
      typeof v === 'string' &&
      v === 'stdio'
    ) {
      transportTagKey = k as 'type' | 'transport'
      continue
    }
    injectFields[k] = v
  }
  return { injectFields, transportTagKey }
}
