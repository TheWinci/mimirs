import { add as sum } from "./math";
import * as math from "./math";
import configure from "./config.js";
import "./setup";

function localHelper(): string {
  return "local";
}

const service = {
  run(): string {
    return "service";
  },
};

export function start(): string[] {
  return [
    localHelper(),
    sum(1, 2),
    math.multiply(2, 3),
    configure(),
    service.run(),
  ];
}
