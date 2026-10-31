import { useMemo } from "react"
import { useUsageLimitsSnapshot } from "../../../hooks/useUsageLimitsSnapshot"
import { selectComposerUsage } from "../../../lib/composerUsage"
import { useAppSettingsStore } from "../../../stores/appSettingsStore"
import type { KannaSocket } from "../../../app/socket"
import type { AgentProvider } from "../../../../shared/types"
import { PROVIDER_ICONS } from "../../provider-icons"
import { UsageBar } from "../UsageBar"

/** Short block titles; the catalog labels ("Claude Code") are too wide here. */
const USAGE_TITLES: Record<AgentProvider, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  grok: "Grok",
  pi: "Pi",
}

/**
 * Plan usage at the foot of the sidebar, above the machine switcher: one
 * block per provider in the usage snapshot (server order), each with its
 * icon. The sidebar
 * isn't tied to a chat, so there is no model to narrow by: each shows the
 * limits every model shares. A provider with nothing to report is left out,
 * and with none the whole block is. Display-only; a click opens Usage.
 */
export function SidebarUsage({ socket }: { socket: KannaSocket }) {
  const snapshot = useUsageLimitsSnapshot(socket)
  const usageResetDay = useAppSettingsStore((store) => store.settings?.usageResetDay)
  const blocks = useMemo(() => {
    const now = Date.now()
    return (snapshot?.providers ?? []).flatMap(({ provider }) => {
      const rows = selectComposerUsage(snapshot, provider, null, now, usageResetDay)
      return rows ? [{ provider, title: USAGE_TITLES[provider], rows }] : []
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
