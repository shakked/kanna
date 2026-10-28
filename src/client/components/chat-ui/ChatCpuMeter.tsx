import { cn } from "../../lib/utils"
import { useChatCpuCores, useChatCpuSubChats } from "../../stores/chatCpuStore"

export function chatCpuTooltip(cores: number | null, subChats = 0) {
  const machine = cores ? `this Mac (${cores} cores)` : "this Mac"
  if (subChats > 0) {
    return `CPU: this chat + ${subChats} sub-chat${subChats === 1 ? "" : "s"} (share of ${machine}, last 5s)`
  }
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
 *
 * Given `chatId`, a chat with live sub-chats (a delegator, or a chat that
 * adopted others) shows the total over it and all of them, marked `Σ`;
 * `percent` is then that total (see `useChatCpu`).
 */
export function ChatCpuMeter({ percent, chatId, className }: { percent: number; chatId?: string; className?: string }) {
  const cores = useChatCpuCores()
  const subChats = useChatCpuSubChats(chatId)
  const total = subChats > 0
  const fill = Math.min(100, Math.max(0, percent))
  const idle = percent < 1
  const label = formatChatCpu(percent)
  return (
    <span
      className={cn(
        "pointer-events-auto flex w-11 shrink-0 items-center justify-end gap-1 tabular-nums text-[11px] leading-none",
        idle ? "text-muted-foreground/40" : "text-muted-foreground/70",
        className,
      )}
      title={chatCpuTooltip(cores, subChats)}
      aria-label={total
        ? `CPU ${label} of this Mac, this chat and ${subChats} sub-chat${subChats === 1 ? "" : "s"}`
        : idle ? "CPU under 1% of this Mac" : `CPU ${label} of this Mac`}
      data-testid="chat-cpu"
    >
      <span aria-hidden className="relative h-2.5 w-[3px] shrink-0 overflow-hidden rounded-full bg-muted-foreground/20">
        <span className="absolute inset-x-0 bottom-0 rounded-full bg-muted-foreground/60" style={{ height: `${fill}%` }} />
      </span>
      <span>
        {total ? <span aria-hidden className="mr-px font-medium">Σ</span> : null}
        {label}
      </span>
    </span>
  )
}
