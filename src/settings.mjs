import { number, fail, now } from './core.mjs';

// Infrastructure-independent limits, persisted separately from credentials.
export const limitDefinitions = {
  jobPollSeconds: { label: 'Intervalo de consulta de tareas (segundos)', min: 1, max: 300, env: 'JOB_POLL_SECONDS' },
  jobLeaseSeconds: { label: 'Reserva de ejecución de tareas (segundos)', min: 30, max: 3600, env: 'JOB_LEASE_SECONDS' },
  jobBatchLimit: { label: 'Máximo de elementos por tarea de mantenimiento', min: 1, max: 10000, env: 'JOB_BATCH_LIMIT' },
  pendingRetentionDays: { label: 'Retención de archivos pendientes de eliminación (días)', min: 1, max: 3650, env: 'PENDING_RETENTION_DAYS' },
  staticCacheBytes: { label: 'Caché de archivos de la interfaz (bytes; 0 desactiva)', min: 0, max: 67108864, env: 'STATIC_CACHE_BYTES' },
  downloadBots: { label: 'Bots disponibles para descargas (0 usa la cuenta)', min: 0, max: 200, env: 'DOWNLOAD_BOTS' },
  botAttempts: { label: 'Intentos con bots antes de usar la cuenta', min: 1, max: 20, env: 'BOT_ATTEMPTS' },
  botRetrySeconds: { label: 'Espera tras un fallo de bot (segundos)', min: 1, max: 86400, env: 'BOT_RETRY_SECONDS' },
  botClientPoolSize: { label: 'Conexiones de bots reutilizables (0 desactiva)', min: 0, max: 64, env: 'BOT_CLIENT_POOL_SIZE' },
  botClientIdleSeconds: { label: 'Conservar conexiones de bots inactivas (segundos)', min: 1, max: 600, env: 'BOT_CLIENT_IDLE_SECONDS' },
  uploadRetryAttempts: { label: 'Reintentos por fragmento de subida', min: 0, max: 10, env: 'UPLOAD_RETRY_ATTEMPTS' },
  playbackTtlMinutes: { label: 'Duración del permiso de reproducción (minutos)', min: 5, max: 1440, env: 'PLAYBACK_TTL_MINUTES' },
  mediaConcurrency: { label: 'Procesos multimedia simultáneos', min: 1, max: 64, env: 'MEDIA_CONCURRENCY' },
  mediaThreads: { label: 'Hilos por conversión multimedia', min: 1, max: 64, env: 'MEDIA_THREADS' },
  mediaCopyVideo: { label: 'Conservar vídeo H.264 compatible sin recodificar (0/1)', min: 0, max: 1, env: 'MEDIA_COPY_VIDEO' },
  mediaAnalyzeSeconds: { label: 'Duración de análisis multimedia (segundos)', min: 1, max: 60, env: 'MEDIA_ANALYZE_SECONDS' },
  mediaMaxWidth: { label: 'Ancho máximo del vídeo convertido (píxeles)', min: 128, max: 7680, env: 'MEDIA_MAX_WIDTH' },
  mediaTimeoutSeconds: { label: 'Duración máxima de conversión (segundos)', min: 10, max: 86400, env: 'MEDIA_TIMEOUT_SECONDS' },
  mediaProbeTimeoutSeconds: { label: 'Espera para detectar pistas (segundos)', min: 5, max: 600, env: 'MEDIA_PROBE_TIMEOUT_SECONDS' },
  mediaProbeBytes: { label: 'Datos para detectar pistas (bytes)', min: 32768, max: 134217728, env: 'MEDIA_PROBE_BYTES' },
  partSize: { label: 'Tamaño de parte (bytes)', min: 1048576, max: 536870912, env: 'PART_SIZE' },
  maxFileSize: { label: 'Tamaño máximo de archivo (bytes)', min: 0, max: Number.MAX_SAFE_INTEGER, env: 'MAX_FILE_SIZE' },
  concurrency: { label: 'Transferencias simultáneas', min: 1, max: 64, env: 'MAX_CONCURRENT_TRANSFERS' },
  uploadTtlHours: { label: 'Duración de carga reanudable (horas)', min: 1, max: 8760, env: 'UPLOAD_TTL_HOURS' },
  rateLimitPerMinute: { label: 'Solicitudes por IP por minuto', min: 10, max: 100000, env: 'RATE_LIMIT_PER_MINUTE' },
  loginRatePerMinute: { label: 'Solicitudes de acceso por IP por minuto', min: 1, max: 1000, env: 'LOGIN_RATE_PER_MINUTE' },
  jsonMaxBytes: { label: 'Tamaño máximo de JSON (bytes)', min: 4096, max: 16777216, env: 'JSON_MAX_BYTES' },
};
export class Settings {
  constructor(store, config, uploads) {
    this.store = store; this.config = config; this.uploads = uploads;
    this.defaults = Object.fromEntries(Object.keys(limitDefinitions).map(k => [k, config[k]]));
    const saved = store.get('settings', 'limits');
    if (saved) this.apply(saved.values);
  }
  read() { return { values: Object.fromEntries(Object.keys(limitDefinitions).map(k => [k, this.config[k]])), definitions: limitDefinitions, defaults: this.defaults }; }
  apply(values) {
    for (const [key, value] of Object.entries(values)) {
      const definition = limitDefinitions[key]; if (!definition) fail(422, 'unknown_setting');
      number(value, definition.min, definition.max);
    }
    Object.assign(this.config, values); this.uploads.transfers.max = this.config.concurrency;
  }
  update(user, values) {
    if (!['owner', 'admin'].includes(user.role)) fail(403, 'administrator_required');
    if (!values || typeof values !== 'object' || Array.isArray(values)) fail(422, 'invalid_settings');
    // Validate all entries before mutating live configuration.
    this.apply(values);
    this.store.put('settings', { id: 'limits', values: this.read().values, updatedAt: now(), updatedBy: user.id });
    return this.read();
  }
}
