import { positionalArg } from "../flags";
import { resolve } from "path";
import { RagDB } from "../../db";
import { cli } from "../../utils/log";
import { runGit, findGitRoot } from "../../git/exec";

export async function sessionContextCommand(args: string[], getFlag: (flag: string) => string | undefined) {
  const dir = resolve(positionalArg(args[1], getFlag("--dir") || "."));
  const sections: string[] = [];

  // 1. Git context
  const gitRoot = await findGitRoot(dir);
  if (gitRoot) {
    const status = await runGit(["status", "--short"], gitRoot);
    if (status) {
      sections.push("## Uncommitted changes\n" + status);
    }

    const log = await runGit(["log", "--oneline", "-5"], gitRoot);
    if (log) {
      sections.push("## Recent commits\n" + log);
    }
  }

  // 2. Index status + search analytics
  let db: RagDB | null = null;
  try {
    db = new RagDB(dir);
    const dbStatus = db.getStatus();
    if (dbStatus.totalFiles > 0) {
      sections.push(
        `## Index\n${dbStatus.totalFiles} files, ${dbStatus.totalChunks} chunks (last indexed: ${dbStatus.lastIndexed || "unknown"})`
      );
    }

    const analytics = db.getAnalytics(7);
    if (analytics.totalQueries > 0) {
      const lines: string[] = [];
      if (analytics.zeroResultQueries.length > 0) {
        lines.push("Zero-result queries (last 7 days):");
        for (const q of analytics.zeroResultQueries.slice(0, 5)) {
          lines.push(`  ${q.count}× "${q.query}"`);
        }
      }
      if (analytics.lowScoreQueries.length > 0) {
        lines.push("Low-relevance queries:");
        for (const q of analytics.lowScoreQueries.slice(0, 5)) {
          lines.push(`  "${q.query}" (score: ${q.topScore.toFixed(2)})`);
        }
      }
      if (lines.length > 0) {
        sections.push("## Search gaps\n" + lines.join("\n"));
      }
    }

    // 3. Annotations on recently modified files
    if (gitRoot) {
      // -z: NUL-separated, unquoted — C-quoted paths never match annotations.
      const modifiedOutput = await runGit(["diff", "--name-only", "-z", "HEAD"], gitRoot);
      const untrackedOutput = await runGit(["ls-files", "--others", "--exclude-standard", "-z"], gitRoot);
      const modifiedFiles = new Set<string>();
      for (const output of [modifiedOutput, untrackedOutput]) {
        if (output) {
          for (const f of output.split("\0").filter(Boolean)) {
            modifiedFiles.add(f);
          }
        }
      }

      if (modifiedFiles.size > 0) {
        const noteLines: string[] = [];
        for (const relPath of modifiedFiles) {
          const annotations = db.getAnnotations(relPath);
          for (const a of annotations) {
            const target = a.symbolName ? `${a.path} • ${a.symbolName}` : a.path;
            noteLines.push(`  [NOTE] ${target}: ${a.note}`);
          }
        }
        if (noteLines.length > 0) {
          sections.push("## Annotations on modified files\n" + noteLines.join("\n"));
        }
      }
    }
  } catch {
    // No RAG index — skip DB sections
  } finally {
    db?.close();
  }

  if (sections.length > 0) {
    cli.log(sections.join("\n\n"));
  }
}
