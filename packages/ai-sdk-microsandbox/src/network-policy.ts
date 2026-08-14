import type { HarnessV1NetworkPolicy } from '@ai-sdk/harness'
import { Destination, type NetworkPolicy, Rule } from 'microsandbox'

/**
 * Translate a harness {@link HarnessV1NetworkPolicy} into a microsandbox
 * {@link NetworkPolicy}. Apply the returned policy at sandbox-create time via
 * `NetworkBuilder.policy(policy)`. Microsandbox does not support runtime policy
 * updates, so this translation is one-shot.
 *
 * Microsandbox evaluates rules first-match-wins, independently per direction
 * (see the `NetworkPolicy` type doc). For `custom` mode we default-deny and
 * list `deniedCIDRs` rules BEFORE the `allowedHosts` / `allowedCIDRs` rules, so
 * an overlapping deny is matched first and wins, honouring the harness contract
 * that `deniedCIDRs` override allows. Rules use the `any` direction to cover
 * both egress and ingress, matching the pre-0.6 translation.
 */
export function translateNetworkPolicy(
  policy: HarnessV1NetworkPolicy,
): NetworkPolicy {
  switch (policy.mode) {
    case 'allow-all':
      return { defaultEgress: 'allow', defaultIngress: 'allow', rules: [] }
    case 'deny-all':
      return { defaultEgress: 'deny', defaultIngress: 'deny', rules: [] }
    case 'custom': {
      const rules: Rule[] = []
      for (const cidr of policy.deniedCIDRs ?? []) {
        rules.push(Rule.denyAny(Destination.cidr(cidr)))
      }
      for (const host of policy.allowedHosts ?? []) {
        rules.push(Rule.allowAny(Destination.domainSuffix(host)))
      }
      for (const cidr of policy.allowedCIDRs ?? []) {
        rules.push(Rule.allowAny(Destination.cidr(cidr)))
      }
      return { defaultEgress: 'deny', defaultIngress: 'deny', rules }
    }
  }
}
