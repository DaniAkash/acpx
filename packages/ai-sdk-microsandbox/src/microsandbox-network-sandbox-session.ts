import type { HarnessV1NetworkSandboxSession } from '@ai-sdk/harness'
import type { Experimental_SandboxSession } from '@ai-sdk/provider-utils'
import type { Sandbox } from 'microsandbox'
import { Sandbox as SandboxClass } from 'microsandbox'
import { MicrosandboxSandboxSession } from './microsandbox-sandbox-session.ts'
import { PortResolver, type ResolvedPort } from './port-resolver.ts'

export const MICROSANDBOX_PROVIDER_ID = 'microsandbox'

/** Default working directory used when the sandbox config doesn't declare one. */
export const DEFAULT_WORKING_DIRECTORY = '/'

/**
 * Resolve a session's default working directory. Prefers the caller-supplied
 * configured workdir (create mode), falling back to the sandbox's own config
 * readback (wrap mode), then to {@link DEFAULT_WORKING_DIRECTORY}.
 */
async function resolveDefaultWorkingDirectory(
  sandbox: Sandbox,
  configured: string | undefined,
): Promise<string> {
  if (typeof configured === 'string' && configured.length > 0) {
    return configured
  }
  const config = (await sandbox.config()) as { workdir?: unknown }
  return typeof config.workdir === 'string' && config.workdir.length > 0
    ? config.workdir
    : DEFAULT_WORKING_DIRECTORY
}

export interface MicrosandboxNetworkSandboxSessionInput {
  readonly sandbox: Sandbox
  readonly ports: ReadonlyArray<ResolvedPort>
  readonly publicHostname?: string
  /**
   * Whether this session owns the sandbox's lifecycle. `false` means the
   * caller (typically the provider in wrap mode) manages it; `stop()` and
   * `destroy()` are no-ops.
   */
  readonly ownsLifecycle: boolean
  /** Cached default working directory. See {@link create} for the factory. */
  readonly defaultWorkingDirectory: string
}

/**
 * `HarnessV1NetworkSandboxSession` implementation backed by a microsandbox
 * `Sandbox`. Extends {@link MicrosandboxSandboxSession} with the network +
 * lifecycle surface the harness requires.
 *
 * Construct via the static {@link MicrosandboxNetworkSandboxSession.create}
 * factory — `defaultWorkingDirectory` is a sync field on the harness type but
 * microsandbox surfaces it through async `sandbox.config()`, so the factory
 * awaits the config once and caches the value.
 *
 * Omits the optional `setNetworkPolicy?` / `setPorts?` methods — microsandbox
 * seals network policy and ports at create-time. The harness contract treats
 * absent optional methods as no-ops via the `sandbox.setPorts?.(...)` pattern.
 */
export class MicrosandboxNetworkSandboxSession
  extends MicrosandboxSandboxSession
  implements
    Pick<
      HarnessV1NetworkSandboxSession,
      | 'id'
      | 'defaultWorkingDirectory'
      | 'ports'
      | 'getPortUrl'
      | 'stop'
      | 'destroy'
      | 'restricted'
    >
{
  readonly id: string
  readonly defaultWorkingDirectory: string
  readonly ports: ReadonlyArray<number>

  private readonly resolver: PortResolver
  private readonly ownsLifecycle: boolean
  private readonly resolvedPorts: ReadonlyArray<ResolvedPort>

  constructor(input: MicrosandboxNetworkSandboxSessionInput) {
    super(input.sandbox)
    this.id = input.sandbox.name
    this.defaultWorkingDirectory = input.defaultWorkingDirectory
    this.resolvedPorts = input.ports
    this.ports = input.ports.map((p) => p.port)
    this.resolver = new PortResolver({
      ports: input.ports,
      publicHostname: input.publicHostname,
      providerId: MICROSANDBOX_PROVIDER_ID,
    })
    this.ownsLifecycle = input.ownsLifecycle
  }

  /**
   * Async factory that resolves the sandbox's default working directory from
   * its config before constructing the session. Callers (typically the
   * provider) use this instead of `new MicrosandboxNetworkSandboxSession(...)`
   * directly.
   */
  static async create(input: {
    sandbox: Sandbox
    ports: ReadonlyArray<ResolvedPort>
    publicHostname?: string
    ownsLifecycle: boolean
    /**
     * The workdir the sandbox was configured with, when the caller knows it
     * (create mode). Preferred over reading it back from `sandbox.config()`:
     * microsandbox 0.6.x stopped populating the config's `workdir` from the
     * builder's `.workdir(...)`, so the readback reports `/`. Omitted in wrap
     * mode, where the caller owns the sandbox and the config readback is the
     * only available source.
     */
    configuredWorkdir?: string
  }): Promise<MicrosandboxNetworkSandboxSession> {
    const { configuredWorkdir, ...sessionInput } = input
    const workdir = await resolveDefaultWorkingDirectory(
      sessionInput.sandbox,
      configuredWorkdir,
    )
    return new MicrosandboxNetworkSandboxSession({
      ...sessionInput,
      defaultWorkingDirectory: workdir,
    })
  }

  async getPortUrl(options: {
    port: number
    protocol?: 'http' | 'https' | 'ws'
  }): Promise<string> {
    return this.resolver.resolve(options)
  }

  async stop(): Promise<void> {
    if (!this.ownsLifecycle) return
    await this.sandbox.stop()
  }

  async destroy(): Promise<void> {
    if (!this.ownsLifecycle) return
    await this.sandbox.stop().catch(() => {
      // Best-effort: sandbox may already be stopped.
    })
    await SandboxClass.remove(this.sandbox.name).catch(() => {
      // Best-effort: sandbox may already be removed from the database.
    })
  }

  restricted(): Experimental_SandboxSession {
    return new MicrosandboxSandboxSession(this.sandbox)
  }

  /** @internal — for tests that need to introspect the resolved port list. */
  get internalResolvedPorts(): ReadonlyArray<ResolvedPort> {
    return this.resolvedPorts
  }
}
