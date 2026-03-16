import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

export async function createTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "rag-test-"));
}

export async function cleanupTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export async function writeFixture(
  dir: string,
  relativePath: string,
  content: string
): Promise<string> {
  const fullPath = join(dir, relativePath);
  const parentDir = fullPath.substring(0, fullPath.lastIndexOf("/"));
  await mkdir(parentDir, { recursive: true });
  await writeFile(fullPath, content);
  return fullPath;
}
