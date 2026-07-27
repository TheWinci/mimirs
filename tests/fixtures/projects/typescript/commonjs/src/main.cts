// @ts-nocheck -- CommonJS relationship fixture under an ESM repository tsconfig.
import worker = require("./worker.cjs");
const { execute } = require("./named.cjs");

function start(): string[] {
  return [worker.run(), execute()];
}

export = start;
