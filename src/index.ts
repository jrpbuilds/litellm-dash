import { authMode, configWarnings, loadConfig } from "./config";
import { createServer } from "./server";

const cfg = loadConfig();
for (const w of configWarnings(cfg)) console.warn(`warning: ${w}`);

const server = Bun.serve(await createServer(cfg));

console.log(`litellm-dash listening on ${server.url}`);
console.log(`db: ${cfg.dbPath} · auth: ${authMode(cfg)}`);
