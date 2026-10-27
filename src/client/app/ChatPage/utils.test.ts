import { describe, expect, test } from "bun:test"
import type { ContextWindowSnapshot } from "../../lib/contextWindow"
import { holdContextWindowSnapshot } from "./utils"

function snapshot(usedTokens: number): ContextWindowSnapshot {
  return {
    usedTokens,
    maxTokens: 200_000,
    compactsAutomatically: false,
    remainingTokens: 200_000 - usedTokens,
    usedPercentage: (usedTokens / 200_000) * 100,
    remainingPercentage: 100 - (usedTokens / 200_000) * 100,
    updatedAt: "2026-10-27T00:00:00.000Z",
  }
}

describe("holdContextWindowSnapshot", () => {
  test("a fresh derivation always wins", () => {
    const next = snapshot(20)
    expect(holdContextWindowSnapshot({ chatId: "a", snapshot: snapshot(10) }, "a", next)).toBe(next)
  })

  test("keeps the last known value while the same chat's transcript has none", () => {
    const last = snapshot(10)
    expect(holdContextWindowSnapshot({ chatId: "a", snapshot: last }, "a", null)).toBe(last)
  })

  test("does not carry one chat's value into another", () => {
    expect(holdContextWindowSnapshot({ chatId: "a", snapshot: snapshot(10) }, "b", null)).toBeNull()
    expect(holdContextWindowSnapshot(null, "a", null)).toBeNull()
  })
})
