import type { ResolvedAgentProfile } from './agent-profile.js'
import { globMatches } from '../core/glob.js'

export type Verdict = 'allow' | 'deny'

export interface PermissionDecision {
  verdict: Verdict
  /** When deny, which rule matched (helpful for telemetry / surfacing to user). */
  reason?: string
}

/**
 * NACL-style policy: `(base.allow ∪ child.allow) − (base.deny ∪ child.deny)`.
 * Any matching deny wins over any matching allow.
 */
export class PermissionGate {
  constructor(private readonly profile: ResolvedAgentProfile) {}

  canLoadSkill(skillName: string): PermissionDecision {
    const denied = matchesAny(skillName, this.profile.permissions.skills.deny)
    if (denied) return { verdict: 'deny', reason: `deny matched "${denied}"` }
    const allowed = matchesAny(skillName, this.profile.permissions.skills.allow)
    if (allowed) return { verdict: 'allow' }
    return { verdict: 'deny', reason: 'no allow rule matched' }
  }

  canCallExpert(modelId: string): PermissionDecision {
    if (this.profile.permissions.experts.allow.includes(modelId)) return { verdict: 'allow' }
    return { verdict: 'deny', reason: 'expert not in allow list' }
  }
}

function matchesAny(name: string, patterns: readonly string[]): string | null {
  for (const p of patterns) {
    if (globMatches(name, p)) return p
  }
  return null
}

/** Re-export so existing tests that import `matches` still work. */
export const matches = globMatches
