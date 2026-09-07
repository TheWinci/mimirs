import { add as sum } from "./index.js";
import * as math from "./index.js";
import configure from "./config.js";
import "./setup.js";

function localHelper() {
  return "local";
}

const service = {
  run() {
    return "service";
  },
};

export function start() {
  return [
    localHelper(),
    sum(1, 2),
    math.multiply(2, 3),
    configure(),
    service.run(),
  ];
}
