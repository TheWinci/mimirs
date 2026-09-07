const real = require("./real.cjs");

function shadowRequire(require) {
  return require("./not-an-import.cjs");
}

function shadowModule(module) {
  module.exports.notAnExport = real;
}

function shadowExports(exports) {
  exports.notAnExport = real;
}

function lexicalRequire() {
  const require = makeLoader();
  return require("./not-an-import-either.cjs");
}

function lexicalModule() {
  const module = { exports: {} };
  module.exports.notAnExport = real;
}

function lexicalExports() {
  const exports = {};
  exports.notAnExport = real;
}

require = makeLoader();
const later = require("./also-not-an-import.cjs");

exports = {};
exports.notAnExport = real;

module = { exports: {} };
module.exports.notAnExport = real;
