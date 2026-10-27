import { deriveModelLabel } from "../../shared/types"
import type { AgentProvider, UsageLimitWindow, UsageLimitsSnapshot } from "../../shared/types"

export interface ComposerUsage {
  window: UsageLimitWindow
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
 * The limit the composer's provider and model are closest to hitting, or null
 * when that provider reports no limits. The fullest window is the one that
 * will stop the next turn first, so it's the one worth a glance.
 */
export function selectComposerUsage(
  snapshot: UsageLimitsSnapshot | null,
  provider: AgentProvider,
  model: string | null,
): ComposerUsage | null {
  const providerSnapshot = snapshot?.providers.find((entry) => entry.provider === provider)
  if (!providerSnapshot || providerSnapshot.status !== "ok") return null
  const candidates = windowsForModel(provider, providerSnapshot.windows, model)
    .filter((window) => window.usedPercent !== null)
  if (candidates.length === 0) return null
  const window = candidates.reduce((fullest, next) =>
    (next.usedPercent ?? 0) > (fullest.usedPercent ?? 0) ? next : fullest)
  return { window }
}
