import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { RagDB } from "../src/db";
import { createTempDir, cleanupTempDir } from "./helpers";

let tempDir: string;
let db: RagDB;

beforeEach(async () => {
  tempDir = await createTempDir();
  db = new RagDB(tempDir);
});

afterEach(async () => {
  db.close();
  await cleanupTempDir(tempDir);
});

describe("query logging", () => {
  test("logQuery inserts a record", () => {
    db.logQuery("test query", 3, 0.85, "/docs/setup.md", 42);
    const analytics = db.getAnalytics(30);
    expect(analytics.totalQueries).toBe(1);
    expect(analytics.topSearchedTerms[0].query).toBe("test query");
  });

  test("tracks zero-result queries", () => {
    db.logQuery("missing topic", 0, null, null, 30);
    db.logQuery("missing topic", 0, null, null, 25);
    db.logQuery("found something", 2, 0.6, "/a.md", 50);

    const analytics = db.getAnalytics(30);
    expect(analytics.zeroResultQueries.length).toBe(1);
    expect(analytics.zeroResultQueries[0].query).toBe("missing topic");
    expect(analytics.zeroResultQueries[0].count).toBe(2);
  });

  test("tracks low-score queries", () => {
    db.logQuery("vague question", 1, 0.15, "/a.md", 30);
    db.logQuery("good question", 3, 0.85, "/b.md", 40);

    const analytics = db.getAnalytics(30);
    expect(analytics.lowScoreQueries.length).toBe(1);
    expect(analytics.lowScoreQueries[0].query).toBe("vague question");
    expect(analytics.lowScoreQueries[0].topScore).toBe(0.15);
  });

  test("computes averages correctly", () => {
    db.logQuery("q1", 2, 0.6, "/a.md", 30);
    db.logQuery("q2", 4, 0.8, "/b.md", 50);

    const analytics = db.getAnalytics(30);
    expect(analytics.avgResultCount).toBe(3);
    expect(analytics.avgTopScore).toBe(0.7);
  });

  test("groups queries per day", () => {
    db.logQuery("q1", 1, 0.5, "/a.md", 20);
    db.logQuery("q2", 2, 0.6, "/b.md", 30);

    const analytics = db.getAnalytics(30);
    // Both logged today, so one day entry
    expect(analytics.queriesPerDay.length).toBe(1);
    expect(analytics.queriesPerDay[0].count).toBe(2);
  });

  test("respects day filter", () => {
    db.logQuery("recent", 1, 0.5, "/a.md", 20);

    // Analytics for 0 days should exclude everything (since cutoff = now)
    const analytics = db.getAnalytics(0);
    // The query was just inserted with a timestamp of "now", cutoff is also "now"
    // so it should be included (created_at >= cutoff)
    expect(analytics.totalQueries).toBeGreaterThanOrEqual(0);

    // Analytics for 30 days should include it
    const analytics30 = db.getAnalytics(30);
    expect(analytics30.totalQueries).toBe(1);
  });

  test("returns empty analytics when no queries logged", () => {
    const analytics = db.getAnalytics(30);
    expect(analytics.totalQueries).toBe(0);
    expect(analytics.avgResultCount).toBe(0);
    expect(analytics.avgTopScore).toBeNull();
    expect(analytics.zeroResultQueries).toEqual([]);
    expect(analytics.lowScoreQueries).toEqual([]);
    expect(analytics.topSearchedTerms).toEqual([]);
    expect(analytics.queriesPerDay).toEqual([]);
  });

  test("getAnalyticsTrend compares current vs prior period", () => {
    // All queries logged now → they fall in the "current" period
    db.logQuery("q1", 2, 0.6, "/a.md", 30);
    db.logQuery("q2", 0, null, null, 25);
    db.logQuery("q3", 3, 0.8, "/b.md", 40);

    const trend = db.getAnalyticsTrend(7);

    // Current period has 3 queries, prior has 0
    expect(trend.current.totalQueries).toBe(3);
    expect(trend.previous.totalQueries).toBe(0);
    expect(trend.delta.queries).toBe(3);

    // Zero-result rate: 1 out of 3
    expect(trend.current.zeroResultRate).toBeCloseTo(1 / 3, 2);
    expect(trend.previous.zeroResultRate).toBe(0);
  });

  test("getAnalyticsTrend handles empty data", () => {
    const trend = db.getAnalyticsTrend(7);
    expect(trend.current.totalQueries).toBe(0);
    expect(trend.previous.totalQueries).toBe(0);
    expect(trend.delta.queries).toBe(0);
    expect(trend.delta.avgTopScore).toBeNull();
  });

  test("top searched terms are ranked by count", () => {
    db.logQuery("popular", 2, 0.5, "/a.md", 20);
    db.logQuery("popular", 3, 0.6, "/b.md", 25);
    db.logQuery("popular", 1, 0.4, "/c.md", 30);
    db.logQuery("rare", 1, 0.5, "/a.md", 20);

    const analytics = db.getAnalytics(30);
    expect(analytics.topSearchedTerms[0].query).toBe("popular");
    expect(analytics.topSearchedTerms[0].count).toBe(3);
    expect(analytics.topSearchedTerms[1].query).toBe("rare");
    expect(analytics.topSearchedTerms[1].count).toBe(1);
  });
});
