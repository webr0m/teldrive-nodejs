import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { blake3 } from "@noble/hashes/blake3.js";
import {
  createRCDClient,
  createTeldriveRemote,
  startTeldriveRclone,
} from "@webr0m/rclone-teldrive";
import { createApp } from "../src/server.mjs";
import { config } from "../src/config.mjs";
import { TreeHash, BLOCK_SIZE } from "../src/tree-hash.mjs";
import { Rclone } from "../src/rclone.mjs";
import { createRcloneAgent } from "../src/rclone-agent.mjs";
import { setTimeout as delay } from "node:timers/promises";

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "teldrive-rclone-test-"));
  const cfg = config({
    CONFIG_FILE: "none",
    MEDIA_ENABLED: "false",
    DATA_KEY: randomBytes(32).toString("base64"),
    DATA_DIR: directory,
    STORAGE_BACKEND: "local",
    DEMO_AUTH: "true",
    PORT: "0",
    RATE_LIMIT_PER_MINUTE: "100000",
  });
  const app = createApp(cfg);
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  cfg.publicUrl = base;
  const login = await fetch(`${base}/api/dev/login`, { method: "POST" });
  const cookie = login.headers
    .getSetCookie()
    .map((s) => s.split(";")[0])
    .join("; ");
  const key = await (
    await fetch(`${base}/api/v1/api-keys`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Isolated rclone integration test" }),
    })
  ).json();
  const request = (url, method = "GET", body, headers = {}) =>
    fetch(`${base}/api/v1${url}`, {
      method,
      headers: {
        "X-Api-Key": key.secret,
        ...(body !== undefined && !Buffer.isBuffer(body)
          ? { "Content-Type": "application/json" }
          : {}),
        ...headers,
      },
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
    });
  return {
    directory,
    app,
    base,
    key,
    cookie,
    request,
    close: async () => {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("Teldrive tree hash is stable across stream boundaries, full blocks and empty files", () => {
  const bytes = Buffer.alloc(BLOCK_SIZE + 123, 97);
  const expected = Buffer.from(
    blake3(
      Buffer.concat([
        Buffer.from(blake3(bytes.subarray(0, BLOCK_SIZE))),
        Buffer.from(blake3(bytes.subarray(BLOCK_SIZE))),
      ]),
    ),
  ).toString("hex");
  for (const step of [37, 65536, bytes.length]) {
    const hash = new TreeHash();
    for (let at = 0; at < bytes.length; at += step) hash.update(bytes.subarray(at, at + step));
    assert.equal(hash.digest(), expected);
    assert.equal(hash.digest(), expected);
    assert.equal(hash.blocks.length, 2);
    assert.throws(() => hash.update(Buffer.from("x")));
  }
  assert.equal(new TreeHash().digest(), Buffer.from(blake3(new Uint8Array())).toString("hex"));
  assert.equal(new TreeHash().update(bytes.subarray(0, BLOCK_SIZE)).blocks.length, 1);
});

test("uploads accept MIME parameters, verify tree checksums and preserve pre-upgrade upload sessions", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (
        await f.request("/uploads", "POST", {
          name: "bad.txt",
          size: 1,
          mimeType: "text/plain\r\nX-Injected: true",
        })
      ).status,
      422,
    );
    const bytes = Buffer.alloc(1048576 + 123, 35),
      value = new TreeHash().update(bytes).digest();
    const session = await (
      await f.request("/uploads", "POST", {
        name: "texto.txt",
        size: bytes.length,
        mimeType: "text/plain; charset=utf-8",
        preferredPartSize: 1048576,
        hash: { algorithm: "blake3", value },
      })
    ).json();
    for (const [index, part] of [bytes.subarray(0, 1048576), bytes.subarray(1048576)].entries()) {
      const checksum = new TreeHash().update(part).digest();
      assert.equal(
        (
          await f.request(`/uploads/${session.id}/parts/${index + 1}`, "PUT", part, {
            "Content-Type": "application/octet-stream",
            "X-Part-Checksum": "f".repeat(64),
          })
        ).status,
        422,
      );
      const response = await f.request(`/uploads/${session.id}/parts/${index + 1}`, "PUT", part, {
        "Content-Type": "application/octet-stream",
        "X-Part-Checksum": checksum,
      });
      assert.equal(response.status, 201);
      assert.equal((await response.json()).checksum, checksum);
    }
    const complete = await f.request(`/uploads/${session.id}/complete`, "POST");
    assert.equal(complete.status, 201);
    assert.equal(
      (await complete.json()).hash.value,
      value,
      "unaligned part boundaries retain the same Teldrive file hash",
    );
    const oldBytes = Buffer.from("pre-upgrade payload"),
      raw = Buffer.from(blake3(oldBytes)).toString("hex");
    const old = f.app.context.uploads.create("1", {
      name: "old.bin",
      size: oldBytes.length,
      hash: { algorithm: "blake3", value: raw },
    });
    delete old.hashScheme;
    f.app.context.store.put("uploads", old);
    assert.equal(
      (
        await f.request(`/uploads/${old.id}/parts/1`, "PUT", oldBytes, {
          "Content-Type": "application/octet-stream",
          "X-Part-Checksum": raw,
        })
      ).status,
      201,
    );
    const original = await f.request(`/uploads/${old.id}/complete`, "POST");
    assert.equal(original.status, 201);
    assert.equal((await original.json()).hash.value, raw);
  } finally {
    await f.close();
  }
});

test("SDK refuses incompatible backends, existing remotes and unsafe configuration without exposing credentials", async () => {
  const calls = [];
  const client = (providers, remotes = []) =>
    createRCDClient({
      baseUrl: "http://127.0.0.1:5572",
      fetch: async (req) => {
        calls.push(req);
        const endpoint = new URL(req.url).pathname;
        const data =
          endpoint === "/config/providers"
            ? { providers }
            : endpoint === "/config/listremotes"
              ? { remotes }
              : { error: "secret-value-from-body" };
        return Response.json(data, { status: endpoint === "/config/create" ? 500 : 200 });
      },
    });
  const options = { apiHost: "https://cloud.webrom.lat", apiKey: "secret-value-from-body" };
  await assert.rejects(createTeldriveRemote(client([]), options), /lacks the Teldrive v2 backend/);
  const providers = [{ Name: "teldrive", Options: [{ Name: "api_key" }] }];
  await assert.rejects(
    createTeldriveRemote(client(providers, ["teldrive"]), options),
    /already exists/,
  );
  await assert.rejects(createTeldriveRemote(client(providers), options), /HTTP 500/);
  const req = calls.at(-1);
  assert.equal(new URL(req.url).search, "");
  assert.equal((await req.json()).parameters.api_key, options.apiKey);
  for (const apiHost of [
    "http://example.com",
    "https://user:pass@example.com",
    "https://cloud.webrom.lat/extra",
  ])
    await assert.rejects(
      createTeldriveRemote(client(providers), { ...options, apiHost }),
      /HTTPS origin/,
    );
  await assert.rejects(
    startTeldriveRclone({
      ...options,
      executable: "definitely-missing-teldrive-rclone-executable",
    }),
    /Cannot start rclone/,
  );
});

const platform = { win32: "windows", linux: "linux", darwin: "osx" }[process.platform],
  arch = { x64: "amd64", arm64: "arm64" }[process.arch];
const binary =
  process.env.TELDRIVE_TEST_RCLONE ||
  path.resolve(
    `var/tools/rclone/rclone-v1.75.4-${platform}-${arch}/${process.platform === "win32" ? "rclone.exe" : "rclone"}`,
  );
test("real tgdrive/rclone + rclone-sdk: multipart encrypted transfers, hashes, jobs, links and trash restoration", {
  skip: !existsSync(binary) && "Run npm run install:rclone first",
  timeout: 120000,
}, async () => {
  const f = await fixture();
  let drive;
  try {
    drive = await startTeldriveRclone({
      executable: binary,
      apiHost: f.base,
      apiKey: f.key.secret,
      encrypt: true,
    });
    assert.equal(
      existsSync(path.join(drive.connection().directory, "rclone.conf")),
      false,
      "managed credentials are never written as plaintext config",
    );
    await assert.rejects(
      createTeldriveRemote(drive.rcd, { apiHost: f.base, apiKey: f.key.secret }),
      /already exists/,
    );
    const source = path.join(f.directory, "fuente.txt"),
      target = path.join(f.directory, "descarga.txt"),
      bytes = randomBytes(BLOCK_SIZE + 123);
    await writeFile(source, bytes);
    await drive.mkdir("Documentos");
    const reads = [],
      read = f.app.context.storage.read.bind(f.app.context.storage);
    f.app.context.storage.read = (...args) => {
      reads.push(args);
      return read(...args);
    };
    const job = await drive.upload(source, "Documentos/niño.txt", { async: true });
    assert.ok(Number.isSafeInteger(job.jobid));
    const finished = await drive.waitJob(job.jobid);
    assert.equal(finished.success, true);
    assert.equal(reads.length, 0, "aligned upload completion never downloads its parts again");
    const { list } = await drive.list("Documentos", { hashes: true });
    assert.equal(list.length, 1);
    assert.equal(list[0].Name, "niño.txt");
    assert.equal(list[0].Hashes.teldrive, new TreeHash().update(bytes).digest());
    assert.equal((await drive.stat("Documentos/niño.txt")).item.Size, bytes.length);
    // Compare to the foreign Go implementation, not just to this server's hash.
    const foreignHash = await new Promise((resolve, reject) => {
      const child = spawn(binary, ["hashsum", "teldrive", source], { windowsHide: true });
      const chunks = [];
      child.stdout.on("data", (c) => chunks.push(c));
      child.stderr.resume();
      child.on("error", reject);
      child.on("close", (code) =>
        code
          ? reject(new Error(`rclone hashsum exited ${code}`))
          : resolve(Buffer.concat(chunks).toString().trim().split(/\s/)[0]),
      );
    });
    assert.equal(list[0].Hashes.teldrive, foreignHash);
    const file = f.app.context.store.get("files", list[0].ID);
    assert.equal(file.encryption, true);
    assert.equal(file.parts.length, 2);
    await drive.download("Documentos/niño.txt", target);
    assert.deepEqual(await readFile(target), bytes);
    const range = await f.request(`/files/${file.id}/content`, "GET", undefined, {
      Range: `bytes=${BLOCK_SIZE - 10}-${BLOCK_SIZE + 10}`,
    });
    assert.equal(range.status, 206);
    assert.deepEqual(
      Buffer.from(await range.arrayBuffer()),
      bytes.subarray(BLOCK_SIZE - 10, BLOCK_SIZE + 11),
    );
    const link = await drive.link("Documentos/niño.txt");
    assert.equal((await drive.link("Documentos/niño.txt")).url, link.url);
    assert.equal(f.app.context.store.list("shares").length, 1);
    await drive.copy("Documentos/niño.txt", "Documentos/copia.txt");
    await drive.move("Documentos/copia.txt", "Documentos/movido.txt");
    await drive.remove("Documentos/movido.txt");
    const trash = await drive.trash();
    assert.equal(trash.length, 1, "nested trash is never duplicated by rclone traversal");
    await drive.restore(trash[0].id);
    assert.equal((await drive.trash()).length, 0);
    await writeFile(path.join(f.directory, "empty.bin"), "");
    await drive.upload(path.join(f.directory, "empty.bin"), "vacio.bin");
    assert.equal((await drive.stat("vacio.bin")).item.Size, 0);
    assert.throws(() => drive.list("../outside"), /Invalid drive path/);
    await drive.dispose();
    assert.deepEqual((await drive.rcd.POST("/config/listremotes")).data.remotes, []);
    await drive.close();
    await drive.close();
    assert.ok((await stat(target)).size > 0);
  } finally {
    await drive?.close();
    await f.close();
  }
});

test("web rclone controller persists encrypted credentials and mount settings; local agent enforces origin and pairing", {
  skip: !existsSync(binary) && "Run npm run install:rclone first",
  timeout: 60000,
}, async (t) => {
  const f = await fixture();
  let agent, second;
  try {
    f.app.context.config.rcloneExecutable = binary;
    const action = async (method, params = {}) => {
      const response = await fetch(`${f.base}/api/v1/rclone/actions`, {
        method: "POST",
        headers: { Cookie: f.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ method, params }),
      });
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      return body;
    };
    assert.equal(
      (await f.request("/rclone/actions", "POST", { method: "rclone.info" })).status,
      403,
      "API keys cannot control server-side processes",
    );
    const options = { apiHost: f.base, apiKey: f.key.secret, encrypt: false };
    await action("rclone.configure", options);
    const persisted = f.app.context.rclone.state.get("config", "1");
    assert.ok(!JSON.stringify(persisted).includes(f.key.secret));
    const source = Buffer.from("rclone menu integration\n");
    const staged = await fetch(`${f.base}/api/v1/rclone/staging/prueba.txt`, {
      method: "PUT",
      headers: { Cookie: f.cookie, "Content-Type": "application/octet-stream" },
      body: source,
    });
    assert.equal(staged.status, 201);
    const { path: local } = await staged.json();
    const upload = await action("rclone.upload-local", {
      path: local,
      destination: "",
      name: "prueba.txt",
    });
    for (let i = 0; i < 100; i++) {
      const jobs = await action("rclone.jobs");
      if (jobs.find((j) => j.id === upload).status !== "running") break;
      await delay(25);
    }
    assert.equal((await action("rclone.jobs")).find((j) => j.id === upload).status, "completed");
    assert.equal((await action("rclone.browse", { path: "" }))[0].Name, "prueba.txt");
    assert.equal(
      (
        await action("rclone.mount-save", {
          autoStart: false,
          readOnly: true,
          cacheGiB: 3,
          cacheHours: 12,
          start: false,
        })
      ).cacheGiB,
      3,
    );
    assert.equal(
      (
        await f.request("/rclone/actions", "POST", {
          method: "rclone.browse",
          params: { path: "../escape" },
        })
      ).status,
      403,
    );
    await assert.rejects(f.app.context.rclone.localPath("1", "../escape"), {
      code: "rclone_local_path_denied",
    });
    // Another Passenger controller connects to the same protected daemon,
    // instead of spawning a duplicate or exposing its RC credentials.
    second = new Rclone(f.app.context.config);
    assert.equal((await second.request("1", "rclone.browse"))[0].Name, "prueba.txt");
    assert.equal(second.managed.size, 0);
    await second.close();
    second = undefined;
    const agentDir = path.join(f.directory, "agent");
    agent = await createRcloneAgent({
      directory: agentDir,
      publicUrl: f.base,
      executable: binary,
      port: 0,
    });
    const endpoint = `http://127.0.0.1:${agent.server.address().port}`;
    const query = (method, params = {}, origin = f.base, token = agent.accessToken) =>
      fetch(`${endpoint}/actions`, {
        method: "POST",
        headers: {
          Origin: origin,
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ method, params }),
      });
    assert.equal((await query("rclone.info", {}, "https://untrusted.test")).status, 403);
    assert.equal((await query("rclone.info", {}, f.base, "wrong-code")).status, 401);
    assert.equal((await query("rclone.configure", options)).status, 200);
    assert.equal((await (await query("rclone.browse")).json())[0].Name, "prueba.txt");
    const mountDrive =
      process.platform === "win32" &&
      ["X:", "W:", "U:", "T:", "S:"].find((letter) => !existsSync(`${letter}\\`));
    const canMount = Boolean(mountDrive && (await agent.service.driver()));
    t.diagnostic(
      canMount
        ? `WinFsp mount and restart exercised on unused drive ${mountDrive}`
        : "Physical mount skipped: WinFsp or an unused test drive is unavailable",
    );
    await agent.service.saveMount(
      "local",
      {
        drive: mountDrive || "X:",
        autoStart: canMount,
        readOnly: true,
        cacheGiB: 1,
        cacheHours: 1,
      },
      false,
    );
    if (canMount) {
      await agent.service.mount("local");
      assert.equal(
        (await agent.service.mountState("local")).running,
        true,
        "real WinFsp persistent-mount controller reports mounted",
      );
      assert.ok(
        (await (await import("node:fs/promises")).readdir(`${mountDrive}\\`)).includes(
          "prueba.txt",
        ),
      );
      await assert.rejects(
        agent.service.configure("local", options),
        { code: "rclone_busy" },
        "a live mount prevents credential replacement",
      );
    }
    const agentConfig = agent.service.config;
    await agent.close({ force: true });
    agent = undefined;
    const reopened = new Rclone(agentConfig, { local: true });
    assert.equal((await reopened.mountState("local")).cacheGiB, 1);
    assert.equal(!!reopened.configFor("local"), true);
    if (canMount) {
      await reopened.tick();
      assert.equal(
        (await reopened.mountState("local")).running,
        true,
        "persistent mount resumes after the controller and daemon restart",
      );
      await reopened.unmount("local", true);
      assert.equal((await reopened.mountState("local")).running, false);
    }
    await reopened.close({ force: true });
  } finally {
    await second?.close();
    await agent?.close({ force: true });
    await f.close();
  }
});
