import { DEFAULT_USAGE_RESET_DAY, deriveModelLabel } from "../../shared/types"
import type { AgentProvider, UsageLimitCredits, UsageLimitWindow, UsageLimitsSnapshot } from "../../shared/types"

export interface ComposerUsageRow {
  window: UsageLimitWindow
  /**
   * A row label just long enough to tell the stack apart: "5h", "Wk", "Opus".
   * Empty on the spend-cap row, whose left cell is its reset countdown.
   */
  shortLabel: string
  /** Set on the spend-cap row: `window` is then the cap's percent, with no reset. */
  credits?: UsageLimitCredits
  /**
   * The spend cap's next reset, ISO 8601: assumed from the monthly reset day
   * setting, since the usage API reports none. Kept off `window.resetsAt`, so
   * it never zeroes the percent when the assumed day passes.
   */
  assumedResetsAt?: string
  /** The spend cap's real next reset, ISO 8601, when the provider reports it (Codex). */
  resetsAt?: string
}

/** The next time the local clock reads midnight on `day` of a month, after `now`. */
export function nextMonthlyReset(day: number, now: number = Date.now()): string {
  const today = new Date(now)
  const thisMonth = new Date(today.getFullYear(), today.getMonth(), day)
  const next = thisMonth.getTime() > now ? thisMonth : new Date(today.getFullYear(), today.getMonth() + 1, day)
  return next.toISOString()
}

/**
 * A spend cap (Claude Enterprise extra usage) as a meter row, for plans that
 * report no time windows. Null when the cap has no percent to draw.
 */
function creditsRow(provider: AgentProvider, credits: UsageLimitCredits | null, resetDay: number, now: number): ComposerUsageRow | null {
  if (!credits || credits.usedPercent === null) return null
  return {
    window: {
      id: "credits",
      // Claude's cap is `extra_usage.monthly_limit`.
      label: provider === "claude" ? "Monthly spend limit" : credits.label,
      usedPercent: credits.usedPercent,
      resetsAt: null,
      recordedAt: credits.recordedAt,
      source: credits.source,
    },
    shortLabel: "",
    credits,
    ...(provider === "claude" ? { assumedResetsAt: nextMonthlyReset(resetDay, now) } : {}),
    ...(credits.resetsAt ? { resetsAt: credits.resetsAt } : {}),
  }
}

/** Model-specific Claude weekly windows and the model family each one limits. */
const CLAUDE_MODEL_WINDOWS: Record<string, RegExp> = {
  seven_day_opus: /opus/i,
  seven_day_sonnet: /sonnet/i,
}

/**
 * The windows that limit `model` on this provider. Claude's model lanes are
 * keyed by family (seven_day_opus); Codex's carry the model's label after a
 * " · " (only when there are several lanes, so a bare label is the default
 * lane). Anything else limits every model.
 */
function windowsForModel(provider: AgentProvider, windows: UsageLimitWindow[], model: string | null): UsageLimitWindow[] {
  if (provider === "claude") {
    return windows.filter((window) => {
      const family = CLAUDE_MODEL_WINDOWS[window.id]
      if (family) return model !== null && family.test(model)
      return window.id !== "seven_day_oauth_apps"
    })
  }
  if (provider === "codex") {
    const modelLabel = model ? deriveModelLabel(model) : null
    return windows.filter((window) => {
      const suffix = window.label.split(" · ")[1]
      return !suffix || suffix === "All models" || suffix === modelLabel
    })
  }
  if (provider === "grok") {
    // The all-products credit pool is the one every Grok model draws on.
    const pool = windows.filter((window) => window.id === "credits")
    return pool.length > 0 ? pool : windows
  }
  return windows
}

/**
 * Time left until `resetsAt`, rounded up to the minute: "3d 4h", "2h 14m",
 * "38m". Null when the time is unknown or already past.
 */
export function formatResetCountdown(resetsAt: string | null, now: number = Date.now()): string | null {
  if (!resetsAt) return null
  const ms = Date.parse(resetsAt) - now
  if (!Number.isFinite(ms) || ms <= 0) return null
  const totalMinutes = Math.ceil(ms / 60_000)
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  return `${minutes}m`
}

/**
 * A window as it stands at `now`: past its reset with no newer read, the limit
 * is back to empty, so 0% with no countdown (the server merges the same way on
 * its next read) rather than the old figure.
 */
export function windowAsOf(window: UsageLimitWindow, now: number = Date.now()): UsageLimitWindow {
  return window.resetsAt !== null && Date.parse(window.resetsAt) <= now
    ? { ...window, usedPercent: 0, resetsAt: null }
    : window
}

const SPAN_MINUTES = { minute: 1, hour: 60, day: 1440 } as const

/** A window's length in minutes, read off its label; unknown spans sort last. */
function windowMinutes(window: UsageLimitWindow): number {
  const base = window.label.split(" · ")[0]
  const span = /(\d+)-(minute|hour|day)/.exec(base)
  if (span) return Number(span[1]) * SPAN_MINUTES[span[2] as keyof typeof SPAN_MINUTES]
  if (/week/i.test(base)) return 10080
  if (/month/i.test(base)) return 43200
  return Number.POSITIVE_INFINITY
}

/**
 * "Current session (5-hour)" → "5h", "Weekly · All models" → "Wk",
 * "Weekly · Opus" → "Opus", "5-hour · GPT 5.3 Codex Spark" → "5h Spark".
 */
export function shortUsageLabel(window: UsageLimitWindow): string {
  const [base, suffix] = window.label.split(" · ")
  const span = /(\d+)-(minute|hour|day)/.exec(base)
  const head = span ? `${span[1]}${span[2][0]}` : /week/i.test(base) ? "Wk" : base.split(/\s+/)[0]
  if (!suffix || /^All (models|products)$/.test(suffix)) return head
  const lane = suffix.split(/\s+/).at(-1) ?? suffix
  // Claude's weekly model lanes are one per family, so the family is enough.
  return window.id.startsWith("seven_day_") ? lane : `${head} ${lane}`
}

/**
 * Every limit on `provider` (for `model`, or the ones every model shares when
 * it is null), shortest window first, or null when that provider reports
 * none. The server keeps every window it has seen (`mergeUsageWindows`), so
 * the rows stay put between reads. With no windows, a spend cap stands in as
 * the one row.
 */
export function selectComposerUsage(
  snapshot: UsageLimitsSnapshot | null,
  provider: AgentProvider,
  model: string | null,
  now: number = Date.now(),
  usageResetDay: number = DEFAULT_USAGE_RESET_DAY,
): ComposerUsageRow[] | null {
  const providerSnapshot = snapshot?.providers.find((entry) => entry.provider === provider)
  if (!providerSnapshot || providerSnapshot.status !== "ok") return null
  const rows = windowsForModel(provider, providerSnapshot.windows, model)
    .filter((window) => window.usedPercent !== null)
    .map((window) => windowAsOf(window, now))
    .map((window, index) => ({ window, index, minutes: windowMinutes(window) }))
    .sort((a, b) => a.minutes - b.minutes || a.index - b.index)
    .map(({ window }) => ({ window, shortLabel: shortUsageLabel(window) }))
  if (rows.length > 0) return rows
  const spendCap = creditsRow(provider, providerSnapshot.credits, usageResetDay, now)
  return spendCap ? [spendCap] : null
}
