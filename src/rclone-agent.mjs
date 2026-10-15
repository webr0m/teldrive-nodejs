import http from "node:http";
import { readFile, writeFile, mkdir, unlink, stat } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { Rclone, defaultRclonePath } from "./rclone.mjs";
import { limitDefinitions } from "./settings.mjs";
import { number } from "./core.mjs";

export async function createRcloneAgent({
  directory,
  publicUrl,
  executable,
  port = 5573,
  token,
  startup = {},
  limits = {},
}) {
  const origin = new URL(publicUrl).origin;
  if (origin !== publicUrl || !["https:", "http:"].includes(new URL(origin).protocol))
    throw new Error("Use the Teldrive HTTP(S) origin");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const limitsFile = path.join(directory, "limits.json");
  let savedLimits = {};
  try {
    savedLimits = JSON.parse(await readFile(limitsFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const effectiveLimits = { ...savedLimits, ...limits };
  for (const [key, value] of Object.entries(effectiveLimits)) {
    const definition = limitDefinitions[key];
    if (!key.startsWith("rclone") || !definition) throw new Error("Invalid local rclone limit");
    number(value, definition.min, definition.max);
  }
  await writeFile(limitsFile, JSON.stringify(effectiveLimits), { mode: 0o600 });
  async function privateValue(filename) {
    const target = path.join(directory, filename);
    try {
      await writeFile(target, randomBytes(32).toString("base64url"), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    return (await readFile(target, "utf8")).trim();
  }
  const key = Buffer.from(await privateValue("master.key"), "base64url"),
    accessToken = token || (await privateValue("access.key"));
  const service = new Rclone(
    {
      dataDir: directory,
      key,
      publicUrl: origin,
      rcloneExecutable: executable || defaultRclonePath(path.resolve("var")),
      rcloneMountEnabled: true,
      ...effectiveLimits,
    },
    { local: true },
  );
  service.start();
  const startupFile =
    startup.file ||
    (process.platform === "win32" && process.env.APPDATA
      ? path.join(
          process.env.APPDATA,
          "Microsoft",
          "Windows",
          "Start Menu",
          "Programs",
          "Startup",
          "Teldrive-Node-Rclone-Agent.vbs",
        )
      : undefined);
  async function startupAction(install) {
    if (!startupFile || !startup.script)
      throw Object.assign(
        new Error(
          "El inicio automático de este componente está disponible en Windows. En Linux utiliza tu supervisor de servicios.",
        ),
        { status: 409 },
      );
    if (install) {
      const quote = (s) => `"${String(s).replaceAll('"', '""')}"`;
      const args = [
        process.execPath,
        startup.script,
        "--data-dir",
        directory,
        "--url",
        origin,
        "--port",
        String(port),
        "--executable",
        executable || service.executable(),
      ];
      const command = args.map((s) => `"${s.replaceAll('"', "")}"`).join(" ");
      const content = `' Teldrive Node rclone agent: managed startup, current user only\r\nSet shell = CreateObject("WScript.Shell")\r\nshell.Run ${quote(command)}, 0, False\r\n`;
      await writeFile(startupFile, content, { mode: 0o600 });
    } else {
      await unlink(startupFile).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    return { enabled: existsSync(startupFile) };
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const send = (value, status = 200) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(value));
    };
    try {
      if (req.headers.host !== `127.0.0.1:${server.address().port}`)
        return send({ error: { message: "Host no permitido" } }, 403);
      if (req.headers.origin && req.headers.origin !== origin)
        return send({ error: { message: "Origen no permitido" } }, 403);
      if (req.headers.origin === origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type");
        res.setHeader("Access-Control-Allow-Private-Network", "true");
      }
      if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.end();
        return;
      }
      const credential = Buffer.from((req.headers.authorization || "").replace(/^Bearer /, ""));
      if (
        credential.length !== Buffer.byteLength(accessToken) ||
        !timingSafeEqual(credential, Buffer.from(accessToken))
      )
        return send(
          { error: { message: "Vincula este equipo con su código de acceso local." } },
          401,
        );
      const url = new URL(req.url, "http://127.0.0.1");
      if (req.method === "PUT" && url.pathname.startsWith("/staging/")) {
        send(await service.stage("local", decodeURIComponent(url.pathname.slice(9)), req), 201);
        return;
      }
      if (req.method === "GET" && url.pathname === "/local-content") {
        const file = await service.localPath("local", url.searchParams.get("path")),
          info = await stat(file);
        if (!info.isFile())
          throw Object.assign(new Error("Selecciona un archivo."), { status: 422 });
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Length", info.size);
        await pipeline(createReadStream(file), res);
        return;
      }
      if (req.method !== "POST" || url.pathname !== "/actions") {
        send({}, 404);
        return;
      }
      let size = 0,
        chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1048576)
          throw Object.assign(new Error("Solicitud demasiado grande."), { status: 413 });
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (body.method === "rclone.startup") {
        send({ enabled: !!startupFile && existsSync(startupFile), supported: !!startupFile });
        return;
      }
      if (body.method === "rclone.startup-install" || body.method === "rclone.startup-remove") {
        send(await startupAction(body.method === "rclone.startup-install"));
        return;
      }
      send(await service.request("local", body.method, body.params));
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      send(
        {
          error: {
            message: error.status
              ? error.message
              : "El componente local no pudo completar la operación.",
            code: error.code,
          },
        },
        error.status || 500,
      );
    }
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
  } catch (error) {
    await service.close();
    throw error;
  }
  return {
    server,
    service,
    accessToken,
    async close(options) {
      await new Promise((resolve) => server.close(resolve));
      await service.close(options);
    },
  };
}
