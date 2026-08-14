import { listAllSandboxes } from '../../helpers/list-sandboxes.ts'

/**
 * Best-effort cleanup of e2e-produced sandboxes. Kills any sandbox whose
 * name starts with `ai-sdk-harness-`. Template source sandboxes
 * (`ai-sdk-tpl-src-*`) are intentionally KEPT — they back the cached
 * snapshot the suite shares; killing them does not invalidate the
 * snapshot, but it does waste a future stop+remove cycle.
 *
 * Run manually with `bun run test:e2e:cleanup` to wipe the full state.
 */
export async function purgeE2eSandboxes(): Promise<void> {
  await purgeMatching((name) => name.startsWith('ai-sdk-harness-'))
}

/**
 * Per-test hook: remove just the harness forks produced by the most
 * recently finished test. Run from `afterEach` in every e2e file so
 * sandbox count stays bounded across the suite. Each microVM holds
 * real CPU and memory reservations; without this, ~6-8 leftover VMs
 * exhaust the host and the bridge starts failing to bind.
 */
export async function purgeHarnessForks(): Promise<void> {
  await purgeMatching((name) => name.startsWith('ai-sdk-harness-'))
}

async function purgeMatching(
  predicate: (name: string) => boolean,
): Promise<void> {
  const handles = await listAllSandboxes()
  for (const h of handles) {
    const cfg = h.config() as { name?: string }
    if (typeof cfg.name !== 'string') continue
    if (!predicate(cfg.name)) continue
    try {
      await h.kill()
    } catch {
      // ignore; sandbox may already be gone
    }
  }
}
