// @ts-expect-error This fixture intentionally requests a missing cyclic export.
import { missing } from "./a";

export function start(): void {
  missing();
}
