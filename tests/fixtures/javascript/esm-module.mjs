import { resolve } from "node:path";

export const root = resolve(".");

export function locate(name) {
  return resolve(root, name);
}

export default locate;
