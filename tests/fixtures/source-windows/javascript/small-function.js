/** Format one account label for a search result. */
export function formatAccount(name, active) {
  const status = active ? "active" : "disabled";
  return `${name.trim()} (${status})`;
}
