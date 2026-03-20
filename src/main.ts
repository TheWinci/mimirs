#!/usr/bin/env bun

import { main } from "./cli";

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
