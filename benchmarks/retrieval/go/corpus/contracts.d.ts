/** Configuration for retrying failed network requests with exponential backoff. */
export interface RetryPolicy {
  maximumAttempts: number;
  initialDelayMs: number;
  maximumDelayMs: number;
}
export declare function parse(value: string): RetryPolicy;
export declare function parse(value: Uint8Array): RetryPolicy;
export type RequestKey<T> = { key: string; value: T };
