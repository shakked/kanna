import { cn } from "../../lib/utils"
import { useChatCpuCores } from "../../stores/chatCpuStore"

export function chatCpuTooltip(cores: number | null) {
  const machine = cores ? `this Mac (${cores} cores)` : "this Mac"
  return `CPU share of ${machine}, process + children, last 5s`
}

/** One decimal under 10 (`2.5%`), whole above; a trailing `.0` is dropped. */
export function formatChatCpu(percent: number) {
  if (percent < 1) return "<1%"
  return `${percent < 10 ? Number(percent.toFixed(1)) : Math.round(percent)}%`
}

/**
 * A chat's CPU on its row, as a share of the whole machine: a tiny bar filled
 * to that share, then the percent. Muted on purpose, since it sits beside the
 * age or project label on every busy row. Fixed width with tabular figures,
 * so a number that changes every five seconds does not nudge the title's
 * truncation.
 *
 * The server lists every chat with a live process. One that is idle (under
 * 1% of the machine) shows a dimmed "<1%", so it is clear the meter is there
 * and working; a chat with no process renders nothing.
 */
export function ChatCpuMeter({ percent, className }: { percent: number; className?: string }) {
  const cores = useChatCpuCores()
  const fill = Math.min(100, Math.max(0, percent))
  const idle = percent < 1
  return (
    <span
      className={cn(
        "pointer-events-auto flex w-10 shrink-0 items-center justify-end gap-1 tabular-nums text-[11px] leading-none",
        idle ? "text-muted-foreground/40" : "text-muted-foreground/70",
        className,
      )}
      title={chatCpuTooltip(cores)}
      aria-label={idle ? "CPU under 1% of this Mac" : `CPU ${formatChatCpu(percent)} of this Mac`}
      data-testid="chat-cpu"
    >
      <span aria-hidden className="relative h-2.5 w-[3px] shrink-0 overflow-hidden rounded-full bg-muted-foreground/20">
        <span className="absolute inset-x-0 bottom-0 rounded-full bg-muted-foreground/60" style={{ height: `${fill}%` }} />
      </span>
      <span>{formatChatCpu(percent)}</span>
    </span>
  )
}
