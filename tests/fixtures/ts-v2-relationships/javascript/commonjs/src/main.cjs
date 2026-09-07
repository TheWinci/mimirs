const worker = require("./worker.cjs");
const { execute } = require("./named.cjs");

function start() {
  return [worker.run(), execute()];
}

module.exports = start;
