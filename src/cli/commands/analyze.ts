import {
  analyzeProject,
  ProjectDirectoryNotFoundError,
} from "../../internals/project/analysis.ts";
import { renderProjectAnalysis } from "../renderers/project-analysis.ts";

const USAGE = "Usage: mimirs analyze [-d] <directory>";

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function runAnalyze(args: string[]): Promise<number> {
  const directory = flagValue(args, "-d") ?? flagValue(args, "--directory") ??
    args.find((argument) => !argument.startsWith("-"));
  if (!directory) {
    console.error(USAGE);
    return 2;
  }

  try {
    console.log(renderProjectAnalysis(directory, await analyzeProject(directory)));
  } catch (error) {
    if (error instanceof ProjectDirectoryNotFoundError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }
  return 0;
}
