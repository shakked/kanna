import { CODEX_REASONING_EFFORT_ORDER } from "../shared/types"
import type { AgentProvider, ProviderCatalogEntry, ProviderModelOption, UsageLimitsSnapshot } from "../shared/types"
import {
  computeTokenPostures,
  formatTokenPostureSummary,
  type ProviderPosture,
  type TokenPosture,
} from "../shared/token-efficiency"

/**
 * Token Saver Mode, the server's half: what a delegator is told about each
 * provider's budget and which models to reach for. The posture math is in
 * `shared/token-efficiency.ts` (the Settings row shows the same answer). Here
 * is the part that needs the live provider catalog, so no model name is ever
 * written into a prompt: tiers are read off whatever the catalog lists now.
 *
 * Nothing here overrides a delegator's choice. It is advice with the numbers
 * behind it; the agent still picks the provider, model and effort.
 */

export type TaskTier = "light" | "standard" | "deep"

export interface TierRecommendation {
  provider: AgentProvider
  model: string
  /** Absent when the model takes no effort. */
  effort?: string
}

export interface ProviderEfficiency {
  provider: AgentProvider
  posture: TokenPosture
  /** Share of the limiting meter's budget left, 0–100. Absent when unknown. */
  headroomPercent?: number
  /** Budget left minus time left, −1 to 1. Positive means usage is behind the clock. */
  slack?: number
  limitingMeter?: string
  usedPercent?: number
  resetsAt?: string
  /** `resetsAt` is the monthly reset day setting's guess, not the provider's date. */
  resetAssumed?: boolean
  /** The usage read is old. Treat the posture as unknown. */
  stale?: boolean
  reason: string
  /** The model to use for each kind of work on this provider. */
  tiers: Record<TaskTier, TierRecommendation>
}

export interface EfficiencyContext {
  enabled: boolean
  /** Why it might not apply: Delegator Mode being off, say. */
  note?: string
  summary?: string
  providers?: ProviderEfficiency[]
  guidance?: string[]
}

/** A model whose id or label says it is the small, cheap one of its family. */
const LIGHT_MODEL = /haiku|luna|spark|mini|nano|flash|lite/i
/** The large one: the most capable model of its family. */
const DEEP_MODEL = /opus|fable|terra|ultra|\bpro\b/i

const TIER_EFFORT: Record<TaskTier, string> = { light: "low", standard: "medium", deep: "high" }

export function modelTier(model: Pick<ProviderModelOption, "id" | "label">): TaskTier {
  const text = `${model.id} ${model.label}`
  if (LIGHT_MODEL.test(text)) return "light"
  if (DEEP_MODEL.test(text)) return "deep"
  return "standard"
}

/** The effort the model offers nearest to `target`; a tie goes to the lighter. */
function nearestEffort(available: readonly string[], target: string): string | undefined {
  if (available.length === 0) return undefined
  if (available.includes(target)) return target
  const rank = (effort: string) => {
    const index = (CODEX_REASONING_EFFORT_ORDER as readonly string[]).indexOf(effort)
    return index === -1 ? Number.POSITIVE_INFINITY : index
  }
  const targetRank = rank(target)
  return [...available].sort((a, b) => {
    const distance = Math.abs(rank(a) - targetRank) - Math.abs(rank(b) - targetRank)
    return distance !== 0 ? distance : rank(a) - rank(b)
  })[0]
}

function effortsFor(catalog: ProviderCatalogEntry, model: ProviderModelOption): string[] {
  if (!model.supportsEffort) return []
  const own = model.supportedReasoningEfforts?.map((effort) => effort.id) ?? []
  return own.length > 0 ? own : catalog.efforts.map((effort) => effort.id)
}

/**
 * Light, standard and deep picks from a provider's live catalog. A tier with
 * no model of its own falls back to the provider's default, so every tier
 * always names something the provider can run. Of several deep models the
 * last listed is taken: catalogs run most capable (and dearest) first.
 */
export function recommendTiers(catalog: ProviderCatalogEntry): Record<TaskTier, TierRecommendation> {
  const byTier: Record<TaskTier, ProviderModelOption[]> = { light: [], standard: [], deep: [] }
  for (const model of catalog.models) byTier[modelTier(model)].push(model)
  const defaultModel = catalog.models.find((model) => model.id === catalog.defaultModel) ?? catalog.models[0]

  const pick = (tier: TaskTier): ProviderModelOption | undefined => {
    if (tier === "light") return byTier.light[0]
    if (tier === "deep") return byTier.deep.at(-1)
    return byTier.standard.find((model) => model.id === catalog.defaultModel) ?? byTier.standard[0]
  }
  const standard = pick("standard") ?? defaultModel

  const recommend = (tier: TaskTier): TierRecommendation => {
    const model = pick(tier) ?? standard ?? defaultModel
    const id = model?.id ?? catalog.defaultModel
    const effort = model ? nearestEffort(effortsFor(catalog, model), TIER_EFFORT[tier]) : undefined
    return { provider: catalog.id, model: id, ...(effort ? { effort } : {}) }
  }
  return { light: recommend("light"), standard: recommend("standard"), deep: recommend("deep") }
}

function providerEfficiency(posture: ProviderPosture, catalog: ProviderCatalogEntry | undefined): ProviderEfficiency | null {
  if (!catalog) return null
  return {
    provider: posture.provider,
    posture: posture.posture,
    ...(posture.headroomPercent !== null ? { headroomPercent: posture.headroomPercent } : {}),
    ...(posture.slack !== null ? { slack: posture.slack } : {}),
    ...(posture.limiter
      ? {
          limitingMeter: posture.limiter.label,
          usedPercent: posture.limiter.usedPercent,
          ...(posture.limiter.resetsAt ? { resetsAt: posture.limiter.resetsAt } : {}),
          ...(posture.limiter.resetAssumed ? { resetAssumed: true } : {}),
        }
      : {}),
    ...(posture.stale ? { stale: true } : {}),
    reason: posture.reason,
    tiers: recommendTiers(catalog),
  }
}

/**
 * How to read the block, in the block: the same text serves an agent that
 * never saw the delegator instructions (an older session) as well as one that
 * did.
 */
const EFFICIENCY_GUIDANCE = [
  "Posture says how freely each provider's plan can be spent now: spend (usage is behind the clock; headroom is there to use), balanced, conserve (usage is ahead of the clock), critical (nearly out), unknown (no fresh reading: never assume unlimited).",
  "Judge each piece of work first: light (a lookup, a mechanical edit, a narrow check), standard (a scoped change, ordinary debugging, review), deep (architecture, ambiguous multi-file debugging, security-sensitive reasoning). Then take that tier's model and effort from the provider you pick, and pass them to create_chat, fork_chat or send_message.",
  "Between providers, prefer the one with more headroom (spend over balanced over conserve), and keep the one the work suits when they are close. Prefer a provider with a known healthy budget to an unknown one, but an unknown one is a fine fallback. When both are unknown, use this chat's own provider at standard.",
  "Under conserve or critical, lower the tier or effort for routine pieces and avoid starting extra sub-chats: each one pays its own overhead. Never put a hard task on a light model to save tokens.",
]

/** What the orchestrator needs to read Token Saver Mode's inputs when it is asked. */
export interface TokenSaverSource {
  /** The Token Saver Mode setting. */
  enabled: boolean
  /** Delegator Mode, only to say so when it is off. */
  delegatorMode: boolean
  usageResetDay?: number
  /** The cached usage read. Never blocks on a provider. */
  snapshot: UsageLimitsSnapshot | null
  /** Ask for a newer read in the background (throttled by the usage manager). */
  refreshUsage?: () => void
}

export interface EfficiencyInputs {
  enabled: boolean
  delegatorMode: boolean
  snapshot: UsageLimitsSnapshot | null
  usageResetDay?: number
  now: number
  catalog: (provider: AgentProvider) => ProviderCatalogEntry | undefined
}

/** The `efficiency` block of `get_context`. */
export function buildEfficiencyContext(inputs: EfficiencyInputs): EfficiencyContext {
  if (!inputs.enabled) return { enabled: false }
  const postures = computeTokenPostures(inputs.snapshot, { now: inputs.now, usageResetDay: inputs.usageResetDay })
  const providers = postures.flatMap((posture) => {
    const entry = providerEfficiency(posture, inputs.catalog(posture.provider))
    return entry ? [entry] : []
  })
  return {
    enabled: true,
    ...(inputs.delegatorMode ? {} : { note: "Delegator Mode is off, so Token Saver Mode only affects delegator chats that already exist." }),
    summary: formatTokenPostureSummary(postures),
    providers,
    guidance: EFFICIENCY_GUIDANCE,
  }
}

/**
 * The wire-only notice at the start of a delegator's turn while Token Saver
 * Mode is on. The system prompt is fixed for a session, so this is how a
 * running delegator picks up the setting and the latest readings. It stays
 * one line: the detail is in `get_context`.
 */
export function buildTokenSaverNotice(inputs: Pick<EfficiencyInputs, "snapshot" | "usageResetDay" | "now">): string {
  const postures = computeTokenPostures(inputs.snapshot, { now: inputs.now, usageResetDay: inputs.usageResetDay })
  return `<system-message>Token Saver Mode is on. Plan budget now: ${formatTokenPostureSummary(postures)}. When choosing a provider, model and effort for sub-chats, weigh it: call get_context for the headroom, reset times and recommended light, standard and deep models.</system-message>`
}
