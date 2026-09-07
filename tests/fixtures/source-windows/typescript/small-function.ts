/** Format one user for display in search results. */
export function formatUser(name: string, active: boolean): string {
  const status = active ? "active" : "inactive";
  return `${name} (${status})`;
}
