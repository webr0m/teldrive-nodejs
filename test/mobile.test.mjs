import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { createApp } from '../src/server.mjs';
import { config } from '../src/config.mjs';
import { verifyGoogleToken } from '../src/mobile.mjs';
import { parseMobileAds, eligibleCampaigns, fetchMobileAds } from '../ui/src/lib/mobile-ads-config.ts';

const { privateKey, publicKey } = await generateKeyPair('RS256');
const keys = createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), kid: 'test', alg: 'RS256' }] });
const audience = 'test.apps.googleusercontent.com';
const sign = (claims = {}, aud = audience, issuer = 'https://accounts.google.com') => new SignJWT({ nonce: 'nonce', email: 'client@example.test', email_verified: true, ...claims }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(issuer).setAudience(aud).setSubject('google-subject').setIssuedAt().setExpirationTime('5m').sign(privateKey);

test('Google validates signature, issuer, audience, expiry and mandatory claims', async () => {
  assert.equal((await verifyGoogleToken(await sign(), audience, keys)).sub, 'google-subject');
  for (const jwt of [await sign({}, 'another-client'), await sign({}, audience, 'https://attacker.test'), await sign({ email: undefined })]) await assert.rejects(() => verifyGoogleToken(jwt, audience, keys));
  const expired = await new SignJWT({ nonce: 'n', email: 'e', email_verified: true }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer('https://accounts.google.com').setAudience(audience).setSubject('s').setIssuedAt().setExpirationTime(Math.floor(Date.now() / 1000) - 60).sign(privateKey);
  await assert.rejects(() => verifyGoogleToken(expired, audience, keys));
  const forged = (await sign()).split('.'); forged[2] = randomBytes(256).toString('base64url');
  await assert.rejects(() => verifyGoogleToken(forged.join('.'), audience, keys));
});

test('mobile OAuth binds browser and PKCE, links only explicitly and preserves client scope through refresh', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'teldrive-mobile-'));
  const c = config({ CONFIG_FILE: 'none', MEDIA_ENABLED: 'false', DATA_KEY: randomBytes(32).toString('base64'), DATA_DIR: directory, STORAGE_BACKEND: 'local', PORT: '0', RATE_LIMIT_PER_MINUTE: '10000', LOGIN_RATE_PER_MINUTE: '100', GOOGLE_CLIENT_ID: audience, GOOGLE_CLIENT_SECRET: 'server-only-secret' });
  let claims;
  const app = createApp(c, { mobile: { fetch: async (url, options) => {
    assert.equal(url, 'https://oauth2.googleapis.com/token'); assert.equal(options.body.get('client_secret'), c.googleClientSecret);
    return Response.json({ id_token: await sign(claims) });
  }, verify: jwt => verifyGoogleToken(jwt, audience, keys) } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`, { auth, mobile, store } = app.context;
  const owner = auth.publish(auth.finish({ id: 1, firstName: 'Owner' }), {}, false);
  const other = auth.publish(auth.finish({ id: 2, firstName: 'Other' }), {}, false);
  const request = (route, method = 'GET', body, access, extra = {}) => fetch(`${base}/api/v1${route}`, { method, redirect: 'manual', headers: { ...(access ? { Authorization: `Bearer ${access}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
  const mobileHeaders = { Origin: 'capacitor://localhost', 'X-Teldrive-Client': 'mobile', 'Sec-Fetch-Site': 'cross-site' };
  const publicConfig = await (await request('/mobile/config')).json(); assert.equal(publicConfig.googleEnabled, true); assert.ok(!JSON.stringify(publicConfig).includes(c.googleClientSecret));
  async function flow({ link = false, access, nonce, emailVerified = true } = {}) {
    const verifier = randomBytes(32).toString('base64url'), challenge = createHash('sha256').update(verifier).digest('base64url');
    const response = await request('/mobile/google/start', 'POST', { challenge, link }, access); assert.equal(response.status, 201);
    const started = await response.json(), authorized = await fetch(started.authUrl.replace(c.publicUrl, base), { redirect: 'manual' });
    assert.equal(authorized.status, 302); const url = new URL(authorized.headers.get('location'));
    assert.equal(url.origin, 'https://accounts.google.com'); assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    const callback = `/mobile/google/callback?${new URLSearchParams({ state: url.searchParams.get('state'), code: 'test-code' })}`;
    assert.equal((await request(callback)).status, 400, 'unbound browser cannot complete OAuth');
    claims = { nonce: nonce ?? mobile.read('oauth-flow', started.flowId).nonce, email_verified: emailVerified };
    const cookie = authorized.headers.getSetCookie()[0].split(';')[0];
    assert.equal((await request(callback, 'GET', undefined, undefined, { Cookie: cookie })).status, nonce || !emailVerified ? 401 : 200);
    assert.equal((await request(callback, 'GET', undefined, undefined, { Cookie: cookie })).status, 400, 'callback cannot be replayed');
    return { flowId: started.flowId, verifier, link };
  }
  const first = await flow();
  assert.equal((await request('/mobile/google/complete', 'POST', { ...first, verifier: randomBytes(32).toString('base64url') })).status, 401);
  assert.equal((await (await request('/mobile/google/complete', 'POST', first)).json()).state, 'link_required');
  assert.equal(store.list('users').length, 2, 'Google email never creates or merges Telegram accounts');
  assert.equal((await request('/mobile/google/complete', 'POST', { ...first, link: true })).status, 403);
  const linked = await request('/mobile/google/complete', 'POST', { ...first, link: true }, owner.accessToken); assert.equal(linked.status, 200);
  let pair = await linked.json();
  assert.equal((await request('/mobile/google/complete', 'POST', { ...first, link: true }, owner.accessToken)).status, 410);
  assert.equal(mobile.account('1').linked, true);
  assert.ok(!JSON.stringify(mobile.state.list('google-account')).includes('client@example.test'), 'Google identity is encrypted at rest');
  assert.equal((await request('/me', 'GET', undefined, owner.accessToken, mobileHeaders)).status, 403, 'native origin cannot use an unrestricted session');
  let profile = await (await request('/me', 'GET', undefined, pair.accessToken, mobileHeaders)).json();
  assert.equal(profile.role, 'user'); assert.equal(profile.clientOnly, true); assert.ok(!profile.capabilities.includes('system.manageUsers'));
  assert.equal(store.get('users', '1').role, 'owner', 'mobile does not mutate the account role');
  for (const [route, method] of [['/admin/settings', 'GET'], ['/jobs', 'GET'], ['/api-keys', 'GET'], ['/rclone/actions', 'POST'], ['/channels', 'POST']]) assert.equal((await request(route, method, method === 'POST' ? {} : undefined, pair.accessToken)).status, 403, route);
  assert.equal((await request('/bots', 'GET', undefined, pair.accessToken, mobileHeaders)).status, 200, 'personal bots remain available');
  for (const channel of [
    { id: '101', ownerId: '1', name: 'Original', selected: true },
    { id: '102', ownerId: '1', name: 'Nueva unidad', selected: false },
    { id: '103', ownerId: '2', name: 'Otro usuario', selected: false },
  ]) store.put('channels', channel);
  assert.equal((await request('/channels/102/select', 'POST', {}, pair.accessToken, mobileHeaders)).status, 200, 'client can select its own storage channel');
  assert.equal(store.get('channels', '1:102').selected, true);
  assert.equal(store.get('channels', '1:101').selected, false);
  assert.equal((await request('/channels/103/select', 'POST', {}, pair.accessToken, mobileHeaders)).status, 404, 'client cannot select another user channel');
  assert.equal((await request('/channels/102', 'DELETE', undefined, pair.accessToken, mobileHeaders)).status, 403, 'channel deletion remains unavailable in the client');
  app.context.telegram.discover = async () => [{ id: '104', name: 'Canal descubierto' }];
  assert.equal((await request('/channels/sync', 'POST', { channelIds: [104] }, pair.accessToken, mobileHeaders)).status, 200, 'client can import an available personal channel');
  assert.equal(store.get('channels', '1:104').ownerId, '1');
  assert.equal((await request('/channels/sync', 'POST', { channelIds: [103] }, pair.accessToken, mobileHeaders)).status, 404, 'only channels discovered for this account can be imported');
  assert.equal((await request('/files', 'GET', undefined, pair.accessToken, mobileHeaders)).status, 200);
  const refreshed = await request('/auth/refresh', 'POST', { refreshToken: pair.refreshToken }, undefined, mobileHeaders); assert.equal(refreshed.status, 200); pair = await refreshed.json();
  profile = await (await request('/me', 'GET', undefined, pair.accessToken, mobileHeaders)).json(); assert.equal(profile.clientOnly, true);
  const takeover = await flow({ link: true, access: other.accessToken });
  assert.equal((await request('/mobile/google/complete', 'POST', takeover, owner.accessToken)).status, 403, 'link is bound to its starting session');
  assert.equal((await request('/mobile/google/complete', 'POST', takeover, other.accessToken)).status, 409, 'Google cannot be stolen by another Telegram account');
  for (const options of [{ nonce: 'incorrect' }, { emailVerified: false }]) assert.equal((await request('/mobile/google/complete', 'POST', await flow(options))).status, 401);
  assert.equal((await request('/mobile/account/google', 'DELETE', undefined, pair.accessToken)).status, 403, 'unlink requires fresh Telegram login');
  assert.equal((await request('/mobile/account/google', 'DELETE', undefined, owner.accessToken)).status, 204);
  assert.equal((await request('/me', 'GET', undefined, pair.accessToken)).status, 401, 'unlink revokes Google client sessions');
  assert.equal((await request('/me', 'GET', undefined, owner.accessToken)).status, 200, 'Telegram sessions remain usable');
});

test('remote advertising accepts bounded HTTPS campaigns and respects their dates', async () => {
  const campaign = { id: 'own', imageUrl: 'https://ads.example/banner.png', targetUrl: 'https://example.test', title: 'Own ad', startsAt: '2026-01-01', endsAt: '2027-01-01' };
  const parsed = parseMobileAds({ version: 1, own: { enabled: true, intervalSeconds: 0, durationSeconds: 999, campaigns: [campaign, campaign, { ...campaign, id: 'unsafe', targetUrl: 'javascript:alert(1)' }, { ...campaign, id: 'invalid-date', startsAt: 'invalid' }] }, admob: { enabled: true, androidBannerId: 'ca-app-pub-3940256099942544/6300978111', iosBannerId: 'invalid' } });
  assert.equal(parsed.own.campaigns.length, 1); assert.equal(parsed.own.intervalSeconds, 30); assert.equal(parsed.own.durationSeconds, 120);
  assert.equal(parsed.admob.iosBannerId, ''); assert.equal(eligibleCampaigns(parsed, Date.parse('2026-06-01')).length, 1); assert.equal(eligibleCampaigns(parsed, Date.parse('2027-02-01')).length, 0);
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, options) => { assert.equal(options.credentials, 'omit'); assert.equal(options.headers, undefined); return new Response(' '.repeat(65537)); };
    await assert.rejects(() => fetchMobileAds('https://ads.example/config.json', new AbortController().signal), /64 KiB/);
    await assert.rejects(() => fetchMobileAds('http://ads.example/config.json', new AbortController().signal), /HTTPS/);
  } finally { globalThis.fetch = original; }
});
