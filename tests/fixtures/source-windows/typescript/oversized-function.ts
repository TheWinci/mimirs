type ReportEntry = {
  title: string;
  archivedAt: string | null;
  createdAt: string;
  owner?: { displayName: string };
};

type ReportServices = {
  loadAccount(id: string): Promise<{ id: string; name: string }>;
  loadEntries(id: string): Promise<readonly ReportEntry[]>;
  recordAccess(id: string, entries: number): Promise<void>;
};

export async function assembleReport(
  accountId: string,
  includeArchived: boolean,
  services: ReportServices,
): Promise<string> {
  const account = await services.loadAccount(accountId);
  const entries = await services.loadEntries(account.id);

  const visible = entries.filter((entry) => {
    return includeArchived || entry.archivedAt === null;
  });

  const ordered = visible.toSorted((left, right) => {
    return left.createdAt.localeCompare(right.createdAt);
  });

  const lines = ordered.map((entry) => {
    const owner = entry.owner?.displayName ?? "unassigned";
    return `${entry.title} — ${owner}`;
  });

  await services.recordAccess(account.id, lines.length);
  return [`Report for ${account.name}`, ...lines].join("\n");
}
