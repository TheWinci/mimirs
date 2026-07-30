/** Stable identity for vectors that can be compared in one embedding space. */
export interface EmbeddingIdentity {
  model: string;
  revision: string;
  variant: string;
  dimensions: number;
}

export interface EmbedProgress {
  completed: number;
  total: number;
}

export interface EmbedOptions {
  onProgress?: (progress: EmbedProgress) => void | Promise<void>;
}

/** Provider-neutral batch interface used by the persistence coordinator. */
export interface Embedder extends EmbeddingIdentity {
  embed(
    texts: readonly string[],
    options?: EmbedOptions,
  ): Promise<readonly Float32Array[]>;
}

export function sameEmbeddingIdentity(
  left: EmbeddingIdentity | null | undefined,
  right: EmbeddingIdentity,
): boolean {
  return left?.model === right.model &&
    left.revision === right.revision &&
    left.variant === right.variant &&
    left.dimensions === right.dimensions;
}
