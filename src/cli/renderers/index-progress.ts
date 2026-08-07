import type { ProjectIndexProgress } from
  "../../internals/storage/project-index.ts";
import type { EmbedSourceWindowsProgress } from
  "../../internals/storage/source-embeddings.ts";
import type { EmbedFactDocumentsProgress } from
  "../../internals/storage/fact-embeddings.ts";
import type { EmbedRelationDocumentsProgress } from
  "../../internals/storage/relation-embeddings.ts";

export interface IndexProgressStream {
  readonly isTTY?: boolean;
  readonly columns?: number;
  write(value: string): unknown;
}

export interface IndexProgressRendererOptions {
  minimumRenderIntervalMs?: number;
  now?: () => number;
}

type ProgressPhase =
  | "indexing"
  | "embedding"
  | "fact-embedding"
  | "relation-embedding";

function percentage(completed: number, total: number): number {
  if (total === 0) return 100;
  return Math.min(100, Math.floor((completed / total) * 100));
}

function progressBar(completed: number, total: number, width = 20): string {
  const ratio = total === 0 ? 1 : Math.min(1, completed / total);
  const filled = Math.round(ratio * width);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

function truncate(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  if (maximum <= 1) return "…";
  return `…${value.slice(-(maximum - 1))}`;
}

/** Render one indexing refresh without flooding redirected output. */
export class IndexProgressRenderer {
  private readonly minimumRenderIntervalMs: number;
  private readonly now: () => number;
  private lastRenderedAt = Number.NEGATIVE_INFINITY;
  private phase: ProgressPhase | null = null;
  private milestone = -1;
  private active = false;

  constructor(
    private readonly stream: IndexProgressStream,
    options: IndexProgressRendererOptions = {},
  ) {
    this.minimumRenderIntervalMs = options.minimumRenderIntervalMs ?? 50;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    this.phase = null;
    this.milestone = -1;
    this.lastRenderedAt = Number.NEGATIVE_INFINITY;
    this.active = true;
    this.write("Scanning source files…", true);
  }

  indexing(progress: ProjectIndexProgress): void {
    this.update(
      "indexing",
      "Indexing",
      progress.completed,
      progress.total,
      progress.path,
    );
  }

  embedding(progress: EmbedSourceWindowsProgress): void {
    this.update(
      "embedding",
      "Embedding",
      progress.completed,
      progress.total,
      null,
    );
  }

  factEmbedding(progress: EmbedFactDocumentsProgress): void {
    this.update(
      "fact-embedding",
      "Embedding facts",
      progress.completed,
      progress.total,
      null,
    );
  }

  relationEmbedding(progress: EmbedRelationDocumentsProgress): void {
    this.update(
      "relation-embedding",
      "Embedding relations",
      progress.completed,
      progress.total,
      null,
    );
  }

  finish(): void {
    if (!this.active) return;
    if (this.stream.isTTY) this.stream.write("\r\u001b[2K");
    this.active = false;
    this.phase = null;
  }

  private update(
    phase: ProgressPhase,
    label: string,
    completed: number,
    total: number,
    path: string | null,
  ): void {
    const percent = percentage(completed, total);
    const detail = path ??
      (phase.endsWith("embedding") && completed === 0 && total > 0
        ? "loading model / first batch…"
        : null);
    const phaseChanged = phase !== this.phase;
    if (phaseChanged) {
      this.phase = phase;
      this.milestone = -1;
    }

    if (this.stream.isTTY) {
      const now = this.now();
      if (
        !phaseChanged && completed !== total &&
        now - this.lastRenderedAt < this.minimumRenderIntervalMs
      ) {
        return;
      }
      const prefix = `${label} [${progressBar(completed, total)}] ` +
        `${completed}/${total} ${percent}%`;
      const available = Math.max(1, (this.stream.columns ?? 80) - prefix.length - 1);
      const suffix = detail ? ` ${truncate(detail, available)}` : "";
      this.write(`${prefix}${suffix}`, true);
      this.lastRenderedAt = now;
      return;
    }

    const milestone = Math.floor(percent / 10);
    if (!phaseChanged && completed !== total && milestone <= this.milestone) {
      return;
    }
    this.milestone = milestone;
    const suffix = detail ? ` ${detail}` : "";
    this.write(`${label}: ${completed}/${total} (${percent}%)${suffix}`, false);
  }

  private write(value: string, replace: boolean): void {
    if (this.stream.isTTY && replace) {
      this.stream.write(`\r\u001b[2K${value}`);
    } else {
      this.stream.write(`${value}\n`);
    }
  }
}
