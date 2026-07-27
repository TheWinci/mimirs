// @ts-nocheck -- CommonJS source-fact fixture under an ESM repository tsconfig.
const picked = require("./dep.cjs").picked;
const other = require("./dep.cjs").other;
const computed = require("./dep.cjs")["computed"];

module.exports = {
  picked,
  renamed: other,
  factory: require("./factory.cjs"),
  third: require("./dep.cjs").third,
  ["computedObject"]: computed,
  method() {
    return picked();
  },
};
