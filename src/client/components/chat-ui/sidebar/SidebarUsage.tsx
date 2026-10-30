import { useMemo } from "react"
import { useUsageLimitsSnapshot } from "../../../hooks/useUsageLimitsSnapshot"
import { selectComposerUsage } from "../../../lib/composerUsage"
import { useAppSettingsStore } from "../../../stores/appSettingsStore"
import type { KannaSocket } from "../../../app/socket"
import type { AgentProvider } from "../../../../shared/types"
import { PROVIDER_ICONS } from "../../provider-icons"
import { UsageBar } from "../UsageBar"

/** The harnesses whose plan usage the sidebar lists, in order. */
const USAGE_PROVIDERS: ReadonlyArray<{ provider: AgentProvider; title: string }> = [
  { provider: "claude", title: "Claude" },
  { provider: "codex", title: "Codex" },
]

/**
 * Plan usage for Claude and Codex at the foot of the sidebar, above the
 * machine switcher: one block per provider, each with its icon. The sidebar
 * isn't tied to a chat, so there is no model to narrow by: each shows the
 * limits every model shares. A provider with nothing to report is left out,
 * and with none the whole block is. Display-only; a click opens Usage.
 */
export function SidebarUsage({ socket }: { socket: KannaSocket }) {
  const snapshot = useUsageLimitsSnapshot(socket)
  const usageResetDay = useAppSettingsStore((store) => store.settings?.usageResetDay)
  const blocks = useMemo(() => {
    const now = Date.now()
    return USAGE_PROVIDERS.flatMap(({ provider, title }) => {
      const rows = selectComposerUsage(snapshot, provider, null, now, usageResetDay)
      return rows ? [{ provider, title, rows }] : []
    })
  }, [snapshot, usageResetDay])

  if (blocks.length === 0) return null

  return (
    <div className="flex flex-col gap-1.5 border-t border-border py-2 pl-2.5 pr-[7px]">
      {blocks.map(({ provider, title, rows }) => {
        const Icon = PROVIDER_ICONS[provider]
        return <UsageBar key={provider} rows={rows} title={title} icon={<Icon />} />
      })}
    </div>
  )
}
