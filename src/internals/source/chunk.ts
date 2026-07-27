import { chunk, type SourceChunkResult } from "@winci/bun-chunk";

export class SourceFileNotFoundError extends Error {
  constructor(readonly filepath: string) {
    super(`no such file: ${filepath}`);
    this.name = "SourceFileNotFoundError";
  }
}

export async function chunkFile(filepath: string): Promise<SourceChunkResult> {
  const file = Bun.file(filepath);
  if (!(await file.exists())) {
    throw new SourceFileNotFoundError(filepath);
  }

  return chunk(filepath, await file.text());
}
