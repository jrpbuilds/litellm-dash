// Bun auto-loads .env into the test process too. Tests pass explicit config
// objects, but clear these anyway so nothing can pick up a developer's setup.
for (const key of Object.keys(Bun.env)) {
  if (key.startsWith("LITELLM_DASH_") || key === "HOST" || key === "PORT") delete Bun.env[key];
}
