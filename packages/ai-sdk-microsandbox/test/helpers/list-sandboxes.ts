import { Sandbox, type SandboxHandle } from 'microsandbox'

/**
 * Walk every page of `Sandbox.list()` (0.6.x returns a cursor-paginated
 * `SandboxPage`, not a flat array) and collect all handles. Never throws: on a
 * page fetch error it stops and returns whatever pages were collected first
 * (possibly empty, possibly partial), so best-effort cleanup can proceed.
 */
export async function listAllSandboxes(): Promise<SandboxHandle[]> {
  const all: SandboxHandle[] = []
  let cursor: string | undefined
  do {
    const page = await (cursor === undefined
      ? Sandbox.list()
      : Sandbox.listWith((b) => b.cursor(cursor as string))
    ).catch(() => undefined)
    if (!page) break
    all.push(...page.sandboxes)
    cursor = page.nextCursor
  } while (cursor !== undefined)
  return all
}
