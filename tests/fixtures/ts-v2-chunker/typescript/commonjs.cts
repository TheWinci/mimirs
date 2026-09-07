// @ts-nocheck -- CommonJS syntax fixture under an ESM repository tsconfig.
import path = require("node:path");

const fs = require("node:fs");

function load(name: string) {
  return fs.readFileSync(path.resolve(name), "utf8");
}

export = load;
