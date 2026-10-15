import path from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { Store, CryptoBox, id, token, hash, now, expires, expired, fail } from './core.mjs';
import { cookies } from './auth.mjs';

const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
export async function verifyGoogleToken(jwt, audience, keys = googleKeys) {
  const result = await jwtVerify(jwt, keys, { audience, issuer: ['https://accounts.google.com', 'accounts.google.com'], algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'sub', 'nonce', 'email', 'email_verified'], maxTokenAge: '1h' });
  return result.payload;
}
const challenge = value => createHash('sha256').update(value).digest('base64url');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function assertClientAccess(principal, method, pathname) {
  if (principal.session?.scope !== 'client' && !principal.user?.clientOnly) return;
  // Personal storage selection is available; channel creation/deletion stay on the server UI.
  const channelSelection = method === 'POST' && (/^\/api\/v1\/channels\/-?\d+\/select$/.test(pathname) || pathname === '/api/v1/channels/sync');
  if (/^\/api\/v1\/(admin|jobs|api-keys|rclone)(\/|$)/.test(pathname) ||
      (/^\/api\/v1\/channels(\/|$)/.test(pathname) && method !== 'GET' && !channelSelection))
    fail(403, 'client_session_only', 'Esta sesión móvil no permite administrar el servidor.');
}
export class Mobile {
  constructor(config, auth, overrides = {}) {
    this.config = config; this.auth = auth;
    this.state = new Store(path.join(config.dataDir, 'mobile'));
    this.box = new CryptoBox(config.key);
    this.fetch = overrides.fetch || fetch;
    this.verify = overrides.verify || (jwt => verifyGoogleToken(jwt, config.googleClientId));
  }
  enabled() { return !!(this.config.googleClientId && this.config.googleClientSecret); }
  read(bucket, key) { const value = this.state.get(bucket, key); return value && this.box.decode(value.secret, `${bucket}:${key}`); }
  write(bucket, key, value) { this.state.put(bucket, { id: key, userId: value.userId, expiresAt: value.expiresAt, secret: this.box.encode(value, `${bucket}:${key}`) }); }
  prune() {
    this.state.transaction(() => {
      for (const flow of this.state.list('oauth-flow')) if (expired(flow.expiresAt)) this.state.delete('oauth-flow', flow.id);
      for (const state of this.state.list('oauth-state')) if (!this.state.get('oauth-flow', state.flowId)) this.state.delete('oauth-state', state.id);
    });
  }
  flow(flowId) {
    const flow = this.read('oauth-flow', flowId);
    if (!flow || expired(flow.expiresAt) || flow.consumed) fail(410, 'mobile_login_expired');
    return flow;
  }
  start(body, principal) {
    this.prune();
    if (this.state.list('oauth-flow').length >= 1000) fail(429, 'too_many_mobile_logins');
    if (!this.enabled()) fail(503, 'google_not_configured', 'El administrador todavía no ha configurado el acceso con Google.');
    if (typeof body.challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.challenge)) fail(422, 'invalid_pkce_challenge');
    const flowId = id(), oauthState = token();
    const flow = { id: flowId, challenge: body.challenge, oauthState, verifier: token(), nonce: token(), state: 'pending', expiresAt: expires(600000) };
    if (body.link) {
      this.requireTelegram(principal);
      flow.userId = String(principal.user.id); flow.sessionId = principal.session.id;
    }
    this.write('oauth-flow', flowId, flow);
    this.state.put('oauth-state', { id: hash(oauthState), flowId });
    return { flowId, authUrl: `${this.config.publicUrl}/api/v1/mobile/google/authorize?flow=${flowId}`, expiresAt: flow.expiresAt };
  }
  authorize(flowId, res) {
    const flow = this.flow(flowId);
    if (flow.state !== 'pending') fail(409, 'mobile_login_started');
    const browser = token(); flow.browserHash = hash(browser); flow.state = 'authorizing'; this.write('oauth-flow', flowId, flow);
    res.setHeader('Set-Cookie', `td_google_flow=${browser}; Path=/api/v1/mobile/google; HttpOnly; SameSite=Lax; Max-Age=600${this.config.production ? '; Secure' : ''}`);
    const query = new URLSearchParams({ client_id: this.config.googleClientId, redirect_uri: `${this.config.publicUrl}/api/v1/mobile/google/callback`, response_type: 'code', scope: 'openid email', state: flow.oauthState, nonce: flow.nonce, code_challenge: challenge(flow.verifier), code_challenge_method: 'S256', prompt: 'select_account' });
    return `https://accounts.google.com/o/oauth2/v2/auth?${query}`;
  }
  async callback(query, req, res) {
    const record = this.state.get('oauth-state', hash(query.get('state') || ''));
    if (!record) fail(400, 'invalid_oauth_state');
    const flow = this.flow(record.flowId);
    if (flow.state !== 'authorizing' || !equal(hash(cookies(req).td_google_flow || ''), flow.browserHash)) fail(400, 'invalid_oauth_state');
    this.state.transaction(() => {
      if (this.flow(flow.id).state !== 'authorizing') fail(409, 'oauth_callback_replayed');
      flow.state = 'exchanging'; this.write('oauth-flow', flow.id, flow); this.state.delete('oauth-state', record.id);
    });
    res.setHeader('Set-Cookie', `td_google_flow=; Path=/api/v1/mobile/google; HttpOnly; SameSite=Lax; Max-Age=0${this.config.production ? '; Secure' : ''}`);
    try {
      if (query.has('error') || !query.get('code')) fail(400, 'google_login_cancelled');
      const response = await this.fetch('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code: query.get('code'), client_id: this.config.googleClientId, client_secret: this.config.googleClientSecret, redirect_uri: `${this.config.publicUrl}/api/v1/mobile/google/callback`, grant_type: 'authorization_code', code_verifier: flow.verifier }), signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) fail(401, 'google_exchange_failed');
      const { id_token: jwt } = await response.json(), claims = await this.verify(jwt);
      if (!equal(claims.nonce, flow.nonce) || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255 || claims.email_verified !== true || typeof claims.email !== 'string' || claims.email.length > 320) fail(401, 'invalid_google_identity');
      flow.google = { subject: claims.sub, email: claims.email }; flow.state = 'ready';
    } catch (error) {
      flow.state = 'failed'; flow.error = error.status ? error.code : 'google_verification_failed';
    }
    delete flow.verifier; delete flow.oauthState; delete flow.nonce; delete flow.browserHash;
    this.write('oauth-flow', flow.id, flow);
    return flow.state === 'ready';
  }
  requireTelegram(principal) {
    if (!principal?.session || principal.apiKey || principal.session.provider !== 'telegram' || Date.now() - Date.parse(principal.session.createdAt) > 600000) fail(403, 'recent_telegram_login_required', 'Inicia sesión de nuevo con Telegram para vincular Google.');
  }
  complete(body, principal, res) {
    if (typeof body.verifier !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(body.verifier)) fail(422, 'invalid_pkce_verifier');
    const flow = this.flow(body.flowId);
    if (!equal(challenge(body.verifier), flow.challenge)) fail(401, 'invalid_pkce_verifier');
    if (flow.state === 'failed') fail(401, flow.error);
    if (flow.state !== 'ready') return { state: 'pending' };
    const identity = hash(flow.google.subject);
    let linked = this.read('google-account', identity);
    if (!linked || flow.userId || body.link === true) {
      if (!body.link) return { state: 'link_required', email: flow.google.email };
      this.requireTelegram(principal);
      if (flow.userId && (flow.userId !== String(principal.user.id) || flow.sessionId !== principal.session.id)) fail(403, 'google_link_session_mismatch');
      const userId = String(principal.user.id);
      this.state.transaction(() => {
        const existing = this.read('google-account', identity);
        if (existing && existing.userId !== userId) fail(409, 'google_already_linked');
        // One active Google identity per Telegram account; replacement is explicit unlink + relink.
        if (this.state.list('google-account', userId).some(record => record.id !== identity)) fail(409, 'google_account_already_linked');
        linked = { ...flow.google, userId, createdAt: existing?.createdAt || now() };
        this.write('google-account', identity, linked);
      });
    }
    const user = this.auth.user(linked.userId), allowed = this.config.allowedUsers;
    if (allowed.length && !allowed.includes(String(user.id)) && !allowed.some(value => user.username && value.replace(/^@/, '').toLowerCase() === user.username.toLowerCase())) fail(403, 'user_not_allowed');
    this.state.transaction(() => {
      const latest = this.flow(flow.id); if (latest.state !== 'ready') fail(409, 'mobile_login_consumed');
      latest.consumed = true; delete latest.google; this.write('oauth-flow', flow.id, latest);
    });
    return this.auth.publish(this.auth.session(linked.userId, { scope: 'client', provider: 'google', identity }), res, false);
  }
  account(userId) {
    const record = this.state.list('google-account', String(userId))[0];
    const linked = record && this.read('google-account', record.id);
    return { enabled: this.enabled(), linked: !!linked, email: linked?.email };
  }
  unlink(userId, principal) {
    this.requireTelegram(principal);
    this.state.transaction(() => {
      for (const record of this.state.list('google-account', String(userId))) this.state.delete('google-account', record.id);
    });
    for (const session of this.auth.store.list('sessions', String(userId))) if (session.scope === 'client' && session.provider === 'google' && !session.revokedAt) this.auth.revoke(session);
  }
  close() { this.state.close(); }
}
