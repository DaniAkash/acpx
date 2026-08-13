import type { ClientConfig } from '../_catalog/types.ts'
import type { AgentScope, McpServerSpec } from '../types.ts'
import { jsonAdd, jsonRead, jsonRemove } from './json.ts'
import { resolveShapes } from './shape.ts'
import { tomlAdd, tomlRead, tomlRemove } from './toml.ts'
import { yamlAdd, yamlRead, yamlRemove } from './yaml.ts'

export interface EmitterIO {
  read(raw: string): string[]
  add(raw: string, name: string, spec: McpServerSpec): string
  remove(raw: string, name: string): string
}

/**
 * Pick the read/add/remove trio for the given client and scope. The
 * format (json / jsonc / yaml / toml) selects the serialiser; the
 * per-client stdio + http shapes drive every field-name / injection /
 * tag decision. The returned functions close over the resolved shapes,
 * so callers only pass raw file contents, name, and spec.
 */
export function getEmitter(
  client: ClientConfig,
  scope: AgentScope = 'system',
): EmitterIO {
  const shapes = resolveShapes(client, scope)
  if (client.format === 'yaml') {
    return {
      read: (raw) => yamlRead(raw, shapes),
      add: (raw, name, spec) => yamlAdd(raw, name, spec, shapes),
      remove: (raw, name) => yamlRemove(raw, name, shapes),
    }
  }
  if (client.format === 'toml') {
    return {
      read: (raw) => tomlRead(raw, shapes),
      add: (raw, name, spec) => tomlAdd(raw, name, spec, shapes),
      remove: (raw, name) => tomlRemove(raw, name, shapes),
    }
  }
  // json and jsonc share the same emitter (jsonc-parser handles both).
  return {
    read: (raw) => jsonRead(raw, shapes),
    add: (raw, name, spec) => jsonAdd(raw, name, spec, shapes),
    remove: (raw, name) => jsonRemove(raw, name, shapes),
  }
}
