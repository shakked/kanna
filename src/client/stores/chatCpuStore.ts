import { create } from "zustand"
import type { ChatCpuSnapshot } from "../../shared/types"

interface ChatCpuStore {
  /** Whole percent of one core by chat id; absent means nothing to show. */
  chats: Record<string, number>
  setSnapshot: (snapshot: ChatCpuSnapshot) => void
  clear: () => void
}

/**
 * The pushed `chat-cpu` snapshot. Fed once for the app's lifetime (the
 * layout subscribes); rows read their own chat's figure with `useChatCpu`,
 * so a push re-renders only the rows whose number moved.
 */
export const useChatCpuStore = create<ChatCpuStore>((set) => ({
  chats: {},
  setSnapshot: (snapshot) => set({ chats: snapshot.chats }),
  clear: () => set({ chats: {} }),
}))

export function useChatCpu(chatId: string): number | null {
  return useChatCpuStore((store) => store.chats[chatId] ?? null)
}
