import type {
  HarnessV1NetworkSandboxSession as HarnessNetworkSession,
  HarnessV1SandboxProvider,
} from '@ai-sdk/harness'
import type { Experimental_SandboxSession } from '@ai-sdk/provider-utils'
import type { Sandbox, SandboxBuilder } from 'microsandbox'
import { Sandbox as SandboxClass } from 'microsandbox'
import { applyCreateSettings } from './internal/sandbox-builder-apply.ts'
import { autoSessionName, sessionSandboxName } from './internal/session-name.ts'
import {
  MICROSANDBOX_PROVIDER_ID,
  MicrosandboxNetworkSandboxSession,
} from './microsandbox-network-sandbox-session.ts'
import type { ResolvedPort } from './port-resolver.ts'
import type {
  MicrosandboxCreateSettings,
  MicrosandboxSettings,
} from './settings.ts'
import {
  isMicrosandboxCreateSettings,
  validateMicrosandboxSettings,
} from './settings.ts'
import {
  buildForkFromSnapshot,
  type OnFirstCreateFn,
  TemplateCache,
  type TemplateCacheOptions,
} from './template-cache.ts'

const DEFAULT_BIND = '127.0.0.1'

/**
 * Test-only seam: replaces the `Sandbox.builder(name)` factory so unit tests
 * can intercept the builder chain without spinning up the NAPI binding.
 * Exported so the public signature of {@link createMicrosandbox} can mention
 * it, but consumers should not pass this option in production.
 */
export type SandboxBuilderFactory = (name: string) => SandboxBuilder

/**
 * Test-only seam: replaces the sandbox-resume entrypoint so unit tests can
 * verify the resume path without touching the NAPI binding. The default
 * implementation calls `Sandbox.get(name)` and then dispatches to
 * `handle.connect()` (running sandboxes, e.g. after `session.detach()`)
 * or `handle.start()` (stopped sandboxes).
 */
export type SandboxStarter = (name: string) => Promise<Sandbox>

/** Test-only seam options. See {@link SandboxBuilderFactory}. */
export interface MicrosandboxProviderInternals {
  readonly builderFactory?: SandboxBuilderFactory
  readonly sandboxStart?: SandboxStarter
  /**
   * Override the {@link TemplateCache} the provider uses for the
   * identity/onFirstCreate snapshot path. Defaults to a cache constructed
   * with the system-conventional cache root and microsandbox's real
   * snapshot API. Test code passes a cache with a tmp root + mock
   * snapshot API.
   */
  readonly templateCache?: TemplateCache
  /**
   * Forwarded to a freshly-constructed {@link TemplateCache} when
   * `templateCache` itself isn't provided. Lets consumers nudge the
   * cache root without taking on the rest of the construction.
   */
  readonly templateCacheOptions?: TemplateCacheOptions
}

/**
 * `HarnessV1SandboxProvider` implementation backed by microsandbox. Construct
 * via {@link createMicrosandbox} at module scope; pass the provider to a
 * `HarnessAgent` (or call `createSession()` directly for raw access to a
 * network sandbox session).
 *
 * Wrap mode (`settings.sandbox` set) wraps a caller-managed `Sandbox`; create
 * mode mints a fresh sandbox per session via `Sandbox.builder(name)`. When
 * the harness passes `identity` + `onFirstCreate`, the provider routes
 * through {@link TemplateCache}: bootstrap runs once per identity, the
 * resulting sandbox is snapshotted, and subsequent sessions fork from the
 * snapshot via `Sandbox.builder().fromSnapshot()`.
 */
export class MicrosandboxProvider implements HarnessV1SandboxProvider {
  readonly specificationVersion: 'harness-sandbox-v1' = 'harness-sandbox-v1'
  readonly providerId: string = MICROSANDBOX_PROVIDER_ID
  readonly bridgePorts?: ReadonlyArray<number>

  private readonly settings: MicrosandboxSettings
  private readonly builderFactory: SandboxBuilderFactory
  private readonly sandboxStart: SandboxStarter
  private readonly templateCache: TemplateCache

  constructor(
    settings: MicrosandboxSettings,
    _internal: MicrosandboxProviderInternals = {},
  ) {
    validateMicrosandboxSettings(settings)
    this.settings = settings
    this.builderFactory =
      _internal.builderFactory ?? ((name: string) => SandboxClass.builder(name))
    this.sandboxStart =
      _internal.sandboxStart ??
      (async (name: string) => {
        // Resume into the named sandbox. If it's still running (the
        // `session.detach()` path), reattach via `handle.connect()`.
        // Otherwise resume from stopped via `handle.start()`. Calling
        // `Sandbox.start(name)` directly on a running sandbox rejects
        // with `SandboxStillRunning`.
        const handle = await SandboxClass.get(name)
        if (handle.status === 'running') {
          return (await handle.connect()) as Sandbox
        }
        return (await handle.start()) as Sandbox
      })
    this.templateCache =
      _internal.templateCache ??
      new TemplateCache(_internal.templateCacheOptions)
    if (
      'sandbox' in settings &&
      settings.sandbox != null &&
      settings.bridgePorts &&
      settings.bridgePorts.length > 0
    ) {
      this.bridgePorts = [...settings.bridgePorts]
    }
  }

  createSession = async (options?: {
    sessionId?: string
    abortSignal?: AbortSignal
    identity?: string
    onFirstCreate?: (
      session: Experimental_SandboxSession,
      opts: { abortSignal?: AbortSignal },
    ) => Promise<void>
  }): Promise<HarnessNetworkSession> => {
    options?.abortSignal?.throwIfAborted()

    if (this.isWrapMode()) {
      // Wrap mode owns its own sandbox; identity/onFirstCreate are ignored.
      return await this.createWrappedSession()
    }

    if (options?.identity != null && options.onFirstCreate != null) {
      return await this.createForkSession({
        identity: options.identity,
        onFirstCreate: options.onFirstCreate,
        sessionId: options.sessionId,
        abortSignal: options.abortSignal,
      })
    }

    return await this.createFreshSession(options)
  }

  resumeSession = async (options: {
    sessionId: string
    abortSignal?: AbortSignal
  }): Promise<HarnessNetworkSession> => {
    options.abortSignal?.throwIfAborted()

    if (this.isWrapMode()) {
      // Wrap mode: caller owns the sandbox lifecycle; sessionId carries no
      // identity here, so resume reduces to a fresh wrap over the same vm.
      return await this.createWrappedSession()
    }

    if (!isMicrosandboxCreateSettings(this.settings)) {
      throw new Error('resumeSession called outside create mode')
    }
    const settings: MicrosandboxCreateSettings = this.settings
    const name = sessionSandboxName(options.sessionId)
    const sandbox = (await this.sandboxStart(name)) as Sandbox
    options.abortSignal?.throwIfAborted()
    return await MicrosandboxNetworkSandboxSession.create({
      sandbox,
      ports: createModePorts(settings),
      publicHostname: settings.publicHostname,
      ownsLifecycle: true,
      configuredWorkdir: settings.workdir,
    })
  }

  private isWrapMode(): boolean {
    return 'sandbox' in this.settings && this.settings.sandbox != null
  }

  private async createWrappedSession(): Promise<HarnessNetworkSession> {
    if (!('sandbox' in this.settings && this.settings.sandbox != null)) {
      throw new Error('createWrappedSession called outside wrap mode')
    }
    const ports = wrapModePorts(this.settings.bridgePorts ?? [])
    return await MicrosandboxNetworkSandboxSession.create({
      sandbox: this.settings.sandbox as Sandbox,
      ports,
      publicHostname: this.settings.publicHostname,
      ownsLifecycle: false,
    })
  }

  private async createFreshSession(options?: {
    sessionId?: string
    abortSignal?: AbortSignal
  }): Promise<HarnessNetworkSession> {
    if (!isMicrosandboxCreateSettings(this.settings)) {
      throw new Error('createFreshSession called outside create mode')
    }
    const settings: MicrosandboxCreateSettings = this.settings
    const name = options?.sessionId
      ? sessionSandboxName(options.sessionId)
      : (settings.name ?? autoSessionName())
    const builder = applyCreateSettings(this.builderFactory(name), settings)
    options?.abortSignal?.throwIfAborted()
    const sandbox = (await builder.create()) as Sandbox
    return await MicrosandboxNetworkSandboxSession.create({
      sandbox,
      ports: createModePorts(settings),
      publicHostname: settings.publicHostname,
      ownsLifecycle: true,
      configuredWorkdir: settings.workdir,
    })
  }

  private async createForkSession(input: {
    identity: string
    onFirstCreate: OnFirstCreateFn
    sessionId: string | undefined
    abortSignal: AbortSignal | undefined
  }): Promise<HarnessNetworkSession> {
    if (!isMicrosandboxCreateSettings(this.settings)) {
      throw new Error('createForkSession called outside create mode')
    }
    const settings: MicrosandboxCreateSettings = this.settings

    const { snapshotName } = await this.templateCache.resolveTemplate({
      identity: input.identity,
      settings,
      onFirstCreate: input.onFirstCreate,
      builderFactory: this.builderFactory,
      abortSignal: input.abortSignal,
    })

    input.abortSignal?.throwIfAborted()
    const forkName = input.sessionId
      ? sessionSandboxName(input.sessionId)
      : autoSessionName()
    const builder = buildForkFromSnapshot({
      builderFactory: this.builderFactory,
      forkName,
      snapshotName,
      settings,
    })
    input.abortSignal?.throwIfAborted()
    const sandbox = (await builder.create()) as Sandbox
    return await MicrosandboxNetworkSandboxSession.create({
      sandbox,
      ports: createModePorts(settings),
      publicHostname: settings.publicHostname,
      ownsLifecycle: true,
      configuredWorkdir: settings.workdir,
    })
  }
}

function wrapModePorts(
  bridgePorts: ReadonlyArray<number>,
): ReadonlyArray<ResolvedPort> {
  return bridgePorts.map((port) => ({ port, bind: DEFAULT_BIND }))
}

function createModePorts(
  settings: MicrosandboxCreateSettings,
): ReadonlyArray<ResolvedPort> {
  return (settings.ports ?? []).map((p) => ({
    port: p.host,
    bind: p.bind ?? DEFAULT_BIND,
  }))
}

/** Convenience factory mirroring the official `@ai-sdk/sandbox-vercel` shape. */
export function createMicrosandbox(
  settings: MicrosandboxSettings,
  _internal?: MicrosandboxProviderInternals,
): MicrosandboxProvider {
  return new MicrosandboxProvider(settings, _internal)
}
