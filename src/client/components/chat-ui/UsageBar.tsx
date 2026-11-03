import { Fragment, useEffect, useState, type ReactNode } from "react"
import type { UsageLimitCredits } from "../../../shared/types"
import { formatMoney, formatMoneyExact, formatPercent, formatUntil } from "../../app/settings/UsageSection"
import { openCommandPalette } from "../command-palette/CommandPalette"
import { formatResetCountdown, windowAsOf, type ComposerUsageRow } from "../../lib/composerUsage"
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
function rowLead({ shortLabel, credits, resetsAt, assumedResetsAt }: ComposerUsageRow): string {
  if (!credits) return shortLabel
  const reset = resetsAt ?? assumedResetsAt
  return (reset && formatResetCountdown(reset)) || ""
}

/** The fourth column: the reset countdown, or for a spend cap what's left. */
function rowTail({ window, credits }: ComposerUsageRow): string | null {
  return credits ? creditsLeft(credits) : formatResetCountdown(window.resetsAt)
}

function fillColorClass(usedPercent: number, limitReached: boolean): string {
  if (limitReached || usedPercent >= 90) return "bg-red-500"
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

/**
 * The columns every `UsageBar` in a stack shares, set on their common parent:
 * icon, lead, meter, percent, tail. Each bar is a subgrid of it, so the text
 * columns are as wide as the widest cell in any provider's rows and every
 * meter, Claude's and Codex's alike, is the same length. The percent and tail
 * columns hold room for "100%" and "23h 59m", so the meters don't change
 * length as countdowns tick.
 */
export const USAGE_STACK_CLASS = "grid grid-cols-[auto_auto_minmax(24px,1fr)_minmax(4ch,auto)_minmax(7ch,auto)] gap-x-1.5 text-[9px] font-medium leading-[9px]"

function UsageRows({ rows }: { rows: ComposerUsageRow[] }) {
  return rows.map((row) => {
    const { window } = row
    const usedPercent = Math.max(0, Math.min(100, window.usedPercent ?? 0))
    return (
      <Fragment key={window.id}>
        {/* Empty for a spend cap with no known reset, so the columns line up. */}
        <span className="col-start-2 whitespace-nowrap tabular-nums">{rowLead(row)}</span>
        <span className="h-[3px] overflow-hidden rounded-full bg-muted-foreground/20" aria-hidden="true">
          <span
            className={cn("block h-full rounded-full transition-[width] duration-500 ease-out", fillColorClass(usedPercent, row.credits?.limitReached === true))}
            style={{ width: `${usedPercent > 0 ? Math.max(4, usedPercent) : 0}%` }}
          />
        </span>
        <span className="whitespace-nowrap text-right tabular-nums">{formatPercent(window.usedPercent)}</span>
        <span className="whitespace-nowrap tabular-nums">{rowTail(row) ?? ""}</span>
      </Fragment>
    )
  })
}

/**
 * One provider's plan usage: a thin meter per window that limits it, shortest
 * first ("5h ▬▬ 42% 2h 14m" over "Wk ▬ 18% 3d 4h"), or a lone spend-cap row
 * ("8d ▬▬ 4% $956 left"), in 9px type, after the provider's icon. Lays out on
 * its parent's `USAGE_STACK_CLASS` columns. Full names on hover; opens the
 * command palette's Usage page.
 */
export function UsageBar({
  rows: rawRows,
  title,
  icon,
  className,
}: {
  rows: ComposerUsageRow[]
  /** Whose usage this is: the hover card's heading and the button's name. */
  title: string
  icon?: ReactNode
  className?: string
}) {
  useMinuteTick()
  // Re-read each minute, so a window that resets mid-session drops to 0%.
  const rows = rawRows.map((row) => ({ ...row, window: windowAsOf(row.window) }))
  const summary = rows.map((row) => {
    const tail = rowTail(row)
    const suffix = tail ? (row.credits ? `, ${tail}` : `, resets in ${tail}`) : ""
    return `${row.window.label} ${formatPercent(row.window.usedPercent)} used${suffix}`
  }).join("; ")

  return (
    <Tooltip delayDuration={0}>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => openCommandPalette("usage")}
          aria-label={`${title} plan usage: ${summary}. Open usage`}
          className={cn(
            "col-span-full grid min-w-0 cursor-pointer grid-cols-subgrid items-center gap-y-1 overflow-hidden rounded-md px-1 py-0.5 text-left text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            className,
          )}
        >
          <span
            className="col-start-1 mr-0.5 flex size-3.5 items-center justify-center [&>svg]:size-3.5"
            style={{ gridRow: `1 / span ${rows.length}` }}
            aria-hidden="true"
          >
            {icon}
          </span>
          <UsageRows rows={rows} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" align="start" className="w-max max-w-none px-3 py-2">
        <div className="space-y-1.5 leading-tight">
          <div className="whitespace-nowrap text-xs font-semibold text-foreground">{title}</div>
          {rows.map(({ window, credits, resetsAt: realResetsAt, assumedResetsAt }) => {
            const resets = window.resetsAt ? `Resets ${formatUntil(window.resetsAt)}` : null
            // A reported reset is stated plainly; Claude's is only assumed.
            const assumedReset = realResetsAt
              ? `Resets ${formatResetDate(realResetsAt)}`
              : assumedResetsAt ? `Resets ${formatResetDate(assumedResetsAt)} (assumed)` : null
            const reached = credits?.limitReached ? "Spend limit reached" : null
            const spent = credits ? creditsSpent(credits) : null
            // Pushed and refreshed reads are current; a cached one is from an
            // earlier session, so say how old it is.
            const stale = window.source === "cache" ? `Updated ${formatRelativeTime(window.recordedAt)}` : null
            // A window's reset and age share a line; a spend cap says what was
            // spent (and how old that is), then when it resets.
            const lines = credits
              ? [[reached], [spent, stale], [assumedReset]]
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
