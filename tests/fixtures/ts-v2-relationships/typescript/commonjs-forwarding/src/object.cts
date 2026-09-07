// @ts-nocheck -- CommonJS relationship fixture under an ESM repository tsconfig.
function picked(): string {
  return "picked";
}

function other(): string {
  return "other";
}

function inline(): string {
  return "unrelated top-level function";
}

module.exports = {
  picked,
  alias: other,
  inline(): string {
    return "inline object method";
  },
};
