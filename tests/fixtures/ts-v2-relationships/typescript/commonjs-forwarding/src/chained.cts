// @ts-nocheck -- CommonJS relationship fixture under an ESM repository tsconfig.
function run(): string {
  return "run";
}

exports.run = module.exports.execute = run;
