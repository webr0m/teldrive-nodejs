import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { Telegram } from '../src/telegram.mjs';
import { SecureBlob } from '../src/secureblob.mjs';
const { Api } = createRequire(import.meta.url)('teleproto');
function fixture() {
  const records = new Map();
  const store = { get: (b, id) => records.get(`${b}:${id}`), put: (b, v) => records.set(`${b}:${v.id}`, v), list: (b, owner) => [...records.entries()].filter(([k,v]) => k.startsWith(`${b}:`) && (owner === undefined || v.ownerId === owner)).map(([,v]) => v) };
  const telegram = new Telegram(store, { key: randomBytes(32), downloadBots: 20, botAttempts: 2, botRetrySeconds: 60 });
  for (const [id,ownerId] of [['1','7'],['2','7'],['3','8']]) store.put('bots', { id, ownerId, enabled: true, tokenCiphertext: 'private', createdAt: new Date().toISOString() });
  return { store, telegram };
}
test('Teldrive secureblob authenticates its version, purpose and ciphertext', () => {
  const box = new SecureBlob(randomBytes(32)), sealed = box.seal('session', 'bot-session');
  assert.equal(sealed[0], 1); assert.equal(sealed.length, 48); assert.equal(box.open(sealed.toString('hex'), 'bot-session').toString(), 'session');
  assert.throws(() => box.open(sealed, 'bot-token'));
  const tampered = Buffer.from(sealed); tampered[30] ^= 1; assert.throws(() => box.open(tampered, 'bot-session'));
  tampered[0] = 2; assert.throws(() => box.open(tampered, 'bot-session'));
});
test('bot rotation isolates owners and operations, respects disabled bots and retries, and falls back to the account', async () => {
  const { store, telegram: t } = fixture();
  assert.deepEqual(t.eligibleBots('7', 'download').map(b=>b.id), ['1','2']);
  assert.deepEqual(t.eligibleBots('7', 'download').map(b=>b.id), ['2','1']);
  assert.deepEqual(t.eligibleBots('7', 'upload').map(b=>b.id), ['1','2']);
  assert.deepEqual(t.eligibleBots('8', 'download').map(b=>b.id), ['3']);
  const attempts = []; t.withBot = async bot => { attempts.push(bot.id); throw new Error('offline'); }; t.withClient = async (owner, fn) => { attempts.push(`user:${owner}`); return fn('account'); };
  assert.equal(await t.withTransfer('7','download',client=>client), 'account'); assert.equal(attempts.length,3);
  assert.deepEqual(t.eligibleBots('7','download'), []); assert.equal(store.get('bots','1').enabled,true,'a Node failure cannot disable a bot in Go');
  assert.deepEqual(t.botSummary(store.get('bots','1')), { id: 1, username: undefined, enabled: true, createdAt: store.get('bots','1').createdAt });
  t.config.downloadBots = 0; assert.deepEqual(t.eligibleBots('8','download'), []);
});

test('choosing download bots does not issue one HTTPS database request per bot', () => {
  const {store,telegram:t}=fixture(); let reads=0;
  const get=store.get.bind(store);store.get=(...args)=>{reads++;return get(...args)};
  for(let n=4;n<104;n++)store.put('bots',{id:String(n),ownerId:'7',enabled:true});
  assert.equal(t.eligibleBots('7','download').length,2);assert.equal(reads,0);
});

test('bot labels recover Telegram names without changing shared credentials and survive an offline server', async () => {
  const {store,telegram:t}=fixture(); t.config.backend='telegram';store.transaction=fn=>fn();
  let lookups=0;
  t.withClient=async (owner,fn)=>{assert.equal(owner,'7');lookups++;return fn({invoke:async request=>{
    assert.ok(request instanceof Api.bots.GetAdminedBots);
    return [{id:1,firstName:'Unidad',lastName:'Principal',username:'drive_bot'},{id:2,firstName:'Respaldo',username:'backup_bot'},{id:3,firstName:'Otra cuenta',username:'foreign_bot'}];
  }});};
  const result=await t.botSummaries('7');
  assert.equal(result[0].name,'Unidad Principal');assert.equal(result[0].username,'drive_bot');assert.equal(result[0].id,1);
  assert.equal(store.get('bots','1').tokenCiphertext,'private');assert.equal(store.get('bot-state','bot-profile:3'),undefined);
  assert.equal(JSON.stringify(result).includes('private'),false);
  t.withClient=async()=>{throw new Error('offline')};
  const restarted=new Telegram(store,t.config);restarted.withClient=t.withClient;
  assert.deepEqual(await restarted.botSummaries('7'),result);assert.equal(lookups,1);
  const other=await restarted.botSummaries('8');assert.equal(other[0].id,3);assert.equal(other[0].name,undefined);
  store.put('bot-state',{id:'bot-profile:3',kind:'bot-profile',botId:'3',ownerId:'7',name:'Wrong owner',username:'wrong_bot'});
  assert.equal(restarted.botSummary(store.get('bots','3')).name,undefined);
});
test('channel resolution works for bots without GetDialogs', async () => {
  const { telegram: t } = fixture(); let called;
  const channel = new Api.Channel({ id: 99, accessHash: 123, title: 'Storage', date: 0 });
  const entity = await t.entity({ invoke: async request => { called=request; return { chats: [channel] }; } }, '99');
  assert.ok(called instanceof Api.channels.GetChannels); assert.equal(String(called.id[0].channelId), '99'); assert.equal(String(called.id[0].accessHash), '0'); assert.equal(entity, channel);
});
test('Node authenticates its own bot key instead of opening the Go session', async () => {
  const { store, telegram: t }=fixture(), bot=store.get('bots','1');
  bot.sessionCiphertext='must-not-open-the-Go-key'; bot.tokenCiphertext=t.secureBlob.seal('1:fixture-token','bot-token').toString('hex');
  let authenticated=false;
  t.make=session=>{ assert.equal(session,''); return { connect:async()=>{}, checkAuthorization:async()=>false, invoke:async request=>{assert.equal(request.botAuthToken,'1:fixture-token');authenticated=true;}, session:{save:()=> 'independent-node-key'}, disconnect:async()=>{} }; };
  assert.equal(await t.withBot(bot,async()=>42),42); assert.equal(authenticated,true);
  const state=store.get('bot-state',t.botStateId(bot)); assert.equal(state.dedicatedAuth,true); assert.equal(t.box.decode(state.session,'bot-session:1'),'independent-node-key');
  const previous=t.botStateId(bot); t.config.telegramInstanceId='another-node-instance'; assert.notEqual(t.botStateId(bot),previous);
  assert.equal(bot.sessionCiphertext,'must-not-open-the-Go-key');
});

test('bot clients reuse independent keys, survive reader cancellation and stay within the configured idle pool',async()=>{
  const {store,telegram:t}=fixture();t.config.botClientPoolSize=1;t.config.botClientIdleSeconds=30;
  let connections=0,disconnections=0;
  t.make=()=>({connected:true,connect:async()=>{connections++},checkAuthorization:async()=>true,session:{save:()=> 'node-only'},disconnect:async()=>{disconnections++}});
  try{
    const bot=store.get('bots','1');await t.withBot(bot,async()=>{});await t.withBot(bot,async()=>{});assert.equal(connections,1);
    await assert.rejects(()=>t.withBot(bot,async()=>{throw Object.assign(new Error('cancelled'),{name:'AbortError'})}),{name:'AbortError'});
    await t.withBot(bot,async()=>{});assert.equal(connections,1,'closing a range must not discard a healthy authenticated connection');
    assert.equal(t.eligibleBots('7','download')[0].id,'1','idle authenticated bot is preferred');
    await t.withBot(store.get('bots','2'),async()=>{});assert.equal(t.botClients.size,1);assert.equal(disconnections,1);
    t.config.botClientPoolSize=0;await t.withBot(store.get('bots','2'),async()=>{});assert.equal(t.botClients.size,0);
  }finally{await t.close();}
  assert.equal(t.clients.size,0);
});
test('unaligned range resumes after partial bot failure without duplicating bytes', async () => {
  const { telegram: t } = fixture(), data = randomBytes(2 * 512 * 1024 + 100), chunks = [], calls = [];
  const client = (broken) => ({ async *iterDownload(_message, params) {
    calls.push(params.offset); assert.equal(params.offset % (512*1024),0);
    if (broken && params.offset >= 512*1024) throw new Error('connection lost');
    yield data.subarray(params.offset, params.offset+512*1024);
    if (broken) throw new Error('connection lost');
    yield data.subarray(params.offset+512*1024);
  } });
  t.message = async () => ({ message: {} }); let first = true;
  t.withBot = async (_bot, fn) => { const broken = first; first=false; return fn(client(broken)); };
  t.withClient = async (_owner, fn) => fn(client(false));
  await t.read('7', {}, 123, 800000, bytes => { chunks.push(bytes); });
  assert.deepEqual(Buffer.concat(chunks), data.subarray(123,800123)); assert.deepEqual(calls, [0,512*1024,512*1024]);
});
