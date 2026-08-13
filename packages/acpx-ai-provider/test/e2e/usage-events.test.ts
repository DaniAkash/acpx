/**
 * End-to-end contract tests for the live usage events,
 * available-commands subscription, and slash-command helpers added in
 * #35 — against a real codex agent.
 *
 * NOT run in CI — spawns a real codex-acp process and runs against
 * the OpenAI API for the prompt turns. The unit tests in
 * `test/unit/usage-events.test.ts` cover the in-memory wiring
 * (callbacks fire, snapshots stored, EventEmitter emits) using
 * `MockAcpRuntime`. This file covers the wire-level question the mock
 * harness can't reach: does the runtime actually emit `usage_update`
 * and `available_commands_update` against a live agent, and does
 * `runSlashCommand` round-trip cleanly through one?
 *
 * How to run:
 *
 *   SMOKE_AGENTS=codex bun test test/e2e/usage-events.test.ts
 *
 *   # Or as part of the broader smoke battery
 *   SMOKE_AGENTS=all bun test test/e2e
 *
 * Prerequisites: codex CLI authenticated locally. Set
 * ACPX_AUTH_OPENAI_API_KEY or OPENAI_API_KEY before running, or
 * use ChatGPT auth via `codex login`.
 *
 * Why codex: codex's adapter ships a rich command set
 * (mcp / skills / status / logout plus locally-installed skills)
 * which makes available_commands_update easy to verify. Codex does
 * NOT populate `_meta.usage` or `cost` on its `usage_update` events,
 * which lets us also pin the defensive-omit behaviour on the wire.
 * Claude populates the breakdown — a complementary Claude e2e is a
 * future follow-up.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AcpRuntimeAvailableCommand } from 'acpx/runtime'
import { generateText, stepCountIs } from 'ai'
import { createAcpxProvider } from '../../src/index.ts'
import type { AcpxProvider } from '../../src/provider.ts'
import type { AcpxUsageSnapshot } from '../../src/types.ts'

const REQUESTED = (process.env.SMOKE_AGENTS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const ALL_REQUESTED =
  REQUESTED.includes('all') || process.env.RUN_E2E_AGENT_TESTS === '1'
const shouldRun = ALL_REQUESTED || REQUESTED.includes('codex')

const TURN_TIMEOUT_MS = 90_000
const TEST_TIMEOUT_MS = 2 * TURN_TIMEOUT_MS

let scratchDir = ''

beforeAll(async () => {
  if (!shouldRun) return
  scratchDir = await mkdtemp(join(tmpdir(), 'acpx-usage-events-'))
})

afterAll(async () => {
  if (scratchDir) await rm(scratchDir, { recursive: true, force: true })
})

function makeProvider(sessionKey: string): AcpxProvider {
  return createAcpxProvider({
    agent: 'codex',
    cwd: scratchDir,
    sessionKey,
    permissionMode: 'approve-all',
    nonInteractivePermissions: 'deny',
    turnTimeoutMs: TURN_TIMEOUT_MS,
  })
}

describe.skipIf(!shouldRun)(
  'e2e: live usage + available-commands + runSlashCommand (codex)',
  () => {
    test(
      'usage_update fires through provider.events.on("usage") with real used/size; cost and breakdown stay undefined (codex defensive-omit)',
      async () => {
        const sessionKey = `usage-${Date.now()}`
        const provider = makeProvider(sessionKey)
        const snapshots: AcpxUsageSnapshot[] = []
        provider.events.on('usage', (s) => snapshots.push(s))

        try {
          await generateText({
            model: provider.languageModel(),
            prompt: "Respond with exactly the word 'pong' and nothing else.",
            stopWhen: stepCountIs(2),
          })
        } finally {
          try {
            await provider.close('test cleanup')
          } catch {
            // codex-acp does not always implement session/close; the
            // proof script captures the same behaviour. Don't fail
            // the test on close.
          }
        }

        // At least one usage_update arrived during the turn.
        expect(snapshots.length).toBeGreaterThan(0)

        const first = snapshots[0]
        if (!first) throw new Error('expected at least one usage snapshot')
        expect(first.sessionKey).toBe(sessionKey)
        expect(typeof first.at).toBe('number')
        expect(first.at).toBeLessThanOrEqual(Date.now())

        // Codex carries used + size on every usage_update.
        expect(typeof first.used).toBe('number')
        expect(first.used).toBeGreaterThan(0)
        expect(typeof first.size).toBe('number')
        expect(first.size).toBeGreaterThan(0)

        // Codex 0.13x does NOT populate cost or _meta.usage. The
        // normalizer's defensive-omit behaviour means those fields
        // are absent (not synthesized as empty objects).
        expect(first.cost).toBeUndefined()
        expect(first.breakdown).toBeUndefined()

        // Sync getter mirrors the latest snapshot.
        const synced = provider.getUsage(sessionKey)
        expect(synced).toBeDefined()
        expect(synced?.used).toBe(snapshots.at(-1)?.used)
        expect(synced?.size).toBe(snapshots.at(-1)?.size)
      },
      TEST_TIMEOUT_MS,
    )

    test(
      'available_commands_update fires through provider.events.on("availableCommands") with the rich structured list',
      async () => {
        const sessionKey = `cmds-${Date.now()}`
        const provider = makeProvider(sessionKey)
        const events: Array<{
          sessionKey: string
          commands: AcpRuntimeAvailableCommand[]
        }> = []
        provider.events.on('availableCommands', (e) => events.push(e))

        try {
          await generateText({
            model: provider.languageModel(),
            prompt: "Respond with exactly 'ok' and nothing else.",
            stopWhen: stepCountIs(2),
          })
        } finally {
          try {
            await provider.close('test cleanup')
          } catch {
            // see test 1
          }
        }

        // At least one available_commands_update arrived.
        expect(events.length).toBeGreaterThan(0)
        const first = events[0]
        if (!first) throw new Error('expected at least one commands event')
        const { sessionKey: emittedKey, commands } = first
        expect(emittedKey).toBe(sessionKey)

        // Codex always advertises at minimum mcp / skills / status / logout
        // as built-in commands (in addition to any locally-installed
        // skill-prefixed entries).
        expect(commands.length).toBeGreaterThan(0)
        const names = new Set(commands.map((c) => c.name))
        expect(names.has('status')).toBe(true)
        expect(names.has('logout')).toBe(true)

        // The rich shape — at least one entry carries a description
        // string. (The defensive-omit-on-empty behaviour means entries
        // without descriptions don't synthesize a key.)
        const withDescription = commands.find(
          (c) => typeof c.description === 'string' && c.description.length > 0,
        )
        expect(withDescription).toBeDefined()

        // hasInput surfaces verbatim from the wire. Codex's built-in
        // commands don't advertise input schemas, so all entries
        // should report hasInput=false in this run.
        expect(commands.every((c) => c.hasInput === false)).toBe(true)

        // Sync getter returns the same list under the same sessionKey.
        const synced = provider.getAvailableCommands(sessionKey)
        expect(synced.length).toBe(commands.length)
        expect(synced.map((c) => c.name).sort()).toEqual(
          commands.map((c) => c.name).sort(),
        )
      },
      TEST_TIMEOUT_MS,
    )

    test(
      'runSlashCommand round-trips a built-in codex command (/status) without throwing',
      async () => {
        const sessionKey = `slash-${Date.now()}`
        const provider = makeProvider(sessionKey)

        try {
          // Warm up the ACP session by running one real turn. The
          // available_commands_update event only flows through the
          // EventTranslator callback during an active turn (not during
          // ensureSession), so a no-op prepare() leaves the provider's
          // commands map empty. One small turn populates it.
          await generateText({
            model: provider.languageModel(),
            prompt: "Respond with exactly 'ready' and nothing else.",
            stopWhen: stepCountIs(2),
          })

          // Sanity: the command we're about to send is advertised
          // (if codex changes its built-in set we want to know).
          const advertised = provider.getAvailableCommands(sessionKey)
          expect(advertised.some((c) => c.name === 'status')).toBe(true)

          // Send /status as a one-shot prompt. The adapter executes
          // the slash command on its side; we just need the turn to
          // complete cleanly with no thrown error and no failed result.
          await provider.runSlashCommand({
            name: '/status',
            sessionKey,
            timeoutMs: TURN_TIMEOUT_MS,
          })
        } finally {
          try {
            await provider.close('test cleanup')
          } catch {
            // see test 1
          }
        }

        // If we got here, runSlashCommand completed without throwing.
        // That's the full contract this test pins — agent-side state
        // changes are not in scope for the round-trip check.
        expect(true).toBe(true)
      },
      TEST_TIMEOUT_MS,
    )
  },
)
