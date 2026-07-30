import { IndexConfigError } from "../../internals/indexing/config.ts";
import { ProjectDirectoryNotFoundError } from
  "../../internals/project/analysis.ts";
import type { ProjectSearchResponse } from
  "../../internals/search/project-search.ts";
import { searchReadOnlyProject } from
  "../../internals/search/read-only-project-search.ts";
import {
  MAX_SEARCH_RESULTS,
  type SearchRequest,
} from "../../internals/search/search.ts";
import {
  renderSegmentedSearchResults,
  searchWarnings,
} from "../renderers/search-results.ts";

export const SEARCH_USAGE =
  "Usage: mimirs search -q <query> --max-results <n> [-d <directory>]";

export interface SearchCommandOutput {
  error(message: string): void;
  log(message: string): void;
}

export interface SearchCommandDependencies {
  search(
    directory: string,
    request: SearchRequest,
  ): Promise<ProjectSearchResponse>;
}

interface ParsedSearchArguments extends SearchRequest {
  directory: string;
}

class SearchArgumentError extends Error {}

const VALUE_FLAGS = new Set([
  "-q",
  "--query",
  "--max-results",
  "-d",
  "--directory",
]);

function parsePositiveInteger(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new SearchArgumentError("--max-results must be a positive integer");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new SearchArgumentError("--max-results must be a positive integer");
  }
  if (parsed > MAX_SEARCH_RESULTS) {
    throw new SearchArgumentError(
      `--max-results must not exceed ${MAX_SEARCH_RESULTS}`,
    );
  }
  return parsed;
}

function flagValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || VALUE_FLAGS.has(value)) {
    throw new SearchArgumentError(`${flag} requires a value`);
  }
  return value;
}

export function parseSearchArguments(args: string[]): ParsedSearchArguments {
  let query: string | undefined;
  let maximum: string | undefined;
  let directory: string | undefined;
  const positionals: string[] = [];
  let positionalOnly = false;

  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (positionalOnly) {
      positionals.push(argument);
      continue;
    }
    if (argument === "--") {
      positionalOnly = true;
      continue;
    }
    if (argument === "-q" || argument === "--query") {
      if (query !== undefined) {
        throw new SearchArgumentError("query flag may only be provided once");
      }
      query = flagValue(args, index, argument);
      index++;
      continue;
    }
    if (argument === "--max-results") {
      if (maximum !== undefined) {
        throw new SearchArgumentError(
          "--max-results may only be provided once",
        );
      }
      maximum = flagValue(args, index, argument);
      index++;
      continue;
    }
    if (argument === "-d" || argument === "--directory") {
      if (directory !== undefined) {
        throw new SearchArgumentError(
          "directory flag may only be provided once",
        );
      }
      directory = flagValue(args, index, argument);
      index++;
      continue;
    }
    if (argument.startsWith("-")) {
      throw new SearchArgumentError(`unknown search option: ${argument}`);
    }
    positionals.push(argument);
  }

  if (query === undefined) throw new SearchArgumentError("query is required");
  if (query.trim() === "") {
    throw new SearchArgumentError("query must not be empty");
  }
  if (maximum === undefined) {
    throw new SearchArgumentError("--max-results is required");
  }
  if (positionals.length > 1) {
    throw new SearchArgumentError("search accepts at most one directory");
  }
  if (directory !== undefined && positionals.length > 0) {
    throw new SearchArgumentError(
      "directory must be provided either positionally or with -d, not both",
    );
  }
  return {
    query,
    maxResults: parsePositiveInteger(maximum),
    directory: directory ?? positionals[0] ?? ".",
  };
}

const DEFAULT_DEPENDENCIES: SearchCommandDependencies = {
  search: (directory, request) =>
    searchReadOnlyProject(directory, request),
};

export async function runSearch(
  args: string[],
  dependencies: SearchCommandDependencies = DEFAULT_DEPENDENCIES,
  output: SearchCommandOutput = console,
): Promise<number> {
  let parsed: ParsedSearchArguments;
  try {
    parsed = parseSearchArguments(args);
  } catch (error) {
    output.error(error instanceof Error ? error.message : String(error));
    output.error(SEARCH_USAGE);
    return 2;
  }

  try {
    const response = await dependencies.search(
      parsed.directory,
      {
        query: parsed.query,
        maxResults: parsed.maxResults,
      },
    );
    for (const warning of searchWarnings(response)) {
      output.error(`[mimirs] ${warning}`);
    }
    output.log(renderSegmentedSearchResults(response));
    return 0;
  } catch (error) {
    output.error(error instanceof Error ? error.message : String(error));
    return error instanceof ProjectDirectoryNotFoundError ||
        error instanceof IndexConfigError
      ? 2
      : 1;
  }
}
