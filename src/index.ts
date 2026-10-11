import { authMode, configWarnings, loadConfig } from "./config";
import { createServer } from "./server";
import pkg from "../package.json";

const required = pkg.engines.bun;
if (!Bun.semver.satisfies(Bun.version, required)) {
  console.error(`litellm-dash needs Bun ${required}, found ${Bun.version}. Run \`bun upgrade\`.`);
  process.exit(1);
}

const cfg = loadConfig();
for (const w of configWarnings(cfg)) console.warn(`warning: ${w}`);

const server = Bun.serve(await createServer(cfg));

console.log(`litellm-dash listening on ${server.url}`);
console.log(`db: ${cfg.dbPath} · auth: ${authMode(cfg)}`);
