import { describe, expect, test } from "bun:test"
import type { ProviderUsageSnapshot, UsageLimitWindow, UsageLimitsSnapshot } from "../../shared/types"
import { formatResetCountdown, pickUsageLayout, selectComposerUsage, shortUsageLabel } from "./composerUsage"

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

const ids = (rows: ReturnType<typeof selectComposerUsage>) => rows?.map((row) => row.window.id) ?? null
const labels = (rows: ReturnType<typeof selectComposerUsage>) => rows?.map((row) => row.shortLabel) ?? null

describe("selectComposerUsage", () => {
  test("stacks every window that limits the selected Claude model, shortest first", () => {
    const rows = selectComposerUsage(CLAUDE, "claude", "claude-opus-5-5")
    expect(ids(rows)).toEqual(["five_hour", "seven_day", "seven_day_opus"])
    expect(labels(rows)).toEqual(["5h", "Wk", "Opus"])
    expect(ids(selectComposerUsage(CLAUDE, "claude", "sonnet"))).toEqual(["five_hour", "seven_day", "seven_day_sonnet"])
    // Haiku isn't limited by either family lane.
    expect(ids(selectComposerUsage(CLAUDE, "claude", "claude-haiku-5-5"))).toEqual(["five_hour", "seven_day"])
  })

  test("orders by window length, not by the order the provider reported", () => {
    const reversed = makeSnapshot("claude", [
      makeWindow("seven_day", "Weekly · All models", 18),
      makeWindow("five_hour", "Current session (5-hour)", 42),
    ])
    expect(ids(selectComposerUsage(reversed, "claude", "opus"))).toEqual(["five_hour", "seven_day"])
  })

  test("keeps a window whose reset has passed, at 0%, so the rows don't change", () => {
    const afterFiveHourReset = Date.parse("2026-10-27T18:30:00.000Z")
    const rows = selectComposerUsage(CLAUDE, "claude", "opus", afterFiveHourReset)
    expect(ids(rows)).toEqual(["five_hour", "seven_day", "seven_day_opus"])
    expect(rows?.every((row) => row.window.usedPercent === 0 && row.window.resetsAt === null)).toBe(true)
    const before = selectComposerUsage(CLAUDE, "claude", "opus", Date.parse("2026-10-27T12:00:00.000Z"))
    expect(before?.map((row) => row.window.usedPercent)).toEqual([42, 18, 61])
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
      makeWindow("spark:secondary", "Weekly · GPT 5.3 Codex Spark", 40),
    ])
    expect(labels(selectComposerUsage(codex, "codex", "gpt-5.5"))).toEqual(["5h", "Wk"])
    expect(labels(selectComposerUsage(codex, "codex", "gpt-5.3-codex-spark"))).toEqual(["5h", "5h Spark", "Wk", "Wk Spark"])
  })

  test("uses Grok's shared credit pool when it is reported", () => {
    const grok = makeSnapshot("grok", [
      makeWindow("credits", "Weekly · All products", 12),
      makeWindow("grok-build", "Weekly · Grok Build", 80),
    ])
    const rows = selectComposerUsage(grok, "grok", "grok-code")
    expect(ids(rows)).toEqual(["credits"])
    expect(labels(rows)).toEqual(["Wk"])
  })
})

describe("shortUsageLabel", () => {
  test("keeps row labels to a few characters", () => {
    expect(shortUsageLabel(makeWindow("codex:primary", "15-minute", 1))).toBe("15m")
    expect(shortUsageLabel(makeWindow("codex:primary", "3-day", 1))).toBe("3d")
    expect(shortUsageLabel(makeWindow("seven_day_sonnet", "Weekly · Sonnet", 1))).toBe("Sonnet")
    expect(shortUsageLabel(makeWindow("grok-build", "Weekly · Grok Build", 1))).toBe("Wk Build")
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

describe("pickUsageLayout", () => {
  test("drops the countdowns before the bars, and only when they don't fit", () => {
    expect(pickUsageLayout(null, 120, 80)).toBe("full")
    expect(pickUsageLayout(120, 120, 80)).toBe("full")
    expect(pickUsageLayout(119, 120, 80)).toBe("compact")
    expect(pickUsageLayout(80, 120, 80)).toBe("compact")
    expect(pickUsageLayout(79, 120, 80)).toBe("none")
    expect(pickUsageLayout(-40, 120, 80)).toBe("none")
  })
})
