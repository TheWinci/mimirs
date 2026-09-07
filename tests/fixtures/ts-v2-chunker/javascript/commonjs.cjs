const fs = require("node:fs");
const { join: joinPath, basename } = require("node:path");
require("./register.cjs");
const dynamic = require(moduleName);

function read(path) {
  return fs.readFileSync(path);
}

exports.read = read;
module.exports.join = joinPath;
module.exports.basename = basename;
