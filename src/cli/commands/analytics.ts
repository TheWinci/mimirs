import { resolve } from "path";
import { RagDB } from "../../db";
import { cli } from "../../utils/log";

export async function analyticsCommand(args: string[], getFlag: (flag: string) => string | undefined) {
  const dir = resolve(args[1] && !args[1].startsWith("--") ? args[1] : ".");
  const days = parseInt(getFlag("--days") || "30", 10);
  const db = new RagDB(dir);
  const analytics = db.getAnalytics(days);

  const zeroCount = analytics.zeroResultQueries.reduce((s, q) => s + q.count, 0);
  const zeroRate = analytics.totalQueries > 0
    ? ((zeroCount / analytics.totalQueries) * 100).toFixed(0)
    : "0";

  cli.log(`Search analytics (last ${days} days):`);
  cli.log(`  Total queries:    ${analytics.totalQueries}`);
  cli.log(`  Avg results:      ${analytics.avgResultCount.toFixed(1)}`);
  cli.log(`  Avg top score:    ${analytics.avgTopScore?.toFixed(2) ?? "n/a"}`);
  cli.log(`  Zero-result rate: ${zeroRate}% (${zeroCount} queries)`);

  if (analytics.topSearchedTerms.length > 0) {
    cli.log("\nTop searches:");
    for (const t of analytics.topSearchedTerms) {
      cli.log(`  ${t.count}× "${t.query}"`);
    }
  }

  if (analytics.zeroResultQueries.length > 0) {
    cli.log("\nZero-result queries (consider indexing these topics):");
    for (const q of analytics.zeroResultQueries) {
      cli.log(`  ${q.count}× "${q.query}"`);
    }
  }

  if (analytics.lowScoreQueries.length > 0) {
    cli.log("\nLow-relevance queries (top score < 0.3):");
    for (const q of analytics.lowScoreQueries) {
      cli.log(`  "${q.query}" (score: ${q.topScore.toFixed(2)})`);
    }
  }

  // Trend comparison vs prior period
  const trend = db.getAnalyticsTrend(days);
  if (trend.previous.totalQueries > 0 || trend.current.totalQueries > 0) {
    const arrow = (delta: number) => delta > 0 ? `+${delta}` : `${delta}`;
    const pctArrow = (delta: number) =>
      delta > 0 ? `+${(delta * 100).toFixed(1)}%` : `${(delta * 100).toFixed(1)}%`;

    cli.log(`\nTrend (current ${days}d vs prior ${days}d):`);
    cli.log(`  Queries:          ${trend.current.totalQueries} (${arrow(trend.delta.queries)})`);
    if (trend.delta.avgTopScore !== null) {
      cli.log(`  Avg top score:    ${trend.current.avgTopScore?.toFixed(2)} (${trend.delta.avgTopScore >= 0 ? "+" : ""}${trend.delta.avgTopScore.toFixed(2)})`);
    }
    cli.log(`  Zero-result rate: ${(trend.current.zeroResultRate * 100).toFixed(0)}% (${pctArrow(trend.delta.zeroResultRate)})`);
  }

  db.close();
}
