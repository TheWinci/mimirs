import { formatReport } from "./format.js";

/** Render a report card with an explicit event call. */
export function ReportCard({ report, onOpen }) {
  const title = formatReport(report);

  return (
    <article data-report-id={report.id}>
      <h2>{title}</h2>
      <button onClick={() => onOpen(report.id)}>Open</button>
    </article>
  );
}
