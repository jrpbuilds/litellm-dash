import { authMode, configWarnings, loadConfig, publicBindWithoutAuth } from "./config";
import { createServer } from "./server";
import pkg from "../package.json";

const required = pkg.engines.bun;
if (!Bun.semver.satisfies(Bun.version, required)) {
  console.error(`litellm-dash needs Bun ${required}, found ${Bun.version}. Run \`bun upgrade\`.`);
  process.exit(1);
}

const cfg = loadConfig();
if (publicBindWithoutAuth(cfg)) {
  console.error(
    `refusing to listen on ${cfg.host} without authentication; set LITELLM_DASH_USER and LITELLM_DASH_PASSWORD, or LITELLM_DASH_TOKEN`,
  );
  process.exit(1);
}
for (const w of configWarnings(cfg)) console.warn(`warning: ${w}`);

const server = Bun.serve(await createServer(cfg));

console.log(`litellm-dash listening on ${server.url}`);
console.log(`db: ${cfg.dbPath} · auth: ${authMode(cfg)}`);
