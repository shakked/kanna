/**
 * Freezes every CSS animation while the window is hidden or another app has
 * focus, by putting `kanna-paused` on <html> (index.css pauses everything
 * under it). Spinners, pings and shimmers on working chats otherwise keep the
 * compositor and GPU producing frames all day for nobody to look at.
 *
 * Focus moving into one of our own iframes (a visualization, a preview) also
 * blurs the window, so a blur is only believed once `hasFocus()` agrees on
 * the next task. Focus coming back unpauses at once.
 */
export function pauseAnimationsWhenAway() {
  const root = document.documentElement
  let blurCheck: ReturnType<typeof setTimeout> | undefined

  const update = () => {
    root.classList.toggle("kanna-paused", document.hidden || !document.hasFocus())
  }

  const onBlur = () => {
    clearTimeout(blurCheck)
    blurCheck = setTimeout(update, 0)
  }

  const onFocus = () => {
    clearTimeout(blurCheck)
    root.classList.remove("kanna-paused")
  }

  document.addEventListener("visibilitychange", update)
  window.addEventListener("blur", onBlur)
  window.addEventListener("focus", onFocus)
  update()
}
