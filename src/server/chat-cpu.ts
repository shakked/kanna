import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { ChatCpuSnapshot } from "../shared/types"

const execFileAsync = promisify(execFile)

/** How often a sample is taken while anyone is watching. */
export const CHAT_CPU_INTERVAL_MS = 5_000

/**
 * Below this a chat reports nothing. An idle agent process sits at a fraction
 * of a percent forever, and a number on every row would be noise.
 */
export const CHAT_CPU_MIN_PERCENT = 1

export interface PsRow {
  pid: number
  ppid: number
  /** `ps`'s own %cpu: a decaying average on macOS, a lifetime one on Linux. */
  cpuPercent: number
  /** Cumulative CPU time, user + system. */
  cpuSeconds: number
}

/** `M:SS.ss` (macOS), `[DD-]HH:MM:SS` (Linux) → seconds. NaN when unreadable. */
export function parseCpuTime(value: string): number {
  const [daysPart, clock] = value.includes("-") ? value.split("-", 2) : [null, value]
  const parts = clock!.split(":").map(Number)
  if (parts.length === 0 || parts.length > 3 || parts.some((part) => !Number.isFinite(part))) return Number.NaN
  let seconds = 0
  for (const part of parts) seconds = seconds * 60 + part
  if (daysPart !== null) {
    const days = Number(daysPart)
    if (!Number.isFinite(days)) return Number.NaN
    seconds += days * 86_400
  }
  return seconds
}

/** Rows of `ps -ax -o pid=,ppid=,%cpu=,time=`. Lines that do not parse are skipped. */
export function parsePsOutput(stdout: string): PsRow[] {
  const rows: PsRow[] = []
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s*$/.exec(line)
    if (!match) continue
    const cpuSeconds = parseCpuTime(match[4]!)
    if (!Number.isFinite(cpuSeconds)) continue
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), cpuPercent: Number(match[3]), cpuSeconds })
  }
  return rows
}

/**
 * Each process's CPU over the interval since `previous`, in percent of one
 * core, from the change in its cumulative CPU time. That is what the tooltip
 * promises ("last 5s"); `ps`'s %cpu is a decaying average on macOS and a
 * lifetime one on Linux. A process missing from `previous` started since, so
 * all of its time is new. With no previous sample (the first tick) there is
 * nothing to difference, and `ps`'s own figure stands in.
 *
 * A process that exited during the interval is not in `rows`, so its time is
 * lost: a short build step can be undercounted, never overcounted.
 */
export function processCpuPercents(
  rows: readonly PsRow[],
  previous: { cpuSecondsByPid: ReadonlyMap<number, number>; elapsedMs: number } | null,
): Map<number, number> {
  const percents = new Map<number, number>()
  for (const row of rows) {
    if (!previous || previous.elapsedMs <= 0) {
      percents.set(row.pid, row.cpuPercent)
      continue
    }
    const before = previous.cpuSecondsByPid.get(row.pid) ?? 0
    // A reused pid, or a clock that rounds down: never negative.
    const delta = Math.max(0, row.cpuSeconds - before)
    percents.set(row.pid, (delta * 1000 * 100) / previous.elapsedMs)
  }
  return percents
}

/**
 * Sums CPU over each chat's process and every descendant of it, so a chat's
 * builds and tests count toward it. A root that is not in `rows` (it exited)
 * gives that chat nothing. A process is counted once even when two roots
 * would both reach it (one root nested in another's tree).
 */
export function sumProcessTreeCpu(
  rows: readonly PsRow[],
  percentByPid: ReadonlyMap<number, number>,
  rootPidByChat: ReadonlyMap<string, number>,
): Map<string, number> {
  const childrenByPid = new Map<number, number[]>()
  const present = new Set<number>()
  for (const row of rows) {
    present.add(row.pid)
    // pid 0's parent is itself on some systems; a loop would never end.
    if (row.pid === row.ppid) continue
    const siblings = childrenByPid.get(row.ppid)
    if (siblings) siblings.push(row.pid)
    else childrenByPid.set(row.ppid, [row.pid])
  }

  const totals = new Map<string, number>()
  const counted = new Set<number>()
  for (const [chatId, rootPid] of rootPidByChat) {
    if (!present.has(rootPid)) continue
    let total = 0
    const stack = [rootPid]
    while (stack.length > 0) {
      const pid = stack.pop()!
      if (counted.has(pid)) continue
      counted.add(pid)
      total += percentByPid.get(pid) ?? 0
      const children = childrenByPid.get(pid)
      if (children) stack.push(...children)
    }
    totals.set(chatId, total)
  }
  return totals
}

/** Whole percents, and only the chats at or over `CHAT_CPU_MIN_PERCENT`. */
export function toChatCpuSnapshot(totals: ReadonlyMap<string, number>): ChatCpuSnapshot {
  const chats: Record<string, number> = {}
  for (const [chatId, percent] of [...totals].sort(([a], [b]) => a.localeCompare(b))) {
    if (percent < CHAT_CPU_MIN_PERCENT) continue
    chats[chatId] = Math.round(percent)
  }
  return { chats }
}

async function readPs(): Promise<string> {
  const { stdout } = await execFileAsync("ps", ["-ax", "-o", "pid=,ppid=,%cpu=,time="], {
    timeout: 3_000,
    maxBuffer: 4 * 1024 * 1024,
  })
  return stdout
}

/**
 * Samples each chat's CPU (its agent process plus descendants) every
 * `CHAT_CPU_INTERVAL_MS`, but only while `setActive(true)`: the router turns
 * it on while some client holds a `chat-cpu` subscription. One `ps` call per
 * tick covers every chat, and a tick with no live chat process skips `ps`.
 */
export class ChatCpuMonitor {
  private readonly getChatPids: () => ReadonlyMap<string, number>
  private readonly read: () => Promise<string>
  private readonly intervalMs: number
  private readonly now: () => number
  private timer: ReturnType<typeof setInterval> | null = null
  private sampling = false
  private previous: { cpuSecondsByPid: Map<number, number>; at: number } | null = null
  private snapshot: ChatCpuSnapshot = { chats: {} }
  private signature = "{}"
  private readonly listeners = new Set<() => void>()

  constructor(args: {
    getChatPids: () => ReadonlyMap<string, number>
    readPs?: () => Promise<string>
    intervalMs?: number
    now?: () => number
  }) {
    this.getChatPids = args.getChatPids
    this.read = args.readPs ?? readPs
    this.intervalMs = args.intervalMs ?? CHAT_CPU_INTERVAL_MS
    this.now = args.now ?? Date.now
  }

  getSnapshot(): ChatCpuSnapshot {
    return this.snapshot
  }

  onChange(listener: () => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  setActive(active: boolean) {
    if (active === (this.timer !== null)) return
    if (!active) {
      clearInterval(this.timer!)
      this.timer = null
      // A sample from minutes ago would difference into a long average.
      this.previous = null
      return
    }
    this.timer = setInterval(() => void this.sample(), this.intervalMs)
    void this.sample()
  }

  dispose() {
    this.setActive(false)
    this.listeners.clear()
  }

  /** One tick. Public for tests. */
  async sample() {
    if (this.sampling) return
    this.sampling = true
    try {
      const roots = this.getChatPids()
      if (roots.size === 0) {
        this.previous = null
        this.publish({ chats: {} })
        return
      }
      let stdout: string
      try {
        stdout = await this.read()
      } catch {
        return
      }
      const at = this.now()
      const rows = parsePsOutput(stdout)
      const percents = processCpuPercents(
        rows,
        this.previous ? { cpuSecondsByPid: this.previous.cpuSecondsByPid, elapsedMs: at - this.previous.at } : null,
      )
      this.previous = { cpuSecondsByPid: new Map(rows.map((row) => [row.pid, row.cpuSeconds])), at }
      this.publish(toChatCpuSnapshot(sumProcessTreeCpu(rows, percents, roots)))
    } finally {
      this.sampling = false
    }
  }

  private publish(next: ChatCpuSnapshot) {
    const signature = JSON.stringify(next.chats)
    if (signature === this.signature) return
    this.signature = signature
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }
}
