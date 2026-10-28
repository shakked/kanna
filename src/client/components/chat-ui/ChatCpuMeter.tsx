import { cn } from "../../lib/utils"

export const CHAT_CPU_TOOLTIP = "CPU (process + children), last 5s"

/**
 * A chat's CPU on its row: a tiny bar filled to the share of one core, then
 * the percent. Muted on purpose, since it sits beside the age or project
 * label on every busy row. Fixed width with tabular figures, so a number that
 * changes every five seconds does not nudge the title's truncation.
 *
 * The server lists every chat with a live process. One that is idle (under
 * 1%) shows a dimmed "<1%", so it is clear the meter is there and working; a
 * chat with no process renders nothing.
 */
export function ChatCpuMeter({ percent, className }: { percent: number; className?: string }) {
  const fill = Math.min(100, Math.max(0, percent))
  const idle = percent < 1
  return (
    <span
      className={cn(
        "pointer-events-auto flex w-10 shrink-0 items-center justify-end gap-1 tabular-nums text-[11px] leading-none",
        idle ? "text-muted-foreground/40" : "text-muted-foreground/70",
        className,
      )}
      title={CHAT_CPU_TOOLTIP}
      aria-label={idle ? "CPU under 1%" : `CPU ${percent}%`}
      data-testid="chat-cpu"
    >
      <span aria-hidden className="relative h-2.5 w-[3px] shrink-0 overflow-hidden rounded-full bg-muted-foreground/20">
        <span className="absolute inset-x-0 bottom-0 rounded-full bg-muted-foreground/60" style={{ height: `${fill}%` }} />
      </span>
      <span>{idle ? "<1%" : `${percent}%`}</span>
    </span>
  )
}
