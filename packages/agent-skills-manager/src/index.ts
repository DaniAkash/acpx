import './_internal/telemetry-guard.ts'

export {
  detectInstalledAgents,
  isAgentSupported,
  listSupportedAgents,
  resolveAgentSkillsDir,
} from './agents.ts'
export {
  AgentNotSupportedError,
  ForeignPathError,
  SkillNotFoundError,
  SkillsManagerError,
  SourceParseError,
} from './errors.ts'
export type { SkillsManager } from './manager.ts'
export { createSkillsManager } from './manager.ts'
export { parseSourceInput } from './source.ts'
export type {
  AddSkillOptions,
  AddSkillResult,
  AgentId,
  AgentInfo,
  InstalledSkill,
  LinkSkillOptions,
  LinkSkillResult,
  ListLinksOptions,
  ListSkillsOptions,
  ManifestLinkEntry,
  ManifestSkillEntry,
  RemoveSkillOptions,
  RescanOptions,
  RescanResult,
  SkillLink,
  SkillManifest,
  SkillSource,
  SkillsManagerOptions,
  SystemPromptOption,
  UnlinkSkillOptions,
  UnlinkSkillResult,
} from './types.ts'

export const VERSION = '1.0.0'
