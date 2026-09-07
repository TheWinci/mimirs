// @ts-nocheck -- CommonJS syntax fixture under an ESM repository tsconfig.
import path = require("node:path");

interface ReportLocation {
  root: string;
  name: string;
}

function reportPath(location: ReportLocation): string {
  return path.join(location.root, `${location.name}.md`);
}

const reportFiles = {
  reportPath,
  extension: ".md",
};

export = reportFiles;
