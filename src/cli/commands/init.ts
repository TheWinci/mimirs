import { createInterface } from "node:readline/promises";

import {
  initializeProject,
  type ProjectInitialization,
} from "../../internals/project/initialize.ts";
import { ProjectDirectoryNotFoundError } from
  "../../internals/project/files.ts";
import { prepareCompiledRuntime } from
  "../../internals/runtime/compiled.ts";

export const INIT_USAGE =
  "Usage: mimirs init [-d <directory>]";

export interface ParsedInitArguments {
  directory: string;
}

export interface InitCommandOutput {
  error(message: string): void;
  log(message: string): void;
}

export interface InitCommandDependencies {
  initialize(directory: string): Promise<ProjectInitialization>;
  confirmIndex?(): Promise<boolean | null>;
  index?(
    directory: string,
    output: InitCommandOutput,
  ): Promise<number>;
}

class InitArgumentError extends Error {}

function value(args: string[], index: number, flag: string): string {
  const found = args[index + 1];
  if (found === undefined || found.startsWith("-") || found.trim() === "") {
    throw new InitArgumentError(`${flag} requires a non-empty path`);
  }
  return found;
}

export function parseInitArguments(args: string[]): ParsedInitArguments {
  let directory: string | undefined;

  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "-d" || argument === "--directory") {
      if (directory !== undefined) {
        throw new InitArgumentError("directory may only be provided once");
      }
      directory = value(args, index, argument);
      index++;
      continue;
    }
    throw new InitArgumentError(`unknown init option: ${argument}`);
  }

  return { directory: directory ?? "." };
}

async function confirmIndex(): Promise<boolean | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = (await prompt.question(
      "Index this project now? [Y/n] ",
    )).trim().toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    prompt.close();
  }
}

async function runInitialIndex(
  directory: string,
  output: InitCommandOutput,
): Promise<number> {
  await prepareCompiledRuntime();
  const { runIndex } = await import("./index.ts");
  return runIndex(["-d", directory], undefined, output);
}

const DEFAULT_DEPENDENCIES: InitCommandDependencies = {
  initialize: initializeProject,
  confirmIndex,
  index: runInitialIndex,
};

export async function runInit(
  args: string[],
  dependencies: InitCommandDependencies = DEFAULT_DEPENDENCIES,
  output: InitCommandOutput = console,
): Promise<number> {
  let parsed: ParsedInitArguments;
  try {
    parsed = parseInitArguments(args);
  } catch (error) {
    output.error(error instanceof Error ? error.message : String(error));
    output.error(INIT_USAGE);
    return 2;
  }

  try {
    const initialization = await dependencies.initialize(parsed.directory);
    output.log(
      initialization.created
        ? `Initialized Mimirs for ${initialization.root}`
        : `Mimirs is already initialized for ${initialization.root}`,
    );
    output.log(`Config: ${initialization.configPath}`);
    const shouldIndex = await (
      dependencies.confirmIndex ?? DEFAULT_DEPENDENCIES.confirmIndex!
    )();
    if (shouldIndex) {
      return (
        dependencies.index ?? DEFAULT_DEPENDENCIES.index!
      )(initialization.root, output);
    }
    output.log("Next: mimirs index");
    return 0;
  } catch (error) {
    output.error(error instanceof Error ? error.message : String(error));
    return error instanceof ProjectDirectoryNotFoundError ? 2 : 1;
  }
}
