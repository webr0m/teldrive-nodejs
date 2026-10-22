import path from 'node:path';
import { existsSync, readFileSync, writeFileSync, openSync, closeSync, fsyncSync, renameSync, unlinkSync, mkdirSync, readdirSync, statSync, lstatSync, chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parse, stringify } from 'smol-toml';
import { config as validateConfig, configurationSource } from './config.mjs';
import { mapToml, mappings } from './toml.mjs';
import { fail, hash } from './core.mjs';

export const KEEP_SECRET = '__TELDRIVE_KEEP_SECRET__';
const protectedKeys = new Set(['DATA_KEY', 'LEGACY_ENCRYPTION_KEY', 'LEGACY_KEYRING', 'ENCRYPTION_KEY_VERSION', 'OWNER_USER_ID', 'DATA_DIR', 'HOST', 'PORT', 'MODE', 'STORAGE_BACKEND', 'DEMO_AUTH', 'MEDIA_NODE', 'MEDIA_NODE_SECRET', 'MEDIA_NODE_ADMIN', 'MEDIA_NODE_PRIMARY_ORIGIN']);
const secretKeys = new Set(['DATABASE_URL', 'CACHE_POSTGRES_URL', 'CACHE_POSTGRES_PASSWORD', 'SUPABASE_SECRET_KEY', 'TELEGRAM_API_HASH', 'GOOGLE_CLIENT_SECRET', 'MEDIA_NODE_SECRET']);
const booleanKeys = new Set(['ALLOW_IFRAME', 'MEDIA_ENABLED', 'RCLONE_MOUNT_ENABLED']);
const canonical = new Map();
for (const [key, target] of Object.entries(mappings)) if (!canonical.has(target) || key.startsWith('node.')) canonical.set(target, key);

function encode(values, redact = false) {
  const document = {};
  for (const [env, field] of canonical) {
    if (protectedKeys.has(env) || values[env] === undefined) continue;
    const parts = field.split('.'), key = parts.pop();
    const section = parts.reduce((obj, part) => obj[part] ??= {}, document);
    section[key] = redact && secretKeys.has(env) && values[env] ? KEEP_SECRET : values[env];
  }
  return stringify(document);
}
function decode(text) {
  let parsed;
  // Parser messages can contain the source line, including a credential.
  try { parsed = parse(text); } catch { fail(422, 'invalid_toml', 'El TOML no es válido. Revisa su sintaxis; el contenido no se registra.'); }
  const unknown = [];
  function visit(value, prefix = '') {
    for (const [key, child] of Object.entries(value)) {
      const field = prefix ? `${prefix}.${key}` : key;
      if (Object.hasOwn(mappings, field) || ['http.address', 'encryption.keys', 'encryption.active-key-version'].includes(field)) continue;
      if (child && typeof child === 'object' && !Array.isArray(child)) visit(child, field);
      else unknown.push(field);
    }
  }
  visit(parsed);
  return { values: mapToml(parsed), ignored: unknown };
}

export class ServerConfiguration {
  constructor(config) {
    this.config = config;
    this.source = configurationSource(config);
    this.file = this.source?.managedFile;
    this.loaded = this.content();
    this.restartFile = this.source?.baseEnv.SERVER_RESTART_FILE ? path.resolve(this.source.baseEnv.SERVER_RESTART_FILE) : undefined;
  }
  content() {
    if (!this.file || !existsSync(this.file)) return '';
    if (lstatSync(this.file).isSymbolicLink() || !statSync(this.file).isFile() || statSync(this.file).size > 262144) fail(503, 'unsafe_configuration_file');
    return readFileSync(this.file, 'utf8');
  }
  read() {
    const content = this.content();
    const effective = { ...this.source?.baseEnv, ...(content ? decode(content).values : {}) };
    const backups = this.file && existsSync(`${this.file}.backups`) ? readdirSync(`${this.file}.backups`).filter(name => /^\d{13}-[a-f0-9-]{36}\.toml$/.test(name)).sort().reverse().slice(0, 20).map(id => ({ id, createdAt: new Date(Number(id.slice(0, 13))).toISOString() })) : [];
    return { enabled: !!this.file, toml: '# Los campos omitidos conservan su valor. Una cadena vacía borra ese valor.\n# __TELDRIVE_KEEP_SECRET__ conserva el secreto existente.\n' + encode(effective, true), revision: hash(content), restartRequired: content !== this.loaded, restartAvailable: !!this.restartFile, backups };
  }
  prepare(body) {
    if (!this.file) fail(503, 'configuration_management_disabled');
    if (typeof body.toml !== 'string' || Buffer.byteLength(body.toml) > 262144) fail(422, 'configuration_too_large');
    const current = this.content();
    if (body.revision !== hash(current)) fail(409, 'configuration_changed', 'La configuración cambió. Vuelve a cargarla antes de guardar.');
    const imported = decode(body.toml), saved = current ? decode(current).values : {};
    const baseline = { ...this.source.baseEnv, ...saved };
    for (const [key, value] of Object.entries(imported.values)) {
      if (booleanKeys.has(key) && !['true', 'false'].includes(value)) fail(422, 'invalid_configuration_boolean');
      if (protectedKeys.has(key)) {
        if (value !== baseline[key]) fail(422, 'protected_configuration', 'La identidad del propietario, las claves de cifrado y el arranque se cambian únicamente desde el hosting.');
        delete imported.values[key];
      } else if (value === KEEP_SECRET) {
        if (!secretKeys.has(key) || !baseline[key]) fail(422, 'invalid_secret_placeholder');
        delete imported.values[key];
      }
    }
    const values = { ...saved, ...imported.values };
    try { validateConfig({ ...this.source.baseEnv, ...values, CONFIG_FILE: 'none', SERVER_CONFIG_FILE: 'none' }, { skipManaged: true }); }
    catch { fail(422, 'invalid_configuration', 'La combinación de parámetros no es válida. Comprueba URL, transporte, credenciales requeridas y rangos en el manual.'); }
    const changed = Object.keys(values).filter(key => values[key] !== baseline[key]);
    return { values, changed, ignored: imported.ignored, databaseChanged: changed.some(key => /^(DATABASE_|SUPABASE_|NODE_DATABASE_SCHEMA)/.test(key)), current };
  }
  validate(body) {
    const { changed, ignored, databaseChanged } = this.prepare(body);
    return { valid: true, changed, ignored, databaseChanged, requiresRestart: changed.length > 0, connectionTested: false };
  }
  save(body) {
    const prepared = this.prepare(body);
    if (prepared.ignored.length && body.discardUnsupported !== true) fail(422, 'unsupported_configuration', 'Confirma la omisión de las opciones sin soporte antes de guardar.');
    if (prepared.databaseChanged && body.confirmDatabaseChange !== true) fail(422, 'database_change_confirmation_required', 'Confirma que el destino tiene la misma estructura y un respaldo. Esta operación no copia ni migra datos.');
    if (!prepared.changed.length) return this.read();
    this.replace(encode(prepared.values), prepared.current);
    return this.read();
  }
  replace(content, expected) {
    if (Buffer.byteLength(content) > 262144) fail(422, 'configuration_too_large');
    mkdirSync(path.dirname(this.file), { recursive: true });
    const lock = `${this.file}.lock`, temporary = `${this.file}.${randomUUID()}.tmp`;
    let fd;
    try { fd = openSync(lock, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') fail(409, 'configuration_busy'); throw error; }
    try {
      if (this.content() !== expected) fail(409, 'configuration_changed');
      const backupDirectory = `${this.file}.backups`;
      mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
      chmodSync(backupDirectory, 0o700);
      writeFileSync(path.join(backupDirectory, `${Date.now()}-${randomUUID()}.toml`), expected, { flag: 'wx', mode: 0o600 });
      const output = openSync(temporary, 'wx', 0o600);
      try { writeFileSync(output, content); fsyncSync(output); } finally { closeSync(output); }
      renameSync(temporary, this.file);
    } finally {
      closeSync(fd); unlinkSync(lock);
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
  restore(body) {
    if (!this.file || typeof body.backupId !== 'string' || !this.read().backups.some(backup => backup.id === body.backupId)) fail(404, 'configuration_backup_not_found');
    const current = this.content();
    if (body.revision !== hash(current)) fail(409, 'configuration_changed');
    const backup = readFileSync(path.join(`${this.file}.backups`, body.backupId), 'utf8');
    // Restoring is explicit and never moves data between databases.
    if (body.confirmDatabaseChange !== true) fail(422, 'database_change_confirmation_required');
    try { validateConfig({ ...this.source.baseEnv, ...decode(backup).values, CONFIG_FILE: 'none', SERVER_CONFIG_FILE: 'none' }, { skipManaged: true }); } catch { fail(422, 'invalid_configuration_backup'); }
    this.replace(backup, current);
    return this.read();
  }
  restart(body) {
    if (!this.restartFile) fail(503, 'restart_not_configured', 'Reinicia la aplicación desde el panel de tu hosting.');
    if (body.revision !== hash(this.content())) fail(409, 'configuration_changed');
    mkdirSync(path.dirname(this.restartFile), { recursive: true });
    writeFileSync(this.restartFile, new Date().toISOString(), { mode: 0o600 });
    return { requested: true };
  }
}
