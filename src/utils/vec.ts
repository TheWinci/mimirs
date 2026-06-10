/**
 * Serialize a Float32Array embedding for sqlite-vec.
 *
 * `new Uint8Array(e.buffer)` wraps the ENTIRE underlying ArrayBuffer — correct
 * only when the Float32Array owns its buffer end-to-end. A `subarray`/view
 * (a natural batch-output optimization) would silently serialize the whole
 * flat batch buffer: dimension error at best, corrupt stored vectors at worst.
 * Every vec read/write must go through this helper.
 */
export function embeddingBytes(e: Float32Array): Uint8Array {
  return new Uint8Array(e.buffer, e.byteOffset, e.byteLength);
}
