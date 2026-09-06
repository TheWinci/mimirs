#!/usr/bin/env node
import fs from "node:fs";
/** Format a greeting. */
export const greet = function (name) { return `Hello ${name}`; };
export class View {
  #node = null;
  content = () => <div>hello</div>;
  @trace
  render() { return this.content(); }
  42() { return "answer"; }
}
export default () => <View />;
const [left, right] = pair;
var first = 1, second = 2;
(() => { function notGlobal() {} })();
const object = { method() {} };
