/** Stable identity for vectors that can be compared in one embedding space. */
export interface EmbeddingIdentity {
  model: string;
  revision: string;
  variant: string;
  dimensions: number;
}

/** Provider-neutral batch interface used by the persistence coordinator. */
export interface Embedder extends EmbeddingIdentity {
  embed(texts: readonly string[]): Promise<readonly Float32Array[]>;
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
