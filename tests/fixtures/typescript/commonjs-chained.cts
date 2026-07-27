// @ts-nocheck -- CommonJS source-fact fixture under an ESM repository tsconfig.
const picked = require("./dep.cjs").picked;
const computed = require("./dep.cjs")["computed"];

exports.first = module.exports.second = picked;
module.exports.alias = require("./dep.cjs").picked;
exports["literal"] = computed;
module.exports["literalAlias"] = picked;
module["exports"]["computedModule"] = picked;

const dynamicName = "dynamic";
exports[dynamicName] = picked;
Object.defineProperty(exports, "defined", { value: picked });
const indirect = exports;
indirect.aliased = picked;
