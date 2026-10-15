import { access, mkdir, readdir, realpath, stat, rm, unlink } from "node:fs/promises";
import { existsSync, constants, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
  createRCDClient,
  startTeldriveRclone,
  openTeldriveRemote,
} from "../packages/rclone-teldrive/index.mjs";
import { Store, CryptoBox, Locks, id, hash, now, fail, number } from "./core.mjs";

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};
const drivePath = (value = "") => {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    /[\0\r\n\\:]/.test(value) ||
    value.split("/").some((s) => ["..", "."].includes(s))
  )
    fail(422, "invalid_rclone_path");
  return value.replace(/^\/+|\/+$/g, "");
};
export function defaultRclonePath(dataDir) {
  const platform = { win32: "windows", linux: "linux", darwin: "osx" }[process.platform],
    arch = { x64: "amd64", arm64: "arm64" }[process.arch];
  return path.join(
    dataDir,
    "tools",
    "rclone",
    `rclone-v1.75.4-${platform}-${arch}`,
    process.platform === "win32" ? "rclone.exe" : "rclone",
  );
}
export class Rclone {
  constructor(config, { allowed = () => true, local = false } = {}) {
    this.config = config;
    this.local = local;
    this.allowed = allowed;
    this.directory = path.join(config.dataDir, "rclone");
    this.state = new Store(this.directory);
    this.box = new CryptoBox(config.key);
    this.locks = new Locks();
    this.managed = new Map();
  }
  executable() {
    return (
      this.config.rcloneExecutable ||
      defaultRclonePath(fileURLToPath(new URL("../var/", import.meta.url)))
    );
  }
  configFor(user) {
    const record = this.state.get("config", user);
    return record && this.box.decode(record.secret, `rclone:${user}`);
  }
  async driver() {
    if (process.platform === "win32")
      return existsSync(
        path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "WinFsp"),
      );
    if (process.platform === "darwin") return existsSync("/Library/Filesystems/macfuse.fs");
    try {
      await access("/dev/fuse", constants.R_OK | constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }
  async info(user) {
    const configured = !!this.state.get("config", user),
      driverInstalled = await this.driver();
    return {
      configured,
      available: existsSync(this.executable()),
      encrypted: true,
      locked: false,
      driverInstalled,
      version: "tgdrive/rclone v1.75.4",
      platform: process.platform,
      location: this.local ? "computer" : "server",
      persistentMounts: true,
      mountPoint: this.mountPoint(user),
      localRoot: await this.workspace(user),
      mountSupported: driverInstalled && this.config.rcloneMountEnabled !== false,
      maxCacheGiB: this.config.rcloneMaxCacheGiB ?? 100,
      maxCacheHours: this.config.rcloneMaxCacheHours ?? 720,
    };
  }
  async configure(user, options) {
    let apiHost;
    try {
      const url = new URL(options.apiHost || this.config.publicUrl);
      if (url.username || url.password || url.pathname !== "/" || url.search || url.hash)
        fail(422, "invalid_rclone_host");
      apiHost = url.origin;
    } catch (error) {
      if (error.status) throw error;
      fail(422, "invalid_rclone_host");
    }
    if (apiHost !== this.config.publicUrl)
      fail(
        422,
        "rclone_host_not_allowed",
        "Usa el servidor de Teldrive configurado para este equipo.",
      );
    if (typeof options.apiKey !== "string" || !/^[A-Za-z0-9_-]{20,256}$/.test(options.apiKey))
      fail(422, "invalid_api_key");
    number(options.chunkMiB ?? 64, 16, 2000);
    number(options.concurrency ?? 2, 1, 64);
    if (
      (options.chunkMiB ?? 64) % 16 ||
      (options.encrypt !== undefined && typeof options.encrypt !== "boolean") ||
      (options.hash !== undefined && typeof options.hash !== "boolean")
    )
      fail(422, "invalid_rclone_options");
    const response = await fetch(`${apiHost}/api/v1/me`, {
      headers: { "X-Api-Key": options.apiKey },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) fail(422, "rclone_key_rejected", "Teldrive rechazó la clave de API.");
    const profile = await response.json();
    if (!this.local && String(profile.id ?? profile.userId) !== String(user))
      fail(403, "rclone_key_owner_mismatch");
    if (
      (await this.jobs(user)).some((j) => j.status === "running") ||
      (await this.mountState(user)).running
    )
      fail(
        409,
        "rclone_busy",
        "Detén las transferencias y desmonta la unidad antes de cambiar la conexión.",
      );
    await this.stopRuntime(user);
    const value = {
      name: "teldrive",
      apiHost,
      apiKey: options.apiKey,
      chunkMiB: options.chunkMiB ?? 64,
      concurrency: options.concurrency ?? 2,
      encrypt: options.encrypt ?? false,
      hash: options.hash ?? true,
    };
    const remote = await startTeldriveRclone({
      ...value,
      executable: this.executable(),
      cacheDirectory: this.cacheDirectory(user),
    });
    this.state.put("config", {
      id: String(user),
      secret: this.box.encode(value, `rclone:${user}`),
    });
    this.saveRuntime(user, remote);
    return this.info(user);
  }
  saveRuntime(user, remote) {
    this.state.put("runtime", {
      id: String(user),
      generation: id(),
      secret: this.box.encode(remote.connection(), `rclone-runtime:${user}`),
    });
    this.managed.set(String(user), remote);
  }
  cacheDirectory(user) {
    return path.join(this.directory, "cache", hash(String(user)).slice(0, 24));
  }
  runtime(user) {
    const record = this.state.get("runtime", user);
    return (
      record && { ...record, connection: this.box.decode(record.secret, `rclone-runtime:${user}`) }
    );
  }
  client(connection) {
    return createRCDClient({
      baseUrl: connection.baseUrl,
      headers: { Authorization: connection.authorization },
      fetch: (request) =>
        fetch(request, {
          signal: AbortSignal.any([
            request.signal,
            AbortSignal.timeout((this.config.rcloneRequestSeconds ?? 120) * 1000),
          ]),
        }),
    });
  }
  async remote(user) {
    return this.locks.run(`remote:${user}`, async () => {
      const runtime = this.runtime(user);
      if (runtime?.connection?.pid && alive(runtime.connection.pid)) {
        try {
          return await openTeldriveRemote(this.client(runtime.connection));
        } catch {
          fail(
            503,
            "rclone_runtime_unavailable",
            "El proceso de rclone no responde. Reinicia su conexión.",
          );
        }
      }
      const options = this.configFor(user);
      if (!options) fail(409, "rclone_not_configured", "Guarda primero la conexión de rclone.");
      const claim = this.state.transaction(() => {
        const current = this.state.get("starting", user);
        if (current && current.until > Date.now() && alive(current.pid)) return false;
        this.state.put("starting", {
          id: String(user),
          pid: process.pid,
          until: Date.now() + 30000,
        });
        return true;
      });
      if (!claim)
        fail(503, "rclone_starting", "La conexión se está iniciando. Vuelve a intentarlo.");
      try {
        const remote = await startTeldriveRclone({
          ...options,
          executable: this.executable(),
          cacheDirectory: this.cacheDirectory(user),
        });
        this.saveRuntime(user, remote);
        return remote;
      } finally {
        this.state.delete("starting", user);
      }
    });
  }
  async rc(user, endpoint, body = {}) {
    const remote = await this.remote(user),
      { data, error, response } = await remote.rcd.POST(endpoint, { body });
    if (error || !response.ok)
      fail(
        502,
        "rclone_operation_failed",
        `Rclone no pudo completar ${endpoint}. Revisa el estado de la conexión y el controlador de montaje.`,
      );
    return data ?? {};
  }
  async stopRuntime(user) {
    const own = this.managed.get(String(user)),
      runtime = this.runtime(user);
    if (own) {
      await own.close();
      this.managed.delete(String(user));
    } else if (runtime && alive(runtime.connection.pid)) {
      const { response } = await this.client(runtime.connection).POST("/core/quit", { body: {} });
      if (!response.ok) fail(503, "rclone_stop_failed");
      // This private path was generated by the owned SDK, never by a request.
      if (
        path.dirname(runtime.connection.directory) === os.tmpdir() &&
        path.basename(runtime.connection.directory).startsWith("teldrive-rclone-")
      )
        await rm(runtime.connection.directory, { recursive: true, force: true }).catch(() => {});
    }
    this.state.delete("runtime", user);
  }
  async workspace(user) {
    const root = path.join(this.directory, "files", hash(String(user)).slice(0, 24));
    await mkdir(root, { recursive: true, mode: 0o700 });
    return root;
  }
  async localPath(user, input = "", destination = false) {
    if (typeof input !== "string" || input.includes("\0")) fail(422, "invalid_rclone_path");
    const root = await this.workspace(user),
      target = path.resolve(root, input);
    if (target !== root && !target.startsWith(root + path.sep))
      fail(403, "rclone_local_path_denied");
    let checked = target;
    if (destination) {
      checked = path.dirname(target);
      let ancestor = checked;
      for (;;) {
        try {
          const physical = await realpath(ancestor);
          if (
            physical !== (await realpath(root)) &&
            !physical.startsWith((await realpath(root)) + path.sep)
          )
            fail(403, "rclone_local_symlink_denied");
          break;
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
          ancestor = path.dirname(ancestor);
        }
      }
      await mkdir(checked, { recursive: true, mode: 0o700 });
    }
    const resolved = await realpath(checked),
      physicalRoot = await realpath(root);
    if (resolved !== physicalRoot && !resolved.startsWith(physicalRoot + path.sep))
      fail(403, "rclone_local_symlink_denied");
    if (destination) {
      try {
        if (
          (await realpath(target)) !== target &&
          !(await realpath(target)).startsWith(physicalRoot + path.sep)
        )
          fail(403, "rclone_local_symlink_denied");
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    }
    return target;
  }
  async workspaceSize(user) {
    const walk = async (folder) => {
      let size = 0;
      for (const item of await readdir(folder, { withFileTypes: true })) {
        if (item.isSymbolicLink()) continue;
        const file = path.join(folder, item.name);
        if (item.isDirectory()) size += await walk(file);
        else if (item.isFile()) size += (await stat(file)).size;
      }
      return size;
    };
    return walk(await this.workspace(user));
  }
  async stage(user, filename, request) {
    if (
      typeof filename !== "string" ||
      !filename ||
      filename.length > 255 ||
      /[\x00-\x1f/\\:]/.test(filename) ||
      [".", ".."].includes(filename)
    )
      fail(422, "invalid_name");
    return this.locks.run(`workspace:${user}`, async () => {
      const expected = Number(request.headers["content-length"]),
        limit = this.config.rcloneWorkspaceBytes ?? 1073741824;
      if (
        !Number.isSafeInteger(expected) ||
        expected < 0 ||
        expected + (await this.workspaceSize(user)) > limit
      )
        fail(413, "rclone_workspace_full", "No hay espacio temporal suficiente para ese archivo.");
      const relative = `${id()}-${filename}`,
        target = await this.localPath(user, relative, true);
      let length = 0;
      try {
        await pipeline(
          request,
          new Transform({
            transform(chunk, encoding, done) {
              length += chunk.length;
              done(length > expected ? new Error("Body exceeds Content-Length") : null, chunk);
            },
          }),
          createWriteStream(target, { flags: "wx", mode: 0o600 }),
        );
        if (length !== expected) fail(422, "truncated_file");
        return { path: relative };
      } catch (error) {
        await unlink(target).catch(() => {});
        throw error;
      }
    });
  }
  async localBrowse(user, input = "") {
    const root = await this.workspace(user),
      folder = await this.localPath(user, input);
    const items = [];
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || !(entry.isDirectory() || entry.isFile())) continue;
      const full = path.join(folder, entry.name),
        info = await stat(full);
      items.push({
        name: entry.name,
        path: path.relative(root, full).replaceAll("\\", "/"),
        directory: entry.isDirectory(),
        size: info.size,
        modified: info.mtime.toISOString(),
      });
    }
    return {
      path: path.relative(root, folder).replaceAll("\\", "/"),
      name: path.relative(root, folder) || root,
      items,
    };
  }
  async transfer(user, operation, source, target) {
    return this.locks.run(`transfer:${user}`, () =>
      this.startTransfer(user, operation, source, target),
    );
  }
  async startTransfer(user, operation, source, target) {
    number(this.config.rcloneMaxJobs ?? 2, 1, 64);
    if (
      (await this.jobs(user)).filter((j) => ["running", "waiting"].includes(j.status)).length >=
      (this.config.rcloneMaxJobs ?? 2)
    )
      fail(429, "rclone_transfer_limit");
    const remote = await this.remote(user);
    let result;
    if (operation === "upload")
      result = await remote.upload(await this.localPath(user, source), drivePath(target), {
        async: true,
      });
    else {
      const { item } = await remote.stat(drivePath(source));
      if (!item || item.IsDir)
        fail(422, "rclone_select_file", "Selecciona un archivo para descargar.");
      const reserved = this.state
        .list("jobs", String(user))
        .filter((j) => j.status === "running" && j.operation === "download")
        .reduce((n, j) => n + (j.expectedSize || 0), 0);
      if (
        item.Size + reserved + (await this.workspaceSize(user)) >
        (this.config.rcloneWorkspaceBytes ?? 1073741824)
      )
        fail(413, "rclone_workspace_full");
      result = await remote.download(drivePath(source), await this.localPath(user, target, true), {
        async: true,
      });
      result.expectedSize = item.Size;
    }
    const job = {
      id: id(),
      ownerId: String(user),
      operation,
      source,
      target,
      expectedSize: result.expectedSize,
      label: `${operation === "upload" ? "Subir" : "Descargar"}: ${operation === "upload" ? target : source}`,
      mount: false,
      status: "running",
      log: "",
      rcJob: result.jobid,
      runtimeId: this.runtime(user).generation,
      createdAt: now(),
    };
    this.state.put("jobs", job);
    return job.id;
  }
  async jobs(user) {
    const jobs = this.state.list("jobs", String(user));
    for (const job of jobs.filter((j) => j.status === "running")) {
      const runtime = this.runtime(user);
      if (!runtime || runtime.generation !== job.runtimeId || !alive(runtime.connection.pid)) {
        job.status = "interrupted";
        job.log = "El proceso se reinició. Puedes reintentar la transferencia.";
      } else {
        try {
          const { data, response } = await this.client(runtime.connection).POST("/job/status", {
            body: { jobid: job.rcJob },
          });
          if (!response.ok) {
            job.status = "interrupted";
            job.log = "El trabajo ya no está disponible en este proceso.";
          } else if (data.finished) {
            job.status = data.success ? "completed" : "failed";
            job.log = data.success
              ? "Transferencia completada."
              : "La transferencia falló. Comprueba la conexión y el archivo.";
          } else job.log = "Transferencia en curso.";
        } catch {
          job.log = "Esperando respuesta del proceso de rclone.";
        }
      }
      this.state.put("jobs", job);
    }
    return jobs
      .map(({ ownerId, rcJob, runtimeId, ...value }) => value)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 100);
  }
  mountPoint(user, drive) {
    if (this.local && process.platform === "win32") {
      const point = drive || this.state.get("mount", user)?.drive || "T:";
      if (!/^[D-Z]:$/i.test(point)) fail(422, "invalid_mount_drive");
      return point.toUpperCase();
    }
    return path.join(
      this.config.rcloneMountRoot || path.join(this.directory, "mounts"),
      hash(String(user)).slice(0, 24),
    );
  }
  async mountState(user) {
    const saved = this.state.get("mount", user) || {
      autoStart: false,
      cacheGiB: 10,
      cacheHours: 24,
      readOnly: false,
    };
    let running = false;
    const runtime = this.runtime(user);
    if (runtime && alive(runtime.connection.pid)) {
      try {
        const { data } = await this.client(runtime.connection).POST("/mount/listmounts");
        running = !!data?.mountPoints?.some(
          (m) => m.MountPoint === (saved.mountPoint || this.mountPoint(user)),
        );
      } catch {
        /* Report disconnected below. */
      }
    }
    return {
      ...saved,
      id: undefined,
      mountPoint: saved.mountPoint || this.mountPoint(user),
      running,
      driverInstalled: await this.driver(),
      location: this.local ? "computer" : "server",
    };
  }
  async saveMount(user, params, start = true) {
    const cacheGiB = number(params.cacheGiB ?? 10, 1, this.config.rcloneMaxCacheGiB ?? 100),
      cacheHours = number(params.cacheHours ?? 24, 1, this.config.rcloneMaxCacheHours ?? 720);
    if (typeof params.autoStart !== "boolean" || typeof params.readOnly !== "boolean")
      fail(422, "invalid_mount_options");
    const previous = await this.mountState(user);
    if (previous.running)
      fail(409, "unmount_before_editing", "Desmonta la unidad antes de cambiar su configuración.");
    const saved = {
      id: String(user),
      drive: params.drive,
      mountPoint: this.mountPoint(user, params.drive),
      autoStart: params.autoStart,
      readOnly: params.readOnly,
      cacheGiB,
      cacheHours,
    };
    this.state.put("mount", saved);
    if (start) await this.mount(user);
    return this.mountState(user);
  }
  async mount(user) {
    if (!(await this.driver()) || this.config.rcloneMountEnabled === false)
      fail(
        409,
        "mount_driver_unavailable",
        "La configuración quedó guardada. Este equipo necesita WinFsp o acceso a /dev/fuse para montar la unidad.",
      );
    const saved = this.state.get("mount", user);
    if (!saved) fail(409, "save_mount_first");
    if ((await this.mountState(user)).running) return;
    if (process.platform !== "win32" || !this.local) {
      await mkdir(saved.mountPoint, { recursive: true, mode: 0o700 });
      if ((await readdir(saved.mountPoint)).length) fail(409, "mount_point_not_empty");
    } else if (existsSync(saved.mountPoint + "\\"))
      fail(409, "mount_drive_in_use", "Esa letra ya está en uso. Elige otra.");
    const remote = await this.remote(user);
    await this.rc(user, "/mount/mount", {
      fs: remote.fs,
      mountPoint: saved.mountPoint,
      vfsOpt: {
        CacheMode: "full",
        CacheMaxSize: `${saved.cacheGiB}Gi`,
        CacheMaxAge: `${saved.cacheHours}h`,
        ReadOnly: saved.readOnly,
      },
      mountOpt: { Daemon: false },
    });
  }
  async unmount(user, disable = false) {
    const saved = this.state.get("mount", user);
    if (!saved) return;
    if ((await this.mountState(user)).running) {
      const { diskCache } = await this.rc(user, "/vfs/stats", { fs: "teldrive:" });
      if (diskCache?.uploadsQueued || diskCache?.uploadsInProgress)
        fail(
          409,
          "mount_uploads_pending",
          "Espera a que terminen las subidas de la unidad antes de desmontarla.",
        );
      await this.rc(user, "/mount/unmount", { mountPoint: saved.mountPoint });
    }
    if (disable) {
      saved.autoStart = false;
      this.state.put("mount", saved);
    }
    return this.mountState(user);
  }
  start() {
    this.poll = setInterval(() => {
      void this.tick().catch(() => {});
    }, 10000).unref();
    this.initial = setTimeout(() => {
      void this.tick().catch(() => {});
    }, 1000).unref();
  }
  async tick() {
    if (this.ticking || this.closed) return;
    this.ticking = true;
    try {
      for (const saved of this.state.list("mount").filter((m) => m.autoStart)) {
        if (this.closed) break;
        if (this.allowed(saved.id)) await this.mount(saved.id).catch(() => {});
        else await this.unmount(saved.id, true).catch(() => {});
      }
    } finally {
      this.ticking = false;
    }
  }
  async request(user, method, params = {}) {
    if (!this.allowed(String(user))) fail(403, "administrator_required");
    if (!params || typeof params !== "object" || Array.isArray(params))
      fail(422, "invalid_rclone_parameters");
    switch (method) {
      case "rclone.info":
        return this.info(user);
      case "rclone.configure":
        return this.configure(user, params);
      case "rclone.browse":
        return (await (await this.remote(user)).list(drivePath(params.path))).list;
      case "rclone.mkdir":
        await (await this.remote(user)).mkdir(drivePath(params.path));
        return true;
      case "rclone.rename":
        await (await this.remote(user)).move(drivePath(params.source), drivePath(params.target));
        return true;
      case "rclone.delete":
        await (await this.remote(user)).remove(drivePath(params.path));
        return true;
      case "rclone.link":
        return (await (await this.remote(user)).link(drivePath(params.path))).url;
      case "rclone.size":
        return this.rc(user, "/operations/size", {
          fs: (await this.remote(user)).fs,
          remote: drivePath(params.path),
        });
      case "rclone.jobs":
        return this.jobs(user);
      case "rclone.upload-local": {
        if (typeof params.path !== "string") fail(422, "invalid_rclone_path");
        const filename = params.name || path.basename(params.path);
        if (!filename || /[/\\:\x00-\x1f]/.test(filename) || [".", ".."].includes(filename))
          fail(422, "invalid_name");
        return this.transfer(
          user,
          "upload",
          params.path,
          [drivePath(params.destination), filename].filter(Boolean).join("/"),
        );
      }
      case "rclone.download":
        return this.transfer(user, "download", params.path, drivePath(params.path));
      case "rclone.local-folder":
      case "rclone.local-browse":
        return this.localBrowse(user, params.path);
      case "rclone.stop":
      case "rclone.retry": {
        const job = this.state.get("jobs", params.id);
        if (!job || job.ownerId !== String(user)) fail(404, "rclone_job_not_found");
        if (method === "rclone.retry")
          return this.transfer(user, job.operation, job.source, job.target);
        if (job.status !== "running") fail(409, "rclone_job_not_running");
        if (this.runtime(user)?.generation === job.runtimeId)
          await this.rc(user, "/job/stop", { jobid: job.rcJob });
        job.status = "cancelled";
        this.state.put("jobs", job);
        return true;
      }
      case "rclone.mount-state":
        return this.mountState(user);
      case "rclone.mount-save":
        return this.saveMount(user, params, params.start !== false);
      case "rclone.mount":
        await this.mount(user);
        return this.mountState(user);
      case "rclone.unmount":
        return this.unmount(user, params.disable === true);
      default:
        fail(422, "rclone_action_not_supported", "Esta acción no está disponible en este equipo.");
    }
  }
  async close({ force = false } = {}) {
    this.closed = true;
    clearInterval(this.poll);
    clearTimeout(this.initial);
    for (const [user, remote] of this.managed) {
      const mount = this.state.get("mount", user);
      if (
        !force &&
        (mount?.autoStart ||
          (await this.mountState(user)).running ||
          (await this.jobs(user)).some((j) => j.status === "running"))
      )
        remote.detach();
      else await this.stopRuntime(user);
    }
    this.state.close();
  }
}
