export interface CompiledRuntime {
  grammars: Readonly<Record<string, string>>;
  onnxBinding: string;
  sqliteVec: string;
  treeSitter: string;
}

declare global {
  // Set only by the standalone-binary entrypoint generated at build time.
  var __MIMIRS_COMPILED_RUNTIME__: CompiledRuntime | undefined;
}

export function getCompiledRuntime(): CompiledRuntime | undefined {
  return globalThis.__MIMIRS_COMPILED_RUNTIME__;
}

/** Materialize native and WASM assets when running a compiled executable. */
export async function prepareCompiledRuntime(): Promise<void> {
  // The binary build replaces this module with a platform-specific implementation.
}
