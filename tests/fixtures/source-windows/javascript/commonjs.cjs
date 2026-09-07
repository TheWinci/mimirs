const { readFileSync } = require("node:fs");

/** Load one report through CommonJS. */
function loadReport(path) {
  const contents = readFileSync(path, "utf8");
  return contents.trim();
}

module.exports = {
  loadReport,
  defaultPath: "./report.md",
};
