import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react"
import type { UsageLimitCredits } from "../../../shared/types"
import { formatMoney, formatMoneyExact, formatPercent, formatUntil } from "../../app/settings/UsageSection"
import { openCommandPalette } from "../command-palette/CommandPalette"
import { formatResetCountdown, pickUsageLayout, windowAsOf, type ComposerUsageRow } from "../../lib/composerUsage"
import { formatRelativeTime } from "../../lib/formatters"
import { cn } from "../../lib/utils"
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip"

/** What's left under a spend cap, abbreviated: "$956 left", "$1.2k left". */
function creditsLeft(credits: UsageLimitCredits): string | null {
  if (credits.usedAmount === null || credits.limitAmount === null) return null
  return `${formatMoney(Math.max(0, credits.limitAmount - credits.usedAmount), credits.currency)} left`
}

/** The spend to the cent: "$43.56 of $1,000 used". */
function creditsSpent(credits: UsageLimitCredits): string | null {
  if (credits.usedAmount === null) return null
  const used = formatMoneyExact(credits.usedAmount, credits.currency)
  return credits.limitAmount !== null ? `${used} of ${formatMoneyExact(credits.limitAmount, credits.currency)} used` : `${used} used`
}

/** "Nov 1": the day a reset lands on, in local time. */
function formatResetDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

/** The first column: the window's short name, or for a spend cap its reset countdown. */
function rowLead({ shortLabel, credits, assumedResetsAt }: ComposerUsageRow): string {
  if (!credits) return shortLabel
  return (assumedResetsAt && formatResetCountdown(assumedResetsAt)) || ""
}

/** The fourth column: the reset countdown, or for a spend cap what's left. */
function rowTail({ window, credits }: ComposerUsageRow): string | null {
  return credits ? creditsLeft(credits) : formatResetCountdown(window.resetsAt)
}

function fillColorClass(usedPercent: number): string {
  if (usedPercent >= 90) return "bg-red-500"
  if (usedPercent >= 75) return "bg-amber-500"
  return "bg-muted-foreground"
}

/** Re-renders once a minute, for the reset countdowns. */
function useMinuteTick() {
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((tick) => tick + 1), 60_000)
    return () => clearInterval(id)
  }, [])
}

const GRID_CLASS = "grid shrink-0 items-center gap-x-1.5 px-1 text-left text-[9px] font-medium leading-[9px]"
const FULL_COLUMNS = "grid-cols-[auto_40px_auto_auto]"
const COMPACT_COLUMNS = "grid-cols-[auto_40px_auto]"
// A lone spend-cap row with no known reset has nothing to lead with, so no
// first column either.
const UNLABELED_FULL_COLUMNS = "grid-cols-[40px_auto_auto]"
const UNLABELED_COMPACT_COLUMNS = "grid-cols-[40px_auto]"

function gridColumns(labeled: boolean, full: boolean): string {
  if (labeled) return full ? FULL_COLUMNS : COMPACT_COLUMNS
  return full ? UNLABELED_FULL_COLUMNS : UNLABELED_COMPACT_COLUMNS
}

function UsageRows({ rows, showCountdown, labeled }: { rows: ComposerUsageRow[]; showCountdown: boolean; labeled: boolean }) {
  return rows.map((row) => {
    const { window } = row
    const usedPercent = Math.max(0, Math.min(100, window.usedPercent ?? 0))
    return (
      <Fragment key={window.id}>
        {/* Kept (empty) beside labelled rows, so the columns line up. */}
        {labeled ? <span className="whitespace-nowrap tabular-nums">{rowLead(row)}</span> : null}
        <span className="h-[3px] overflow-hidden rounded-full bg-muted-foreground/20" aria-hidden="true">
          <span
            className={cn("block h-full rounded-full transition-[width] duration-500 ease-out", fillColorClass(usedPercent))}
            style={{ width: `${usedPercent > 0 ? Math.max(4, usedPercent) : 0}%` }}
          />
        </span>
        <span className="whitespace-nowrap text-right tabular-nums">{formatPercent(window.usedPercent)}</span>
        {showCountdown ? (
          <span className="whitespace-nowrap tabular-nums">{rowTail(row) ?? ""}</span>
        ) : null}
      </Fragment>
    )
  })
}

/**
 * The selected provider's plan usage beside the composer's options row: one
 * thin meter per window that limits the current model, shortest first
 * ("5h ▬▬ 42% 2h 14m" over "Wk ▬ 18% 3d 4h"), in the context dial's 9px
 * type, spread to the dial's 24px height. Full names on hover; opens the
 * command palette's Usage page.
 *
 * Given `room` (px free beside the centred controls), it drops the reset
 * countdowns from every row when the whole stack won't fit, and reports
 * `onFitChange(false)` when even that won't, so the caller can place it
 * elsewhere rather than overlap the controls.
 */
export function ComposerUsageBar({
  rows: rawRows,
  className,
  room = null,
  onFitChange,
}: {
  rows: ComposerUsageRow[]
  className?: string
  room?: number | null
  onFitChange?: (fits: boolean) => void
}) {
  useMinuteTick()
  // Re-read each minute, so a window that resets mid-session drops to 0%.
  const rows = rawRows.map((row) => ({ ...row, window: windowAsOf(row.window) }))
  const labeled = rows.some((row) => rowLead(row) !== "")
  const summary = rows.map((row) => {
    const tail = rowTail(row)
    const suffix = tail ? (row.credits ? `, ${tail}` : `, resets in ${tail}`) : ""
    return `${row.window.label} ${formatPercent(row.window.usedPercent)} used${suffix}`
  }).join("; ")

  // Both widths come from invisible copies, so the choice never depends on
  // which one is showing (no flip-flop as the countdown text changes).
  const fullRef = useRef<HTMLSpanElement>(null)
  const compactRef = useRef<HTMLSpanElement>(null)
  const [widths, setWidths] = useState({ full: 0, compact: 0 })
  useLayoutEffect(() => {
    const full = fullRef.current?.offsetWidth ?? 0
    const compact = compactRef.current?.offsetWidth ?? 0
    if (full !== widths.full || compact !== widths.compact) setWidths({ full, compact })
  })
  // Unmeasured (display:none, below lg) counts as fitting.
  const layout = widths.full === 0 ? "full" : pickUsageLayout(room, widths.full, widths.compact)
  const fits = layout !== "none"
  useEffect(() => {
    onFitChange?.(fits)
  }, [fits, onFitChange])

  return (
    <Tooltip delayDuration={0}>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => openCommandPalette("usage")}
          aria-label={`Plan usage: ${summary}. Open usage`}
          className={cn(
            GRID_CLASS,
            gridColumns(labeled, layout === "full"),
            "relative min-h-6 cursor-pointer rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            // As tall as the context ring (24px): rows spread over it, a lone
            // row centred in it; three or more fill it on their own.
            rows.length > 1 ? "content-between" : "content-center",
            className,
          )}
        >
          <UsageRows rows={rows} showCountdown={layout === "full"} labeled={labeled} />
          {/* Measuring copies: zero-size and clipped, so they never add to
              the row's scroll width. */}
          <span aria-hidden="true" className="pointer-events-none invisible absolute left-0 top-0 h-0 w-0 overflow-hidden">
            <span ref={fullRef} className={cn(GRID_CLASS, gridColumns(labeled, true), "w-max")}>
              <UsageRows rows={rows} showCountdown labeled={labeled} />
            </span>
            <span ref={compactRef} className={cn(GRID_CLASS, gridColumns(labeled, false), "w-max")}>
              <UsageRows rows={rows} showCountdown={false} labeled={labeled} />
            </span>
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" align="start" className="w-max max-w-none px-3 py-2">
        <div className="space-y-1.5 leading-tight">
          {rows.map(({ window, credits, assumedResetsAt }) => {
            const resets = window.resetsAt ? `Resets ${formatUntil(window.resetsAt)}` : null
            const assumedReset = assumedResetsAt ? `Resets ${formatResetDate(assumedResetsAt)} (assumed)` : null
            const spent = credits ? creditsSpent(credits) : null
            // Pushed and refreshed reads are current; a cached one is from an
            // earlier session, so say how old it is.
            const stale = window.source === "cache" ? `Updated ${formatRelativeTime(window.recordedAt)}` : null
            // A window's reset and age share a line; a spend cap says what was
            // spent (and how old that is), then when it resets.
            const lines = credits
              ? [[spent, stale], [assumedReset]]
              : [[resets, stale]]
            return (
              <div key={window.id}>
                <div className="whitespace-nowrap text-xs font-medium text-foreground">
                  {window.label} · {formatPercent(window.usedPercent)} used
                </div>
                {lines.map((parts, index) => {
                  const text = parts.filter(Boolean).join(" · ")
                  return text ? (
                    <div key={index} className="whitespace-nowrap text-xs text-muted-foreground">{text}</div>
                  ) : null
                })}
              </div>
            )
          })}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
