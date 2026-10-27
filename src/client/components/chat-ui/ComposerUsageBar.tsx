import { Fragment, useEffect, useState } from "react"
import { formatPercent, formatUntil } from "../../app/settings/UsageSection"
import { openCommandPalette } from "../command-palette/CommandPalette"
import { formatResetCountdown, type ComposerUsageRow } from "../../lib/composerUsage"
import { formatRelativeTime } from "../../lib/formatters"
import { cn } from "../../lib/utils"
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip"

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

/**
 * The selected provider's plan usage beside the composer's options row: one
 * thin meter per window that limits the current model, shortest first
 * ("5h ▬▬ 42% 2h 14m" over "Wk ▬ 18% 3d 4h"), in the context dial's 9px
 * type, spread to the dial's 24px height. Full names on hover; opens the command palette's Usage page.
 */
export function ComposerUsageBar({ rows, className }: { rows: ComposerUsageRow[]; className?: string }) {
  useMinuteTick()
  const summary = rows.map(({ window }) => {
    const countdown = formatResetCountdown(window.resetsAt)
    return `${window.label} ${formatPercent(window.usedPercent)} used${countdown ? `, resets in ${countdown}` : ""}`
  }).join("; ")

  return (
    <Tooltip delayDuration={0}>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => openCommandPalette("usage")}
          aria-label={`Plan usage: ${summary}. Open usage`}
          className={cn(
            "grid min-h-6 shrink-0 cursor-pointer grid-cols-[auto_40px_auto_auto] items-center gap-x-1.5 rounded-md px-1 text-left text-[9px] font-medium leading-[9px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            // As tall as the context ring (24px): rows spread over it, a lone
            // row centred in it; three or more fill it on their own.
            rows.length > 1 ? "content-between" : "content-center",
            className,
          )}
        >
          {rows.map(({ window, shortLabel }) => {
            const usedPercent = Math.max(0, Math.min(100, window.usedPercent ?? 0))
            return (
              <Fragment key={window.id}>
                <span className="whitespace-nowrap">{shortLabel}</span>
                <span className="h-[3px] overflow-hidden rounded-full bg-muted-foreground/20" aria-hidden="true">
                  <span
                    className={cn("block h-full rounded-full transition-[width] duration-500 ease-out", fillColorClass(usedPercent))}
                    style={{ width: `${usedPercent > 0 ? Math.max(4, usedPercent) : 0}%` }}
                  />
                </span>
                <span className="whitespace-nowrap text-right tabular-nums">{formatPercent(window.usedPercent)}</span>
                <span className="whitespace-nowrap tabular-nums">{formatResetCountdown(window.resetsAt) ?? ""}</span>
              </Fragment>
            )
          })}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" align="start" className="w-max max-w-none px-3 py-2">
        <div className="space-y-1.5 leading-tight">
          {rows.map(({ window }) => {
            const resets = window.resetsAt ? formatUntil(window.resetsAt) : null
            // Pushed and refreshed reads are current; a cached one is from an
            // earlier session, so say how old it is.
            const stale = window.source === "cache" ? `Updated ${formatRelativeTime(window.recordedAt)}` : null
            return (
              <div key={window.id}>
                <div className="whitespace-nowrap text-xs font-medium text-foreground">
                  {window.label} · {formatPercent(window.usedPercent)} used
                </div>
                {resets || stale ? (
                  <div className="whitespace-nowrap text-xs text-muted-foreground">
                    {[resets ? `Resets ${resets}` : null, stale].filter(Boolean).join(" · ")}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
