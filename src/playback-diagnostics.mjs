import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

const scope = new AsyncLocalStorage();
const safeAlias = value => typeof value === 'string' ? value.trim().replace(/^@+/, '').slice(0, 64) : undefined;
function addBytes(target, field, count, now) {
  target[field] += count;
  const second = Math.floor(now / 1000);
  target.samples.set(second, (target.samples.get(second) || 0) + count);
  for (const key of target.samples.keys()) if (key < second - 3) target.samples.delete(key);
}
function rate(target, now) {
  const second = Math.floor(now / 1000);
  return [...target.samples].filter(([key]) => key >= second - 2).reduce((sum, [, bytes]) => sum + bytes, 0) / 3;
}
export class PlaybackDiagnostics {
  constructor(config, clock = Date.now) { this.config = config; this.clock = clock; this.sessions = new Map(); }
  prune() {
    const cutoff = this.clock() - (this.config.playbackDiagnosticsTtlSeconds ?? 600) * 1000;
    for (const [key, value] of this.sessions) if (!value.active && value.lastSeen < cutoff) this.sessions.delete(key);
  }
  async run(key, info, fn) {
    if (this.config.playbackDiagnosticsEnabled === 0) { this.sessions.clear(); return scope.run(undefined, fn); }
    this.prune();
    let session = this.sessions.get(key);
    if (!session) {
      const max = this.config.playbackDiagnosticsMaxSessions ?? 128;
      if (this.sessions.size >= max) {
        const idle = [...this.sessions].find(([, value]) => !value.active);
        if (!idle) return scope.run(undefined, fn);
        this.sessions.delete(idle[0]);
      }
      session = { startedAt: this.clock(), lastSeen: this.clock(), active: 0, requests: 0, outputBytes: 0, inputBytes: 0, errors: 0, streams: new Map(), sources: new Map() };
      this.sessions.set(key, session);
    }
    // Retain at most 64 recent requests; cumulative counters remain per session.
    if (session.streams.size >= 64) {
      const idle = [...session.streams].find(([, value]) => value.finishedAt !== undefined);
      if (idle) session.streams.delete(idle[0]); else return scope.run(undefined, fn);
    }
    const stream = { id: randomUUID(), mode: info.mode, purpose: info.purpose || 'playback', rangeStart: info.rangeStart, rangeEnd: info.rangeEnd,
      startedAt: this.clock(), state: 'preparing', outputBytes: 0, sources: new Set(), samples: new Map() };
    session.streams.set(stream.id, stream); session.requests++; session.active++;
    const current = { diagnostics: this, session, stream, signal: info.signal };
    try {
      return await scope.run(current, async () => { const value = await fn(); stream.state = info.signal?.aborted ? 'cancelled' : 'completed'; return value; });
    } catch (error) {
      stream.state = info.signal?.aborted || error.name === 'AbortError' ? 'cancelled' : 'error';
      if (stream.state === 'error') session.errors++;
      throw error;
    } finally { stream.finishedAt = this.clock(); session.lastSeen = this.clock(); session.active--; }
  }
  snapshot(key) {
    if (this.config.playbackDiagnosticsEnabled === 0) this.sessions.clear();
    this.prune(); const session = this.sessions.get(key), now = this.clock();
    const node = { role: this.config.mediaNode ? 'secondary' : 'primary', capturedAt: now, enabled: this.config.playbackDiagnosticsEnabled !== 0,
      startedAt: session?.startedAt, activeRequests: session?.active || 0, requests: session?.requests || 0, outputBytes: session?.outputBytes || 0,
      inputBytes: session?.inputBytes || 0, errors: session?.errors || 0, streams: [], sources: [] };
    if (!session) return node;
    node.streams = [...session.streams.values()].map(s => ({ id: s.id, mode: s.mode, purpose: s.purpose, state: s.state, startedAt: s.startedAt,
      finishedAt: s.finishedAt, firstByteMs: s.firstByteAt === undefined ? undefined : s.firstByteAt - s.startedAt,
      rangeStart: s.rangeStart, rangeEnd: s.rangeEnd, outputBytes: s.outputBytes, bytesPerSecond: rate(s, now), sourceIds: [...s.sources], conversion: s.conversion,
      activeReads: s.activeReads || 0, peakReads: s.peakReads || 0, reader: s.reader }));
    node.sources = [...session.sources.values()].map(s => ({ id: s.id, kind: s.kind, botId: s.botId, name: s.name, username: s.username,
      active: s.active, attempts: s.attempts, failures: s.failures, inputBytes: s.inputBytes, forwardedBytes: s.forwardedBytes,
      bytesPerSecond: rate(s, now), lastByteAt: s.lastByteAt, activeReads: s.activeReads || 0, peakReads: s.peakReads || 0 }));
    return node;
  }
}
export function recordPlaybackOutput(bytes) {
  const current = scope.getStore(); if (!current) return;
  const { stream, session, diagnostics } = current, now = diagnostics.clock();
  stream.state = 'streaming'; stream.firstByteAt ??= now;
  addBytes(stream, 'outputBytes', bytes, now);
  if (stream.purpose === 'playback') session.outputBytes += bytes;
  session.lastSeen = now;
}
export async function traceTransfer(identity, fn) {
  const current = scope.getStore(); if (!current) return fn();
  const { session, stream } = current, kind = identity.kind, key = identity.id ? `bot:${identity.id}` : kind;
  let source = session.sources.get(key);
  if (!source) {
    if (session.sources.size >= 256) return fn();
    source = { id: key, kind, ...(kind === 'bot' ? { botId: String(identity.id), name: identity.name?.slice(0, 128), username: safeAlias(identity.username) } : {}),
      active: 0, attempts: 0, failures: 0, inputBytes: 0, forwardedBytes: 0, samples: new Map() };
    session.sources.set(key, source);
  }
  source.active++; source.attempts++; stream.sources.add(key);
  try { return await scope.run({ ...current, source }, fn); }
  catch (error) { if (!current.signal?.aborted && error.name !== 'AbortError') source.failures++; throw error; }
  finally { source.active--; }
}
export function recordTransferInput(bytes) {
  const current = scope.getStore(); if (!current?.source) return;
  const now = current.diagnostics.clock(); addBytes(current.source, 'inputBytes', bytes, now);
  current.source.lastByteAt = now; current.session.inputBytes += bytes; current.session.lastSeen = now;
}
export function recordTransferForwarded(bytes) { const current = scope.getStore(); if (current?.source) current.source.forwardedBytes += bytes; }
export function conversionObserver() {
  const current = scope.getStore();
  return values => { if (current) current.stream.conversion = { ...current.stream.conversion, ...values }; };
}
export function configureDownload(reader) { const current=scope.getStore();if(current)current.stream.reader=reader; }
export async function traceDownloadRead(fn) {
  const current=scope.getStore();if(!current)return fn();
  const targets=[current.stream,current.source].filter(Boolean);
  for(const target of targets){target.activeReads=(target.activeReads||0)+1;target.peakReads=Math.max(target.peakReads||0,target.activeReads);}
  try{return await fn();}finally{for(const target of targets)target.activeReads--;}
}
