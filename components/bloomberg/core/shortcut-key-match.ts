/** Match physical shortcut keys even when the active keyboard layout emits Thai characters. */
export function shortcutKeyMatches(
  event: Pick<KeyboardEvent, "key" | "code" | "shiftKey">,
  shortcutKey: string
): boolean {
  if (event.key.toLowerCase() === shortcutKey.toLowerCase()) return true;

  if (/^[a-z]$/i.test(shortcutKey)) {
    return event.code === `Key${shortcutKey.toUpperCase()}`;
  }
  if (/^[0-9]$/.test(shortcutKey)) {
    return event.code === `Digit${shortcutKey}` || event.code === `Numpad${shortcutKey}`;
  }
  if (shortcutKey === "/") return event.code === "Slash" && !event.shiftKey;
  if (shortcutKey === "?") return event.code === "Slash" && event.shiftKey;
  return false;
}
