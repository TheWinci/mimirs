/** Convert user-entered keyboard shortcuts into a canonical modifier sequence. */
export function normalizeShortcut(input) {
  const parts = input.split("+").map(part => part.trim().toLowerCase());
  const key = parts.pop();
  return [...new Set(parts)].sort().concat(key).join("+");
}

export const displayShortcut = shortcut => shortcut.toUpperCase();
