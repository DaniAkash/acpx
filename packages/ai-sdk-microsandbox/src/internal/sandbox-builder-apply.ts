import type { SandboxBuilder } from 'microsandbox'
import { translateNetworkPolicy } from '../network-policy.ts'
import type {
  MicrosandboxCreateSettings,
  MicrosandboxPortSetting,
} from '../settings.ts'

/**
 * Default host bind address used by microsandbox when only `port(host, guest)`
 * is called. Mirrors what we treat as the implicit case in `applyPort`.
 */
const IMPLICIT_BIND = '127.0.0.1'

/**
 * Apply create-mode settings onto a microsandbox `SandboxBuilder`. Pure
 * function — no provider state, returns the builder so the provider can chain
 * `.create()` itself. Reusable from any path that constructs a sandbox from
 * settings (including the snapshot-template path).
 */
export function applyCreateSettings(
  builder: SandboxBuilder,
  settings: MicrosandboxCreateSettings,
): SandboxBuilder {
  let b = builder.image(settings.image)
  b = applyRuntimeSettings(b, settings)
  return b
}

/**
 * Apply settings to a fork that's being created `fromSnapshot()`. The
 * snapshot already pins the image; calling `.image(...)` again would be
 * rejected by microsandbox. Everything else (cpus / memory / workdir / env /
 * ports / networkPolicy / replace) is runtime-only and re-applied at fork
 * time so a single template can support a range of fork configurations.
 */
export function applyForkSettings(
  builder: SandboxBuilder,
  settings: MicrosandboxCreateSettings,
): SandboxBuilder {
  return applyRuntimeSettings(builder, settings)
}

function applyRuntimeSettings(
  builder: SandboxBuilder,
  settings: MicrosandboxCreateSettings,
): SandboxBuilder {
  let b = builder
  if (settings.cpus !== undefined) b = b.cpus(settings.cpus)
  if (settings.memory !== undefined) b = b.memory(settings.memory)
  if (settings.workdir !== undefined) b = b.workdir(settings.workdir)
  if (settings.env !== undefined) b = b.envs(settings.env)
  if (settings.replace !== undefined) {
    if (typeof settings.replace === 'boolean') {
      if (settings.replace) b = b.replace()
    } else {
      b = b.replaceWithTimeout(settings.replace.timeoutMs)
    }
  }
  for (const port of settings.ports ?? []) {
    b = applyPort(b, port)
  }
  if (settings.networkPolicy !== undefined) {
    const networkPolicy = translateNetworkPolicy(settings.networkPolicy)
    b = b.network((nb) => nb.policy(networkPolicy))
  }
  return b
}

function applyPort(
  builder: SandboxBuilder,
  port: MicrosandboxPortSetting,
): SandboxBuilder {
  const isUdp = port.protocol === 'udp'
  const hasExplicitBind = port.bind !== undefined && port.bind !== IMPLICIT_BIND
  if (isUdp && hasExplicitBind) {
    return builder.portUdpBind(port.bind as string, port.host, port.guest)
  }
  if (isUdp) {
    return builder.portUdp(port.host, port.guest)
  }
  if (hasExplicitBind) {
    return builder.portBind(port.bind as string, port.host, port.guest)
  }
  return builder.port(port.host, port.guest)
}
