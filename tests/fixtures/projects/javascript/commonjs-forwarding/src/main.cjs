const picked = require("./object.cjs").picked;
const proxy = require("./proxy.cjs");
const chained = require("./chained.cjs");

function start() {
  return [picked(), proxy.alias(), chained.run(), chained.execute(), proxy.inline()];
}

module.exports = start;
