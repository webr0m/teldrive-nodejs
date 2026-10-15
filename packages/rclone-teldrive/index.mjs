import createRCDClient from "rclone-sdk";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export { default as createRCDClient } from "rclone-sdk";

function origin(value, label) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !["https:", "http:"].includes(url.protocol) ||
    (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  ) {
    throw new TypeError(`${label} must be an HTTPS origin (HTTP is allowed on loopback)`);
  }
  return url.origin;
}
function remotePath(value = "") {
  if (
    typeof value !== "string" ||
    /[\0\r\n\\]/.test(value) ||
    value.includes(":") ||
    value.split("/").some((p) => p === ".." || p === ".")
  )
    throw new TypeError("Invalid drive path");
  return value.replace(/^\/+|\/+$/g, "");
}
function filePath(value) {
  const result = remotePath(value);
  if (!result) throw new TypeError("A file path is required");
  return result;
}
function jobId(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Invalid rclone job ID");
  return value;
}
async function call(rcd, endpoint, body = {}, { async = false, signal } = {}) {
  // JSON bodies keep API keys out of URL query strings and access logs.
  const { data, error, response } = await rcd.POST(endpoint, {
    body: { ...body, ...(async ? { _async: true } : {}) },
    signal,
  });
  if (error || !response.ok) {
    // Do not propagate an RC error body: config/operations errors can echo
    // input parameters containing API keys or other remote credentials.
    const failure = new Error(`Rclone ${endpoint} failed (HTTP ${response.status})`);
    failure.status = response.status;
    failure.endpoint = endpoint;
    throw failure;
  }
  return data ?? {};
}

/** Add a Teldrive drive to an existing rclone-sdk client. Call on the server. */
export async function createTeldriveRemote(rcd, options) {
  const {
    name = "teldrive",
    apiKey,
    chunkMiB = 64,
    concurrency = 2,
    encrypt = false,
    hash = true,
    pageSize = 200,
  } = options;
  const apiHost = origin(options.apiHost, "apiHost");
  if (!/^[a-zA-Z][\w-]{0,63}$/.test(name)) throw new TypeError("Invalid remote name");
  if (typeof apiKey !== "string" || !apiKey.trim() || /[\s\0]/.test(apiKey))
    throw new TypeError("Invalid Teldrive API key");
  if (
    !Number.isInteger(chunkMiB) ||
    chunkMiB < 16 ||
    chunkMiB > 2000 ||
    chunkMiB % 16 ||
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 64 ||
    !Number.isInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 500 ||
    typeof encrypt !== "boolean" ||
    typeof hash !== "boolean"
  )
    throw new TypeError("Invalid transfer options");
  const { providers = [] } = await call(rcd, "/config/providers");
  const provider = providers.find((p) => p.Name === "teldrive");
  if (!provider?.Options?.some((o) => o.Name === "api_key")) {
    throw new Error(
      "This rclone lacks the Teldrive v2 backend. Use tgdrive/rclone v1.75.4 or a compatible build with api_key.",
    );
  }
  const { remotes = [] } = await call(rcd, "/config/listremotes");
  if (remotes.includes(name))
    throw new Error(`Remote "${name}" already exists; choose a different name to preserve it`);
  await call(rcd, "/config/create", {
    name,
    type: "teldrive",
    parameters: {
      api_host: apiHost,
      api_key: apiKey,
      chunk_size: `${chunkMiB}Mi`,
      upload_concurrency: String(concurrency),
      encrypt_files: String(encrypt),
      hash_enabled: String(hash),
      page_size: String(pageSize),
    },
    opt: { nonInteractive: true },
  });
  return bindTeldriveRemote(rcd, name);
}
/** Attach to a previously configured remote, preserving its credentials. */
export async function openTeldriveRemote(rcd, name = "teldrive") {
  if (!/^[a-zA-Z][\w-]{0,63}$/.test(name)) throw new TypeError("Invalid remote name");
  const { remotes = [] } = await call(rcd, "/config/listremotes");
  if (!remotes.includes(name)) throw new Error("Configured Teldrive remote is missing");
  return bindTeldriveRemote(rcd, name);
}
function bindTeldriveRemote(rcd, name) {
  const fs = `${name}:`;
  const invoke = (endpoint, body, opts) => call(rcd, endpoint, body, opts);
  const backend = (command, arg = []) => invoke("/backend/command", { fs, command, arg });
  let disposed = false;
  return {
    name,
    fs,
    rcd,
    list: (remote = "", { recursive = false, hashes = false, ...opts } = {}) =>
      invoke(
        "/operations/list",
        { fs, remote: remotePath(remote), opt: { recurse: recursive, showHash: hashes } },
        opts,
      ),
    stat: (remote, opts) => invoke("/operations/stat", { fs, remote: filePath(remote) }, opts),
    mkdir: (remote) => invoke("/operations/mkdir", { fs, remote: filePath(remote) }),
    upload: (local, remote, opts) => {
      const source = path.resolve(local);
      return invoke(
        "/operations/copyfile",
        {
          srcFs: path.dirname(source),
          srcRemote: path.basename(source),
          dstFs: fs,
          dstRemote: filePath(remote),
        },
        opts,
      );
    },
    download: (remote, local, opts) => {
      const target = path.resolve(local);
      return invoke(
        "/operations/copyfile",
        {
          srcFs: fs,
          srcRemote: filePath(remote),
          dstFs: path.dirname(target),
          dstRemote: path.basename(target),
        },
        opts,
      );
    },
    copy: (source, target, opts) =>
      invoke(
        "/operations/copyfile",
        { srcFs: fs, srcRemote: filePath(source), dstFs: fs, dstRemote: filePath(target) },
        opts,
      ),
    move: (source, target, opts) =>
      invoke(
        "/operations/movefile",
        { srcFs: fs, srcRemote: filePath(source), dstFs: fs, dstRemote: filePath(target) },
        opts,
      ),
    remove: (remote) => invoke("/operations/deletefile", { fs, remote: filePath(remote) }),
    link: (remote) => invoke("/operations/publiclink", { fs, remote: filePath(remote) }),
    trash: async () => {
      const { result } = await backend("trash-list");
      return result ?? [];
    },
    restore: (id) => backend("restore", [id]),
    jobStatus: (id) => invoke("/job/status", { jobid: jobId(id) }),
    stopJob: (id) => invoke("/job/stop", { jobid: jobId(id) }),
    async waitJob(id, { signal, timeoutMs = 3600000, pollMs = 250 } = {}) {
      jobId(id);
      if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || !Number.isFinite(pollMs) || pollMs < 10)
        throw new TypeError("Invalid job polling options");
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        signal?.throwIfAborted();
        const status = await invoke("/job/status", { jobid: id }, { signal });
        if (status.finished) {
          if (!status.success)
            throw new Error(`Rclone job ${id} failed; inspect its status on the server`);
          return status;
        }
        await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())), undefined, { signal });
      }
      throw new Error(`Timed out waiting for rclone job ${id}; the job may still be running`);
    },
    async dispose() {
      if (!disposed) {
        await invoke("/config/delete", { name });
        disposed = true;
      }
    },
  };
}

/** Start an isolated loopback-only rclone daemon and add this Teldrive drive. */
export async function startTeldriveRclone({
  executable = process.env.RCLONE_EXECUTABLE || "rclone",
  startupTimeoutMs = 20000,
  cacheDirectory,
  ...options
}) {
  if (
    typeof executable !== "string" ||
    !executable ||
    !Number.isFinite(startupTimeoutMs) ||
    startupTimeoutMs < 1
  )
    throw new TypeError("Invalid executable or startup timeout");
  const directory = await mkdtemp(path.join(tmpdir(), "teldrive-rclone-"));
  // The null device selects rclone's memory-only configuration. Credentials
  // stay out of plaintext files even while its RC daemon is running.
  const config = process.platform === "win32" ? "NUL" : "/dev/null";
  if (cacheDirectory) {
    if (!path.isAbsolute(cacheDirectory)) throw new TypeError("cacheDirectory must be absolute");
    await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
  }
  const username = randomBytes(16).toString("hex"),
    password = randomBytes(32).toString("base64url");
  // Isolate ambient flags/remotes and never put credentials in argv or URLs.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("RCLONE_")),
  );
  Object.assign(env, { RCLONE_RC_USER: username, RCLONE_RC_PASS: password });
  const child = spawn(
    executable,
    [
      "rcd",
      "--rc-addr",
      "127.0.0.1:0",
      "--config",
      config,
      "--log-level",
      "NOTICE",
      ...(cacheDirectory ? ["--cache-dir", cacheDirectory] : []),
    ],
    { env, windowsHide: true, detached: true, stdio: ["ignore", "ignore", "pipe"] },
  );
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "close").catch(() => {});
      child.kill();
      await Promise.race([exited, delay(3000, undefined, { ref: false })]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
  try {
    const baseUrl = await new Promise((resolve, reject) => {
      let tail = "";
      const timer = setTimeout(
        () => finish(new Error("Rclone startup timed out")),
        startupTimeoutMs,
      );
      const onError = () =>
        finish(new Error("Cannot start rclone; check the configured executable"));
      const onClose = () => finish(new Error("Rclone exited before its RC endpoint was ready"));
      const onData = (bytes) => {
        tail = (tail + bytes.toString()).slice(-4096);
        const match = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(tail);
        if (match) finish(undefined, `http://127.0.0.1:${match[1]}`);
      };
      function finish(error, value) {
        clearTimeout(timer);
        child.off("error", onError);
        child.off("close", onClose);
        child.stderr.off("data", onData);
        error ? reject(error) : resolve(value);
      }
      child.once("error", onError);
      child.once("close", onClose);
      child.stderr.on("data", onData);
    });
    // Drain logs without exposing remote configuration. Consumers can inspect
    // transfer status through the SDK instead of parsing executable output.
    child.stderr.resume();
    child.on("error", () => {});
    const rcd = createRCDClient({
      baseUrl,
      headers: {
        Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
      },
    });
    const remote = await createTeldriveRemote(rcd, options);
    return Object.assign(remote, {
      close,
      [Symbol.asyncDispose]: close,
      // Function-valued so serializing the public remote never reveals RC auth.
      connection: () => ({
        baseUrl,
        authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
        pid: child.pid,
        directory,
      }),
      detach() {
        child.unref();
        child.stderr.destroy();
      },
    });
  } catch (error) {
    await close();
    throw error;
  }
}
