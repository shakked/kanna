import { describe, expect, test } from "bun:test"
import type { ProviderUsageSnapshot, UsageLimitWindow, UsageLimitsSnapshot } from "../../shared/types"
import { formatResetCountdown, selectComposerUsage } from "./composerUsage"

function makeWindow(id: string, label: string, usedPercent: number | null): UsageLimitWindow {
  return {
    id,
    label,
    usedPercent,
    resetsAt: "2026-10-27T18:00:00.000Z",
    recordedAt: "2026-10-27T12:00:00.000Z",
    source: "turn_push",
  }
}

function makeSnapshot(provider: ProviderUsageSnapshot["provider"], windows: UsageLimitWindow[], status: ProviderUsageSnapshot["status"] = "ok"): UsageLimitsSnapshot {
  return {
    providers: [{ provider, status, plan: "max", windows, credits: null, detail: null, updatedAt: null }],
  }
}

const CLAUDE = makeSnapshot("claude", [
  makeWindow("five_hour", "Current session (5-hour)", 42),
  makeWindow("seven_day", "Weekly · All models", 18),
  makeWindow("seven_day_opus", "Weekly · Opus", 61),
  makeWindow("seven_day_sonnet", "Weekly · Sonnet", 90),
])

describe("selectComposerUsage", () => {
  test("picks the fullest window that limits the selected Claude model", () => {
    expect(selectComposerUsage(CLAUDE, "claude", "claude-opus-5-5")?.window.id).toBe("seven_day_opus")
    expect(selectComposerUsage(CLAUDE, "claude", "sonnet")?.window.id).toBe("seven_day_sonnet")
    // Haiku isn't limited by either family lane.
    expect(selectComposerUsage(CLAUDE, "claude", "claude-haiku-5-5")?.window.id).toBe("five_hour")
  })

  test("returns null when the selected provider has no live limits", () => {
    expect(selectComposerUsage(null, "claude", "opus")).toBeNull()
    expect(selectComposerUsage(CLAUDE, "codex", "gpt-5.5")).toBeNull()
    expect(selectComposerUsage(makeSnapshot("claude", [], "unavailable"), "claude", "opus")).toBeNull()
    expect(selectComposerUsage(makeSnapshot("claude", [makeWindow("five_hour", "Current session (5-hour)", null)]), "claude", "opus")).toBeNull()
  })

  test("keeps Codex to the default lane plus the selected model's own", () => {
    const codex = makeSnapshot("codex", [
      makeWindow("codex:primary", "5-hour · All models", 20),
      makeWindow("codex:secondary", "Weekly · All models", 30),
      makeWindow("spark:primary", "5-hour · GPT 5.3 Codex Spark", 95),
    ])
    expect(selectComposerUsage(codex, "codex", "gpt-5.5")?.window.id).toBe("codex:secondary")
    expect(selectComposerUsage(codex, "codex", "gpt-5.3-codex-spark")?.window.id).toBe("spark:primary")
  })

  test("uses Grok's shared credit pool when it is reported", () => {
    const grok = makeSnapshot("grok", [
      makeWindow("credits", "Weekly · All products", 12),
      makeWindow("grok-build", "Weekly · Grok Build", 80),
    ])
    expect(selectComposerUsage(grok, "grok", "grok-code")?.window.id).toBe("credits")
  })
})

describe("formatResetCountdown", () => {
  const now = Date.parse("2026-10-27T12:00:00.000Z")

  test("counts down to the reset, rounded up to the minute", () => {
    expect(formatResetCountdown("2026-10-27T14:14:00.000Z", now)).toBe("2h 14m")
    expect(formatResetCountdown("2026-10-27T12:38:00.000Z", now)).toBe("38m")
    expect(formatResetCountdown("2026-10-27T12:00:20.000Z", now)).toBe("1m")
    expect(formatResetCountdown("2026-10-27T15:00:00.000Z", now)).toBe("3h")
    expect(formatResetCountdown("2026-10-30T16:00:00.000Z", now)).toBe("3d 4h")
  })

  test("is null when the reset time is unknown or already past", () => {
    expect(formatResetCountdown(null, now)).toBeNull()
    expect(formatResetCountdown("not a date", now)).toBeNull()
    expect(formatResetCountdown("2026-10-27T11:59:00.000Z", now)).toBeNull()
  })
})
