import { parseArgs } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRcloneAgent } from "../src/rclone-agent.mjs";

const { values } = parseArgs({
  options: {
    url: { type: "string", default: process.env.TELDRIVE_URL || "https://cloud.webrom.lat" },
    "data-dir": {
      type: "string",
      default: process.env.RCLONE_AGENT_DATA_DIR || path.resolve("var/rclone-agent"),
    },
    port: { type: "string", default: process.env.RCLONE_AGENT_PORT || "5573" },
    executable: { type: "string", default: process.env.RCLONE_EXECUTABLE },
    "show-pair-code": { type: "boolean", default: false },
  },
});
const limits = {};
for (const [name, env] of Object.entries({
  rcloneMaxJobs: "RCLONE_MAX_JOBS",
  rcloneMaxCacheGiB: "RCLONE_MAX_CACHE_GIB",
  rcloneMaxCacheHours: "RCLONE_MAX_CACHE_HOURS",
  rcloneRequestSeconds: "RCLONE_REQUEST_SECONDS",
  rcloneWorkspaceBytes: "RCLONE_WORKSPACE_BYTES",
}))
  if (process.env[env] !== undefined) limits[name] = Number(process.env[env]);
const agent = await createRcloneAgent({
  directory: path.resolve(values["data-dir"]),
  publicUrl: values.url,
  executable: values.executable,
  port: Number(values.port),
  limits,
  startup: { script: fileURLToPath(import.meta.url) },
});
console.log(
  `Componente local de Teldrive listo en http://127.0.0.1:${agent.server.address().port}.`,
);
console.log(`Código de vinculación: ${path.join(values["data-dir"], "access.key")}`);
if (values["show-pair-code"]) console.log(agent.accessToken);
const close = () => {
  agent.close().then(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
};
process.once("SIGINT", close);
process.once("SIGTERM", close);
