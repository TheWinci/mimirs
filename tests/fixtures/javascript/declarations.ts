import { cache } from "./runtime";
export { value as other } from "./other";

/** Persistent session storage. */
export namespace Sessions {
  export interface Entry<T> { value: T; expired: boolean; read(): T; }
  export type Key<T> = string | { id: T };
  export enum Mode { Read, Write = "write" }
  export const create = async <T>(value: T): Promise<Entry<T>> => ({ value, expired: false, read() { return value; } });
  export const first = () => 1, second = 2;
  export const { source, target: destination } = settings;
  export namespace Nested { export let enabled = true; }

  /** A cache container. */
  @sealed
  export abstract class Store<T> {
    /** Current cached value. */
    @cache
    public value = (input: T): T => input;
    #private = 1;
    abstract load(key: string): T;
    load(key: number): T;
    /** Remove expired entries. */
    @trace
    async remove(key: string): Promise<boolean> {
      const local = { method() { return 1; } };
      function nested() { return local; }
      return this.entries.delete(key);
    }
    get "size"() { return this.entries.size; }
    [Symbol.iterator]() { return this.entries.values(); }
    static { const initialization = true; }
  }
}

declare namespace Foreign.Inner {
  export function read(value: string): number;
}
export declare function overload(value: number): number;
export function* walk<T>(values: T[]) { yield* values; }
export default function () { return "anonymous"; }
