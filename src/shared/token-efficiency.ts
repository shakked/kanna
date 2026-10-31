import { DEFAULT_USAGE_RESET_DAY } from "./types"
import type { AgentProvider, ProviderUsageSnapshot, UsageLimitCredits, UsageLimitWindow, UsageLimitsSnapshot } from "./types"

/**
 * Token Saver Mode's budget posture: how freely a provider's plan can be
 * spent right now, from its usage windows and spend cap against the time left
 * before they reset. Pure math over a usage snapshot, shared so the Settings
 * row and the delegator's `get_context` read the same answer.
 *
 * For each meter (a rolling window, or a spend cap):
 *
 *   slack = budgetRemaining − timeRemaining
 *
 * both as fractions of the whole. Positive slack means usage is behind the
 * time-based allowance. The tightest meter governs the provider, so a healthy
 * 5-hour window never hides an exhausted weekly one.
 */
export type TokenPosture = "spend" | "balanced" | "conserve" | "critical" | "unknown"

export const TOKEN_POSTURE_LABELS: Record<TokenPosture, string> = {
  spend: "Spend",
  balanced: "Balanced",
  conserve: "Conserve",
  critical: "Critical",
  unknown: "Unknown",
}

/** The providers Token Saver routes between. */
export const TOKEN_SAVER_PROVIDERS = ["claude", "codex"] as const satisfies readonly AgentProvider[]

const TOKEN_SAVER_PROVIDER_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
}

/** Band edges. Slack above `spendSlack` spends; below `conserveSlack` conserves. */
export const TOKEN_POSTURE_BANDS = {
  spendSlack: 0.2,
  conserveSlack: -0.15,
  /** Used percent at or past which a meter is critical whatever the clock says. */
  criticalUsedPercent: 95,
  /** Remaining share below which a meter that is also behind schedule is critical. */
  criticalRemaining: 0.1,
  criticalSlack: -0.05,
  /** A meter this close to its reset, with this much left, spends. Longer windows only. */
  spendResetWithinMs: 24 * 3_600_000,
  spendResetRemaining: 0.2,
} as const

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
/** Windows with no readable length are taken as weekly, the common one. */
const DEFAULT_WINDOW_MS = 7 * DAY_MS
/** A spend cap with a real reset date is still taken as a month long. */
const MONTH_MS = 30 * DAY_MS

export interface PostureLimiter {
  label: string
  usedPercent: number
  /** ISO 8601 reset, or null when it passed with no newer read. */
  resetsAt: string | null
  /** The reset is the monthly reset day setting, not something the provider said. */
  resetAssumed: boolean
}

export interface ProviderPosture {
  provider: AgentProvider
  posture: TokenPosture
  /** budgetRemaining − timeRemaining of the limiting meter, or null when unknown. */
  slack: number | null
  /** Share of the limiting meter's budget left, 0–100, or null when unknown. */
  headroomPercent: number | null
  limiter: PostureLimiter | null
  /** Every meter's data is old: the read is not to be trusted as current. */
  stale: boolean
  /** One line saying why, for a person or an agent. */
  reason: string
}

export interface ComputePostureOptions {
  now?: number
  /** Day of the month the Claude spend cap is assumed to reset, 1–28. */
  usageResetDay?: number
}

interface Meter {
  label: string
  usedPercent: number
  limitReached: boolean
  /** Fraction of the cycle left, 0–1, or null when there is no reset to count to. */
  timeRemaining: number | null
  durationMs: number
  resetsAt: string | null
  resetAssumed: boolean
  recordedAt: string | null
}

interface EvaluatedMeter {
  meter: Meter
  posture: Exclude<TokenPosture, "unknown">
  slack: number
  remaining: number
  stale: boolean
}

const SEVERITY: Record<Exclude<TokenPosture, "unknown">, number> = {
  spend: 0,
  balanced: 1,
  conserve: 2,
  critical: 3,
}

const UNIT_MS = { minute: 60_000, hour: HOUR_MS, day: DAY_MS } as const

/** A window's length, read off its label ("5-hour", "Weekly") or id. */
function windowDurationMs(window: Pick<UsageLimitWindow, "id" | "label">): number {
  const base = window.label.split(" · ")[0]
  const span = /(\d+)-(minute|hour|day)/.exec(base)
  if (span) return Number(span[1]) * UNIT_MS[span[2] as keyof typeof UNIT_MS]
  if (/week/i.test(base)) return 7 * DAY_MS
  if (/month/i.test(base)) return MONTH_MS
  if (window.id === "five_hour") return 5 * HOUR_MS
  if (window.id.startsWith("seven_day")) return 7 * DAY_MS
  return DEFAULT_WINDOW_MS
}

/**
 * The monthly cycle `day` of the month implies around `now`: the last reset
 * and the next one, on this machine's local clock.
 */
export function monthlyCycle(day: number, now: number): { startMs: number; endMs: number } {
  const today = new Date(now)
  const thisMonth = new Date(today.getFullYear(), today.getMonth(), day)
  const end = thisMonth.getTime() > now ? thisMonth : new Date(today.getFullYear(), today.getMonth() + 1, day)
  const start = new Date(end.getFullYear(), end.getMonth() - 1, day)
  return { startMs: start.getTime(), endMs: end.getTime() }
}

/** How long before a meter's read goes stale: a quarter of its cycle, between 1 and 12 hours. */
function staleAfterMs(durationMs: number): number {
  return Math.min(12 * HOUR_MS, Math.max(HOUR_MS, durationMs / 4))
}

function windowMeter(window: UsageLimitWindow, now: number): Meter | null {
  if (window.usedPercent === null) return null
  const durationMs = windowDurationMs(window)
  const resetMs = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN
  // Past its reset with no newer read the limit is back to empty (the same
  // call `windowAsOf` makes for the meters), but how far into the new cycle
  // it is can't be known: take the whole of it left.
  if (Number.isFinite(resetMs) && resetMs <= now) {
    return { label: window.label, usedPercent: 0, limitReached: false, timeRemaining: 1, durationMs, resetsAt: null, resetAssumed: false, recordedAt: null }
  }
  return {
    label: window.label,
    usedPercent: window.usedPercent,
    limitReached: false,
    timeRemaining: Number.isFinite(resetMs) ? Math.min(1, Math.max(0, (resetMs - now) / durationMs)) : null,
    durationMs,
    resetsAt: Number.isFinite(resetMs) ? window.resetsAt : null,
    resetAssumed: false,
    recordedAt: window.recordedAt,
  }
}

function creditsMeter(provider: AgentProvider, credits: UsageLimitCredits, now: number, resetDay: number): Meter | null {
  if (credits.usedPercent === null) return null
  const label = provider === "claude" ? "Monthly spend limit" : credits.label
  const realResetMs = credits.resetsAt ? Date.parse(credits.resetsAt) : Number.NaN
  if (Number.isFinite(realResetMs) && realResetMs > now) {
    return {
      label,
      usedPercent: credits.usedPercent,
      limitReached: credits.limitReached === true,
      timeRemaining: Math.min(1, Math.max(0, (realResetMs - now) / MONTH_MS)),
      durationMs: MONTH_MS,
      resetsAt: new Date(realResetMs).toISOString(),
      resetAssumed: false,
      recordedAt: credits.recordedAt,
    }
  }
  // The usage data names no reset (Claude's never does): assume the monthly one.
  const { startMs, endMs } = monthlyCycle(resetDay, now)
  return {
    label,
    usedPercent: credits.usedPercent,
    limitReached: credits.limitReached === true,
    timeRemaining: (endMs - now) / (endMs - startMs),
    durationMs: endMs - startMs,
    resetsAt: new Date(endMs).toISOString(),
    resetAssumed: true,
    recordedAt: credits.recordedAt,
  }
}

function evaluateMeter(meter: Meter, now: number): EvaluatedMeter | null {
  const bands = TOKEN_POSTURE_BANDS
  const remaining = 1 - meter.usedPercent / 100
  const exhausted = meter.limitReached || meter.usedPercent >= bands.criticalUsedPercent
  // With no reset to count to, only exhaustion is a verdict.
  if (meter.timeRemaining === null && !exhausted) return null
  const timeRemaining = meter.timeRemaining ?? 1
  const slack = remaining - timeRemaining
  const resetsInMs = timeRemaining * meter.durationMs
  const stale = meter.recordedAt !== null && now - Date.parse(meter.recordedAt) > staleAfterMs(meter.durationMs)
  let posture: EvaluatedMeter["posture"]
  if (exhausted || (remaining < bands.criticalRemaining && slack < bands.criticalSlack)) posture = "critical"
  else if (slack < bands.conserveSlack) posture = "conserve"
  else if (
    slack > bands.spendSlack
    || (meter.durationMs > DAY_MS && resetsInMs <= bands.spendResetWithinMs && remaining >= bands.spendResetRemaining)
  ) posture = "spend"
  else posture = "balanced"
  return { meter, posture, slack, remaining, stale }
}

function formatCountdown(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  return `${minutes}m`
}

function unknownPosture(provider: AgentProvider, reason: string, stale = false): ProviderPosture {
  return { provider, posture: "unknown", slack: null, headroomPercent: null, limiter: null, stale, reason }
}

/**
 * One provider's posture. Missing, unreadable or stale data is `unknown`,
 * never unlimited. Stale meters are set aside while a fresh one remains.
 */
export function computeProviderPosture(
  provider: AgentProvider,
  snapshot: ProviderUsageSnapshot | null | undefined,
  options: ComputePostureOptions = {},
): ProviderPosture {
  const now = options.now ?? Date.now()
  const resetDay = options.usageResetDay ?? DEFAULT_USAGE_RESET_DAY
  if (!snapshot || snapshot.status !== "ok") {
    return unknownPosture(provider, snapshot?.detail ?? "No usage data yet.")
  }

  const meters: Meter[] = []
  for (const window of snapshot.windows) {
    // Not a limit on Kanna's use of the plan.
    if (window.id === "seven_day_oauth_apps") continue
    const meter = windowMeter(window, now)
    if (meter) meters.push(meter)
  }
  if (snapshot.credits) {
    const meter = creditsMeter(provider, snapshot.credits, now, resetDay)
    if (meter) meters.push(meter)
  }

  const evaluated = meters.flatMap((meter) => {
    const result = evaluateMeter(meter, now)
    return result ? [result] : []
  })
  if (evaluated.length === 0) return unknownPosture(provider, "Usage data has no limit to measure against.")
  const fresh = evaluated.filter((entry) => !entry.stale)
  if (fresh.length === 0) return unknownPosture(provider, "Usage data is out of date.", true)

  // Tightest first: the worst posture, and of those the least slack.
  const governing = fresh.reduce((worst, entry) => (
    SEVERITY[entry.posture] > SEVERITY[worst.posture]
    || (SEVERITY[entry.posture] === SEVERITY[worst.posture] && entry.slack < worst.slack)
      ? entry
      : worst
  ))
  const { meter } = governing
  const resetNote = meter.resetsAt
    ? `resets in ${formatCountdown(Date.parse(meter.resetsAt) - now)}${meter.resetAssumed ? ` (assumed: day ${resetDay} of the month)` : ""}`
    : "reset unknown"
  return {
    provider,
    posture: governing.posture,
    slack: Math.round(governing.slack * 100) / 100,
    headroomPercent: Math.round(governing.remaining * 100),
    limiter: {
      label: meter.label,
      usedPercent: Math.round(meter.usedPercent * 10) / 10,
      resetsAt: meter.resetsAt,
      resetAssumed: meter.resetAssumed,
    },
    stale: false,
    reason: `${meter.label}: ${Math.round(meter.usedPercent)}% used, ${resetNote}.`,
  }
}

/** Posture for each provider Token Saver routes between, in a fixed order. */
export function computeTokenPostures(
  snapshot: UsageLimitsSnapshot | null | undefined,
  options: ComputePostureOptions = {},
): ProviderPosture[] {
  return TOKEN_SAVER_PROVIDERS.map((provider) => (
    computeProviderPosture(provider, snapshot?.providers.find((entry) => entry.provider === provider), options)
  ))
}

/** "Claude: Spend · Codex: Balanced" */
export function formatTokenPostureSummary(postures: readonly ProviderPosture[]): string {
  return postures
    .map((entry) => `${TOKEN_SAVER_PROVIDER_LABELS[entry.provider] ?? entry.provider}: ${TOKEN_POSTURE_LABELS[entry.posture]}`)
    .join(" · ")
}
