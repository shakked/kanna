import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { formatPercent, formatUntil } from "../../app/settings/UsageSection"
import { formatResetCountdown, type ComposerUsage } from "../../lib/composerUsage"
import { formatRelativeTime } from "../../lib/formatters"
import { cn } from "../../lib/utils"
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip"

function fillColorClass(usedPercent: number): string {
  if (usedPercent >= 90) return "bg-red-500"
  if (usedPercent >= 75) return "bg-amber-500"
  return "bg-muted-foreground"
}

/** Re-renders once a minute, for the reset countdown. */
function useMinuteTick() {
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((tick) => tick + 1), 60_000)
    return () => clearInterval(id)
  }, [])
}

/**
 * The selected provider's plan usage, as a slim meter beside the composer's
 * options row: "42% ▬▬ 2h 14m" for the window the current model is closest
 * to using up, with the full window name on hover. Opens Settings → Usage.
 * The context dial's counterpart on the other side of the row.
 */
export function ComposerUsageBar({ usage, className }: { usage: ComposerUsage; className?: string }) {
  const { window } = usage
  const navigate = useNavigate()
  useMinuteTick()
  const usedPercent = Math.max(0, Math.min(100, window.usedPercent ?? 0))
  const percentText = formatPercent(window.usedPercent)
  const resets = window.resetsAt ? formatUntil(window.resetsAt) : null
  const countdown = formatResetCountdown(window.resetsAt)
  // Pushed and refreshed reads are current; a cached one is from an earlier
  // session, so say how old it is.
  const stale = window.source === "cache" ? `Updated ${formatRelativeTime(window.recordedAt)}` : null

  return (
    <Tooltip delayDuration={0}>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => navigate("/settings/usage")}
          aria-label={`${window.label}: ${percentText} used${countdown ? `, resets in ${countdown}` : ""}. Open usage settings`}
          className={cn(
            "inline-flex shrink-0 cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            className,
          )}
        >
          <span className="whitespace-nowrap tabular-nums">{percentText}</span>
          <span className="h-1 w-12 overflow-hidden rounded-full bg-muted-foreground/20" aria-hidden="true">
            <span
              className={cn("block h-full rounded-full transition-[width] duration-500 ease-out", fillColorClass(usedPercent))}
              style={{ width: `${usedPercent > 0 ? Math.max(4, usedPercent) : 0}%` }}
            />
          </span>
          {countdown ? <span className="whitespace-nowrap tabular-nums">{countdown}</span> : null}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" align="start" className="w-max max-w-none px-3 py-2">
        <div className="space-y-1 leading-tight">
          <div className="whitespace-nowrap text-xs font-medium text-foreground">
            {window.label} · {percentText} used
          </div>
          {resets || stale ? (
            <div className="whitespace-nowrap text-xs text-muted-foreground">
              {[resets ? `Resets ${resets}` : null, stale].filter(Boolean).join(" · ")}
            </div>
          ) : null}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
