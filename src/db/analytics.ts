import { Database } from "bun:sqlite";

export function logQuery(db: Database, query: string, resultCount: number, topScore: number | null, topPath: string | null, durationMs: number) {
  db.run(
    "INSERT INTO query_log (query, result_count, top_score, top_path, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [query, resultCount, topScore, topPath, durationMs, new Date().toISOString()]
  );
}

export function getAnalytics(db: Database, days: number = 30): {
  totalQueries: number;
  avgResultCount: number;
  avgTopScore: number | null;
  zeroResultQueries: { query: string; count: number }[];
  lowScoreQueries: { query: string; topScore: number; timestamp: string }[];
  topSearchedTerms: { query: string; count: number }[];
  queriesPerDay: { date: string; count: number }[];
} {
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const total = db
    .query<{ count: number }, [string]>("SELECT COUNT(*) as count FROM query_log WHERE created_at >= ?")
    .get(since)!;

  const avgResult = db
    .query<{ avg: number | null }, [string]>("SELECT AVG(result_count) as avg FROM query_log WHERE created_at >= ?")
    .get(since)!;

  const avgScore = db
    .query<{ avg: number | null }, [string]>("SELECT AVG(top_score) as avg FROM query_log WHERE top_score IS NOT NULL AND created_at >= ?")
    .get(since)!;

  const zeroResult = db
    .query<{ query: string; count: number }, [string]>(
      "SELECT query, COUNT(*) as count FROM query_log WHERE result_count = 0 AND created_at >= ? GROUP BY query ORDER BY count DESC LIMIT 10"
    )
    .all(since);

  const lowScore = db
    .query<{ query: string; top_score: number; created_at: string }, [string]>(
      "SELECT query, top_score, created_at FROM query_log WHERE top_score IS NOT NULL AND top_score < 0.3 AND created_at >= ? ORDER BY top_score ASC LIMIT 10"
    )
    .all(since)
    .map((r) => ({ query: r.query, topScore: r.top_score, timestamp: r.created_at }));

  const topTerms = db
    .query<{ query: string; count: number }, [string]>(
      "SELECT query, COUNT(*) as count FROM query_log WHERE created_at >= ? GROUP BY query ORDER BY count DESC LIMIT 10"
    )
    .all(since);

  const perDay = db
    .query<{ date: string; count: number }, [string]>(
      "SELECT substr(created_at, 1, 10) as date, COUNT(*) as count FROM query_log WHERE created_at >= ? GROUP BY date ORDER BY date"
    )
    .all(since);

  return {
    totalQueries: total.count,
    avgResultCount: avgResult.avg ?? 0,
    avgTopScore: avgScore.avg,
    zeroResultQueries: zeroResult,
    lowScoreQueries: lowScore,
    topSearchedTerms: topTerms,
    queriesPerDay: perDay,
  };
}

export function getAnalyticsTrend(db: Database, days: number = 7): {
  current: { totalQueries: number; avgTopScore: number | null; zeroResultRate: number };
  previous: { totalQueries: number; avgTopScore: number | null; zeroResultRate: number };
  delta: { queries: number; avgTopScore: number | null; zeroResultRate: number };
} {
  const now = Date.now();
  const currentStart = new Date(now - days * 86400000).toISOString();
  const previousStart = new Date(now - days * 2 * 86400000).toISOString();

  const getCounts = (since: string, until: string) => {
    const total = db
      .query<{ count: number }, [string, string]>(
        "SELECT COUNT(*) as count FROM query_log WHERE created_at >= ? AND created_at < ?"
      )
      .get(since, until)!;

    const avgScore = db
      .query<{ avg: number | null }, [string, string]>(
        "SELECT AVG(top_score) as avg FROM query_log WHERE top_score IS NOT NULL AND created_at >= ? AND created_at < ?"
      )
      .get(since, until)!;

    const zeroCount = db
      .query<{ count: number }, [string, string]>(
        "SELECT COUNT(*) as count FROM query_log WHERE result_count = 0 AND created_at >= ? AND created_at < ?"
      )
      .get(since, until)!;

    const zeroResultRate = total.count > 0 ? zeroCount.count / total.count : 0;

    return { totalQueries: total.count, avgTopScore: avgScore.avg, zeroResultRate };
  };

  const farFuture = "9999-12-31T23:59:59.999Z";
  const current = getCounts(currentStart, farFuture);
  const previous = getCounts(previousStart, currentStart);

  const delta = {
    queries: current.totalQueries - previous.totalQueries,
    avgTopScore:
      current.avgTopScore !== null && previous.avgTopScore !== null
        ? current.avgTopScore - previous.avgTopScore
        : null,
    zeroResultRate: current.zeroResultRate - previous.zeroResultRate,
  };

  return { current, previous, delta };
}
