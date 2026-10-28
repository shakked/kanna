import { describe, expect, test } from "bun:test"
import {
  ChatCpuMonitor,
  parseCpuTime,
  parsePsOutput,
  processCpuPercents,
  sumProcessTreeCpu,
  toChatCpuSnapshot,
  type PsRow,
} from "./chat-cpu"
import { readClaudeQueryPid } from "./agent"

function row(pid: number, ppid: number, cpuPercent = 0, cpuSeconds = 0): PsRow {
  return { pid, ppid, cpuPercent, cpuSeconds }
}

describe("parseCpuTime", () => {
  test("reads macOS minutes:seconds", () => {
    expect(parseCpuTime("101:36.23")).toBeCloseTo(6096.23)
    expect(parseCpuTime("0:00.50")).toBeCloseTo(0.5)
  })

  test("reads Linux hours and days", () => {
    expect(parseCpuTime("01:02:03")).toBe(3723)
    expect(parseCpuTime("2-01:00:00")).toBe(2 * 86_400 + 3600)
  })

  test("is NaN for anything else", () => {
    expect(parseCpuTime("abc")).toBeNaN()
    expect(parseCpuTime("1:2:3:4")).toBeNaN()
    expect(parseCpuTime("x-01:00:00")).toBeNaN()
  })
})

describe("parsePsOutput", () => {
  test("parses rows and skips lines that do not fit", () => {
    const rows = parsePsOutput(
      ["    1     0   0.0   5:01.20", "  812     1  12.5   0:03.10", "garbage line", "", "  900   812   x  0:01.00"].join("\n"),
    )
    expect(rows).toEqual([
      { pid: 1, ppid: 0, cpuPercent: 0, cpuSeconds: 301.2 },
      { pid: 812, ppid: 1, cpuPercent: 12.5, cpuSeconds: 3.1 },
    ])
  })
})

describe("processCpuPercents", () => {
  test("first tick falls back to ps's own %cpu", () => {
    const percents = processCpuPercents([row(10, 1, 42, 100)], null)
    expect(percents.get(10)).toBe(42)
  })

  test("differences cumulative time over the interval", () => {
    const previous = { cpuSecondsByPid: new Map([[10, 100], [11, 5]]), elapsedMs: 5_000 }
    const percents = processCpuPercents([row(10, 1, 99, 102.5), row(11, 10, 99, 5), row(12, 10, 99, 1)], previous)
    expect(percents.get(10)).toBeCloseTo(50)
    expect(percents.get(11)).toBe(0)
    // New since the last sample: all of its time falls in the interval.
    expect(percents.get(12)).toBeCloseTo(20)
  })

  test("never goes negative when a pid is reused", () => {
    const previous = { cpuSecondsByPid: new Map([[10, 500]]), elapsedMs: 5_000 }
    expect(processCpuPercents([row(10, 1, 0, 1)], previous).get(10)).toBe(0)
  })
})

describe("sumProcessTreeCpu", () => {
  const rows = [row(1, 0), row(100, 1), row(101, 100), row(102, 101), row(200, 1), row(300, 1), row(301, 300)]
  const percents = new Map([
    [100, 10],
    [101, 20],
    [102, 5],
    [200, 7],
    [300, 1],
    [301, 2],
    [1, 99],
  ])

  test("sums a chat's process and all its descendants", () => {
    const totals = sumProcessTreeCpu(rows, percents, new Map([["a", 100], ["b", 200]]))
    expect(totals.get("a")).toBe(35)
    expect(totals.get("b")).toBe(7)
  })

  test("a chat whose process is gone gets nothing", () => {
    const totals = sumProcessTreeCpu(rows, percents, new Map([["a", 100], ["gone", 999]]))
    expect(totals.has("gone")).toBe(false)
  })

  test("a process under two roots counts once", () => {
    const totals = sumProcessTreeCpu(rows, percents, new Map([["outer", 100], ["inner", 101]]))
    expect(totals.get("outer")! + (totals.get("inner") ?? 0)).toBe(35)
  })

  test("a process that is its own parent does not loop", () => {
    const totals = sumProcessTreeCpu([row(0, 0), row(5, 0)], new Map([[0, 1], [5, 3]]), new Map([["a", 0]]))
    expect(totals.get("a")).toBe(4)
  })
})

describe("toChatCpuSnapshot", () => {
  test("rounds and drops chats under 1%", () => {
    expect(toChatCpuSnapshot(new Map([["b", 12.6], ["a", 0.9], ["c", 1]]))).toEqual({ chats: { b: 13, c: 1 } })
  })
})

describe("ChatCpuMonitor", () => {
  test("skips ps entirely when no chat has a process", async () => {
    let reads = 0
    const monitor = new ChatCpuMonitor({
      getChatPids: () => new Map(),
      readPs: async () => {
        reads += 1
        return ""
      },
    })
    await monitor.sample()
    expect(reads).toBe(0)
    expect(monitor.getSnapshot()).toEqual({ chats: {} })
  })

  test("publishes deltas and notifies only when the numbers change", async () => {
    const outputs = ["  100 1 30.0 0:10.00\n  101 100 0.0 0:01.00", "  100 1 0.0 0:11.00\n  101 100 0.0 0:01.50"]
    let clock = 0
    const monitor = new ChatCpuMonitor({
      getChatPids: () => new Map([["chat-1", 100]]),
      readPs: async () => outputs.shift() ?? "  100 1 0.0 0:11.00\n  101 100 0.0 0:01.50",
      now: () => clock,
    })
    let changes = 0
    monitor.onChange(() => {
      changes += 1
    })

    await monitor.sample()
    expect(monitor.getSnapshot()).toEqual({ chats: { "chat-1": 30 } })

    clock = 5_000
    await monitor.sample()
    // (1s + 0.5s) of CPU over 5s.
    expect(monitor.getSnapshot()).toEqual({ chats: { "chat-1": 30 } })
    expect(changes).toBe(1)

    clock = 10_000
    await monitor.sample()
    expect(monitor.getSnapshot()).toEqual({ chats: {} })
    expect(changes).toBe(2)
  })

  test("a failed ps read keeps the last snapshot", async () => {
    const monitor = new ChatCpuMonitor({
      getChatPids: () => new Map([["chat-1", 100]]),
      readPs: async () => {
        throw new Error("ps failed")
      },
    })
    await monitor.sample()
    expect(monitor.getSnapshot()).toEqual({ chats: {} })
  })

  test("samples only while active", async () => {
    let reads = 0
    const monitor = new ChatCpuMonitor({
      getChatPids: () => new Map([["chat-1", 100]]),
      readPs: async () => {
        reads += 1
        return "  100 1 5.0 0:01.00"
      },
      intervalMs: 10,
    })
    monitor.setActive(true)
    await new Promise((resolve) => setTimeout(resolve, 35))
    monitor.setActive(false)
    const afterStop = reads
    expect(afterStop).toBeGreaterThanOrEqual(2)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(reads).toBe(afterStop)
    monitor.dispose()
  })
})

describe("readClaudeQueryPid", () => {
  test("reads the live CLI process pid off the query's transport", () => {
    expect(readClaudeQueryPid({ transport: { process: { pid: 4242, exitCode: null, signalCode: null } } })).toBe(4242)
  })

  test("is null once the process exited, or when the shape is unknown", () => {
    expect(readClaudeQueryPid({ transport: { process: { pid: 4242, exitCode: 0, signalCode: null } } })).toBeNull()
    expect(readClaudeQueryPid({ transport: { process: { pid: 4242, exitCode: null, signalCode: "SIGTERM" } } })).toBeNull()
    expect(readClaudeQueryPid({})).toBeNull()
    expect(readClaudeQueryPid(null)).toBeNull()
  })
})
