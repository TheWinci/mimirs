export interface Report {
  readonly id: string;
  title: string;
  archived?: boolean;
}

export declare class ReportStore {
  constructor(initial?: readonly Report[]);
  get(id: string): Report | undefined;
  list(options?: { archived?: boolean }): readonly Report[];
}

/** Format a report without providing an implementation. */
export declare function formatReport(report: Report): string;

export declare namespace formatReport {
  const version: string;
}
