import { loadConfig } from "../src/config/env.js";
import { runDoctor } from "../src/diagnostics/doctor.js";

const config = loadConfig();
const result = runDoctor(config.root, { runtimeRoot: config.runtimeRoot });

console.log(JSON.stringify({
  status: result.status,
  counts: result.counts,
  issues: result.issues.slice(0, 50)
}, null, 2));

process.exit(result.status === "OK" ? 0 : 1);
