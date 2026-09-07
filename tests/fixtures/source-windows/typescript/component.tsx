// @ts-nocheck -- standalone TSX parser fixture; no UI runtime is installed.
import type { Report } from "./report.ts";

interface ReportListProps {
  reports: Report[];
  onSelect(report: Report): void;
}

/** Render selectable reports. */
export function ReportList({ reports, onSelect }: ReportListProps) {
  const active = reports.filter((report) => !report.archived);

  return (
    <section aria-label="Reports">
      {active.map((report) => (
        <button key={report.id} onClick={() => onSelect(report)}>
          {report.title}
        </button>
      ))}
    </section>
  );
}
