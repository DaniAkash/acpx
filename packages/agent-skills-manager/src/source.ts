import { existsSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { SourceParseError } from './errors.ts'
import type { SkillSource } from './types.ts'

const OWNER_REPO_RE = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i
const GIT_URL_RE =
  /^(?:https?:\/\/|git@|git\+ssh:\/\/|git:\/\/|ssh:\/\/).+\.git(?:#.+)?$/i
const HTTPS_GITHUB_RE =
  /^https:\/\/github\.com\/([^/]+)\/([^/.#]+)(?:\.git)?(?:#(.+))?$/i

// Known shorthand aliases mapped to their canonical repo before parsing,
// mirroring the upstream skills CLI.
const SOURCE_ALIASES: Record<string, string> = {
  'vercel-labs/vercel-skills': 'vercel-labs/agent-skills',
}

/**
 * Parse a user-supplied source string into a `SkillSource`. Accepted forms:
 *
 * - `owner/repo`                — github shorthand
 * - `owner/repo#ref`            — github shorthand with ref
 * - `https://github.com/owner/repo[.git][#ref]` — github URL
 * - any other `*.git` URL       — generic git URL
 * - any path that exists on disk — local path (absolute or relative to cwd)
 *
 * .well-known endpoints and GitLab URLs are deferred to a future release.
 */
export function parseSourceInput(source: string): SkillSource {
  const raw = source.trim()
  const trimmed = SOURCE_ALIASES[raw] ?? raw
  if (!trimmed) throw new SourceParseError('Empty source string')

  // 1) GitHub https URL (with optional ref).
  const ghMatch = trimmed.match(HTTPS_GITHUB_RE)
  if (ghMatch) {
    const ownerRepo = `${ghMatch[1]}/${ghMatch[2]}`
    return ghMatch[3]
      ? { kind: 'github', ownerRepo, ref: ghMatch[3] }
      : { kind: 'github', ownerRepo }
  }

  // 2) owner/repo shorthand (with optional #ref).
  const refIdx = trimmed.indexOf('#')
  const beforeRef = refIdx === -1 ? trimmed : trimmed.slice(0, refIdx)
  const ref = refIdx === -1 ? undefined : trimmed.slice(refIdx + 1)
  if (OWNER_REPO_RE.test(beforeRef)) {
    return ref
      ? { kind: 'github', ownerRepo: beforeRef, ref }
      : { kind: 'github', ownerRepo: beforeRef }
  }

  // 3) Generic git URL.
  if (GIT_URL_RE.test(trimmed)) {
    const hashIdx = trimmed.lastIndexOf('#')
    const url = hashIdx === -1 ? trimmed : trimmed.slice(0, hashIdx)
    const gitRef = hashIdx === -1 ? undefined : trimmed.slice(hashIdx + 1)
    return gitRef
      ? { kind: 'gitUrl', url, ref: gitRef }
      : { kind: 'gitUrl', url }
  }

  // 4) Local path.
  const absolute = isAbsolute(trimmed)
    ? trimmed
    : resolve(process.cwd(), trimmed)
  if (existsSync(absolute) && statSync(absolute).isDirectory()) {
    return { kind: 'local', path: absolute }
  }

  throw new SourceParseError(
    `Unrecognized source: "${source}" — expected owner/repo, a git URL, or an existing local path`,
  )
}
