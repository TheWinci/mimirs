import {
  initializeProject,
  type ProjectInitialization,
} from "../../internals/project/initialize.ts";
import { ProjectDirectoryNotFoundError } from
  "../../internals/project/files.ts";
import { ProjectStateLocationError } from
  "../../internals/project/layout.ts";

export const INIT_USAGE =
  "Usage: mimirs init [-d <directory>] [--state-dir <directory>]";

export interface ParsedInitArguments {
  directory: string;
  stateDirectory?: string;
}

export interface InitCommandOutput {
  error(message: string): void;
  log(message: string): void;
}

export interface InitCommandDependencies {
  initialize(
    directory: string,
    stateDirectory?: string,
  ): Promise<ProjectInitialization>;
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
  let stateDirectory: string | undefined;

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
    if (argument === "--state-dir") {
      if (stateDirectory !== undefined) {
        throw new InitArgumentError(
          "state directory may only be provided once",
        );
      }
      stateDirectory = value(args, index, argument);
      index++;
      continue;
    }
    throw new InitArgumentError(`unknown init option: ${argument}`);
  }

  return {
    directory: directory ?? ".",
    ...(stateDirectory === undefined ? {} : { stateDirectory }),
  };
}

const DEFAULT_DEPENDENCIES: InitCommandDependencies = {
  initialize: initializeProject,
};

function nextCommand(initialization: ProjectInitialization): string {
  const stateOption = initialization.externalState
    ? ` --state-dir ${JSON.stringify(initialization.stateHost)}`
    : "";
  return `mimirs index source enable -d ${
    JSON.stringify(initialization.root)
  }${stateOption}`;
}

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
    const initialization = await dependencies.initialize(
      parsed.directory,
      parsed.stateDirectory,
    );
    output.log(
      initialization.created
        ? `Initialized Mimirs for ${initialization.root}`
        : `Mimirs is already initialized for ${initialization.root}`,
    );
    output.log(`Config: ${initialization.configPath}`);
    output.log(`Next: ${nextCommand(initialization)}`);
    return 0;
  } catch (error) {
    output.error(error instanceof Error ? error.message : String(error));
    return error instanceof ProjectDirectoryNotFoundError ||
        error instanceof ProjectStateLocationError
      ? 2
      : 1;
  }
}
