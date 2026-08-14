import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Sandbox, Snapshot } from 'microsandbox'
import { TemplateCache } from '../../src/template-cache.ts'
import { listAllSandboxes } from '../helpers/list-sandboxes.ts'
import { createTmpCacheRoot } from '../helpers/tmp-cache-root.ts'
import {
  DEFAULT_INTEGRATION_IMAGE,
  INTEGRATION_TEST_TIMEOUT_MS,
  requireIntegrationEnv,
} from './_setup.ts'

const describeIntegration = requireIntegrationEnv()

describeIntegration(
  'template-cache: real microsandbox snapshot orchestration',
  () => {
    let cacheRoot = ''
    let cleanupRoot: () => Promise<void> = async () => {}
    const trackedSnapshots: string[] = []

    beforeAll(async () => {
      const tmp = await createTmpCacheRoot()
      cacheRoot = tmp.path
      cleanupRoot = tmp.cleanup
    })

    afterAll(async () => {
      await cleanupRoot()
      // Best-effort cleanup of any snapshots/sandboxes this suite produced.
      for (const name of trackedSnapshots) {
        try {
          await Snapshot.remove(name, { force: true })
        } catch {
          // ignore
        }
      }
      // 0.6.x `Sandbox.list()` is cursor-paginated; listAllSandboxes walks
      // every page so no leftover source sandbox is missed.
      for (const h of await listAllSandboxes()) {
        const cfg = h.config() as { name?: string }
        if (
          typeof cfg.name === 'string' &&
          cfg.name.startsWith('ai-sdk-tpl-src-')
        ) {
          try {
            await h.kill()
          } catch {
            // Best-effort cleanup.
          }
        }
      }
    }, INTEGRATION_TEST_TIMEOUT_MS)

    test(
      'first resolveTemplate bootstraps + snapshots; second is a cache hit',
      async () => {
        const cache = new TemplateCache({ cacheRoot })
        const identity = `integ-1-${Date.now()}`
        let firstCalled = 0
        const t1 = await cache.resolveTemplate({
          identity,
          settings: { image: DEFAULT_INTEGRATION_IMAGE, workdir: '/root' },
          onFirstCreate: async (session) => {
            firstCalled += 1
            await session.writeTextFile({
              path: '/root/marker.txt',
              content: 'set-during-bootstrap',
            })
          },
          builderFactory: (name) => Sandbox.builder(name),
        })
        trackedSnapshots.push(t1.snapshotName)
        expect(firstCalled).toBe(1)

        const t2 = await cache.resolveTemplate({
          identity,
          settings: { image: DEFAULT_INTEGRATION_IMAGE, workdir: '/root' },
          onFirstCreate: async () => {
            firstCalled += 1
          },
          builderFactory: (name) => Sandbox.builder(name),
        })
        expect(firstCalled).toBe(1)
        expect(t2.snapshotName).toBe(t1.snapshotName)
      },
      INTEGRATION_TEST_TIMEOUT_MS,
    )

    test(
      'fresh TemplateCache instance reuses the on-disk snapshot (cross-process resume)',
      async () => {
        const cacheA = new TemplateCache({ cacheRoot })
        const identity = `integ-cross-${Date.now()}`
        let bootstrapCalls = 0
        const t1 = await cacheA.resolveTemplate({
          identity,
          settings: { image: DEFAULT_INTEGRATION_IMAGE, workdir: '/root' },
          onFirstCreate: async () => {
            bootstrapCalls += 1
          },
          builderFactory: (name) => Sandbox.builder(name),
        })
        trackedSnapshots.push(t1.snapshotName)

        // Fresh TemplateCache simulates a Node restart sharing the cache root.
        const cacheB = new TemplateCache({ cacheRoot })
        const t2 = await cacheB.resolveTemplate({
          identity,
          settings: { image: DEFAULT_INTEGRATION_IMAGE, workdir: '/root' },
          onFirstCreate: async () => {
            bootstrapCalls += 1
          },
          builderFactory: (name) => Sandbox.builder(name),
        })
        expect(bootstrapCalls).toBe(1)
        expect(t2.snapshotName).toBe(t1.snapshotName)
      },
      INTEGRATION_TEST_TIMEOUT_MS,
    )

    test(
      'settings change (different workdir) invalidates and rebuilds',
      async () => {
        const cache = new TemplateCache({ cacheRoot })
        const identity = `integ-settings-${Date.now()}`
        let bootstrapCalls = 0
        const t1 = await cache.resolveTemplate({
          identity,
          settings: { image: DEFAULT_INTEGRATION_IMAGE, workdir: '/root' },
          onFirstCreate: async () => {
            bootstrapCalls += 1
          },
          builderFactory: (name) => Sandbox.builder(name),
        })
        trackedSnapshots.push(t1.snapshotName)

        const t2 = await cache.resolveTemplate({
          identity,
          // /var exists in debian:bookworm-slim. The workdir must exist
          // in the image; microsandbox validates it at create time.
          settings: { image: DEFAULT_INTEGRATION_IMAGE, workdir: '/var' },
          onFirstCreate: async () => {
            bootstrapCalls += 1
          },
          builderFactory: (name) => Sandbox.builder(name),
        })
        trackedSnapshots.push(t2.snapshotName)
        expect(bootstrapCalls).toBe(2)
        expect(t2.snapshotName).not.toBe(t1.snapshotName)
      },
      INTEGRATION_TEST_TIMEOUT_MS,
    )

    test(
      'snapshot evaporated out-of-band → next resolveTemplate rebuilds',
      async () => {
        const cache = new TemplateCache({ cacheRoot })
        const identity = `integ-stale-${Date.now()}`
        let bootstrapCalls = 0
        const t1 = await cache.resolveTemplate({
          identity,
          settings: { image: DEFAULT_INTEGRATION_IMAGE, workdir: '/root' },
          onFirstCreate: async () => {
            bootstrapCalls += 1
          },
          builderFactory: (name) => Sandbox.builder(name),
        })
        trackedSnapshots.push(t1.snapshotName)

        // Remove the snapshot out-of-band; the cache should detect and rebuild.
        try {
          await Snapshot.remove(t1.snapshotName, { force: true })
        } catch {
          // ignore: snapshot may already be gone
        }

        const cache2 = new TemplateCache({ cacheRoot })
        const t2 = await cache2.resolveTemplate({
          identity,
          settings: { image: DEFAULT_INTEGRATION_IMAGE, workdir: '/root' },
          onFirstCreate: async () => {
            bootstrapCalls += 1
          },
          builderFactory: (name) => Sandbox.builder(name),
        })
        trackedSnapshots.push(t2.snapshotName)
        expect(bootstrapCalls).toBe(2)
      },
      INTEGRATION_TEST_TIMEOUT_MS,
    )

    test(
      'two concurrent resolveTemplate calls bootstrap once (in-process dedup)',
      async () => {
        const cache = new TemplateCache({ cacheRoot })
        const identity = `integ-concurrent-${Date.now()}`
        let bootstrapCalls = 0
        const [a, b] = await Promise.all([
          cache.resolveTemplate({
            identity,
            settings: {
              image: DEFAULT_INTEGRATION_IMAGE,
              workdir: '/root',
            },
            onFirstCreate: async () => {
              bootstrapCalls += 1
            },
            builderFactory: (name) => Sandbox.builder(name),
          }),
          cache.resolveTemplate({
            identity,
            settings: {
              image: DEFAULT_INTEGRATION_IMAGE,
              workdir: '/root',
            },
            onFirstCreate: async () => {
              bootstrapCalls += 1
            },
            builderFactory: (name) => Sandbox.builder(name),
          }),
        ])
        trackedSnapshots.push(a.snapshotName)
        expect(bootstrapCalls).toBe(1)
        expect(a.snapshotName).toBe(b.snapshotName)
      },
      INTEGRATION_TEST_TIMEOUT_MS,
    )
  },
)
