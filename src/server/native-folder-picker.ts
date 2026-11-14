import { existsSync, statSync } from "node:fs"
import type { FsChooseDirectoryResult } from "../shared/types"
import { resolveLocalPath } from "./paths"

/**
 * The macOS folder dialog (NSOpenPanel, directories only) via AppleScript's
 * `choose folder`, run on the server's Mac. Only meaningful when the browser
 * is on that same Mac: the client decides that and falls back to the in-app
 * browser otherwise, or when this reports `supported: false`.
 *
 * `activate` brings osascript's dialog in front of the Kanna window; the
 * paths travel as argv so nothing is interpolated into the script.
 */
const SCRIPT = `on run argv
  set promptText to item 1 of argv
  activate
  if (count of argv) > 1 then
    set chosen to choose folder with prompt promptText default location (POSIX file (item 2 of argv))
  else
    set chosen to choose folder with prompt promptText
  end if
  return POSIX path of chosen
end run`

// One dialog at a time: a second request waits for the open one's answer.
let inFlight: Promise<FsChooseDirectoryResult> | null = null

export function chooseDirectoryNatively(options: { prompt?: string; defaultPath?: string } = {}): Promise<FsChooseDirectoryResult> {
  if (process.platform !== "darwin") return Promise.resolve({ supported: false, path: null })
  inFlight ??= run(options).finally(() => { inFlight = null })
  return inFlight
}

async function run({ prompt, defaultPath }: { prompt?: string; defaultPath?: string }): Promise<FsChooseDirectoryResult> {
  const args = [prompt?.trim() || "Choose a project folder"]
  const start = defaultPath?.trim() ? resolveLocalPath(defaultPath) : null
  if (start && existsSync(start) && statSync(start).isDirectory()) args.push(start)

  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(["/usr/bin/osascript", "-e", SCRIPT, ...args], { stdout: "pipe", stderr: "pipe" })
  } catch {
    return { supported: false, path: null }
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ])
  if (exitCode !== 0) {
    // -128 is "User canceled."
    if (/-128\b/.test(stderr)) return { supported: true, path: null }
    throw new Error(stderr.trim() || `osascript exited with ${exitCode}`)
  }
  const chosen = stdout.trim()
  if (!chosen) return { supported: true, path: null }
  return { supported: true, path: chosen.length > 1 ? chosen.replace(/\/+$/, "") : chosen }
}
