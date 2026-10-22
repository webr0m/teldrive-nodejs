import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {orderedDownload, DownloadGate} from '../src/parallel-download.mjs';
import {fixture} from './fixtures/managed-bots.mjs';
import {PlaybackDiagnostics,recordPlaybackOutput} from '../src/playback-diagnostics.mjs';
import {SupabaseStore} from '../src/supabase.mjs';
import {Worker} from 'node:worker_threads';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {config} from '../src/config.mjs';

test('parallel download emits exact unaligned bytes in order and bounds look-ahead under backpressure',async()=>{
  const data=randomBytes(7*512*1024+33),output=[];let active=0,peak=0,fetched=0,written=0,ahead=0;
  await orderedDownload({offset:123,length:data.length-200,parallel:4,buffers:5,
    fetch:async plan=>{active++;peak=Math.max(peak,active);await delay(plan.offset===0?12:1);active--;fetched++;ahead=Math.max(ahead,fetched-written);return data.subarray(plan.offset+plan.skip,plan.offset+plan.skip+plan.length)},
    write:async bytes=>{await delay(2);output.push(bytes);written++},
  });
  assert.equal(peak,4);assert.ok(ahead<=5);assert.deepEqual(Buffer.concat(output),data.subarray(123,data.length-77));
});

test('parallel Telegram read retries from emitted bytes after a bot fails without duplicating or reordering data',async()=>{
  const {telegram:t,store}=fixture();t.config.downloadReadParallel=4;t.config.downloadReadBuffers=6;t.config.downloadMaxParallel=4;
  store.put('bots',{id:'10002',ownerId:'7',enabled:true,username:'backup_bot',tokenCiphertext:'fake'});
  const data=randomBytes(6*512*1024+77),output=[],stats=new PlaybackDiagnostics({});let active=0,peak=0;
  t.message=async()=>({message:{}});
  t.withBot=async(bot,fn)=>fn({async *iterDownload(_message,p){
    active++;peak=Math.max(peak,active);
    try{await delay(p.offset===0?1:5);if(bot.id==='10001'&&p.offset===512*1024)throw Error('connection failed');yield data.subarray(p.offset,p.offset+p.requestSize)}finally{active--}
  }});
  await stats.run('ticket',{mode:'original'},()=>t.read('7',{channelId:'99'},123,data.length-200,async bytes=>{output.push(bytes);recordPlaybackOutput(bytes.length)}));
  assert.deepEqual(Buffer.concat(output),data.subarray(123,data.length-77));assert.ok(peak>=2);assert.equal(t.downloadGate.active,0);
  const snapshot=stats.snapshot('ticket');assert.equal(snapshot.sources.find(s=>s.botId==='10001').failures,1);assert.ok(snapshot.sources.some(s=>s.botId==='10002'));assert.equal(snapshot.outputBytes,data.length-200);
  assert.equal(snapshot.streams[0].peakReads,4);assert.equal(snapshot.streams[0].reader.parallel,4);assert.equal(snapshot.streams[0].activeReads,0);
});

test('simultaneous streams reserve different idle bots instead of queuing behind a warm busy bot',async()=>{
  const {telegram:t,store}=fixture();store.put('bots',{id:'10002',ownerId:'7',enabled:true,tokenCiphertext:'fake'});
  t.botClients.set('10001',{});const selected=[];let release;const gate=new Promise(resolve=>release=resolve);
  t.withBot=async(bot,fn)=>{selected.push(bot.id);await gate;return fn(bot.id)};
  const first=t.withTransfer('7','download',v=>v),second=t.withTransfer('7','download',v=>v);
  assert.deepEqual(selected,['10001','10002']);release();await Promise.all([first,second]);assert.equal(t.botReservations.size,0);
});

test('global read gate bounds work and removes cancelled queued requests',async()=>{
  const gate=new DownloadGate(1);let release;const held=gate.run(()=>new Promise(resolve=>release=resolve));await delay(0);
  const abort=new AbortController(),queued=gate.run(()=>assert.fail('cancelled work ran'),abort.signal);abort.abort();
  await assert.rejects(queued,{name:'AbortError'});assert.equal(gate.queue.length,0);release();await held;assert.equal(gate.active,0);
});

test('cancelling an ordered download stops queued and in-flight work without emitting more bytes',async()=>{
  const controller=new AbortController();let calls=0,writes=0;
  const pending=orderedDownload({offset:0,length:20*512*1024,parallel:4,buffers:8,signal:controller.signal,
    fetch:async(_plan,signal)=>{calls++;await delay(1000,undefined,{signal});return Buffer.alloc(512*1024)},
    write:async()=>{writes++},
  });
  await delay(5);controller.abort();await assert.rejects(pending,{name:'AbortError'});
  assert.equal(calls,4);assert.equal(writes,0);
});

test('HTTPS read hydration is asynchronous, scoped per request, mutation-safe and sees revocation on the next request',async()=>{
  let calls=0,revoked=false,ticks=0;const store=new SupabaseStore({}, {rpc:r=>{if(r.action==='ready')return {layout:'v2'};assert.fail('read blocked the synchronous bridge')},rpcAsync:async r=>{calls++;await delay(10);return {items:[{id:r.id,revokedAt:revoked?'now':undefined}]}}});
  const timer=setInterval(()=>ticks++,1);
  try{
    await store.readScope(async()=>{
      const row=await store.readAsync(()=>store.get('sessions','1'));assert.equal(row.revokedAt,undefined);
      assert.equal(store.get('sessions','1').id,'1');assert.equal(calls,1);
      await assert.rejects(()=>store.readAsync(()=>store.put('sessions',{id:'1'})),/cannot write/);
    });
    revoked=true;assert.equal((await store.readAsync(()=>store.get('sessions','1'))).revokedAt,'now');assert.equal(calls,2);assert.ok(ticks>0,'the event loop must run while HTTPS is pending');
    const rows=await Promise.all(['2','3'].map(id=>store.readAsync(()=>store.get('sessions',id))));assert.deepEqual(rows.map(r=>r.id),['2','3']);
  }finally{clearInterval(timer);store.close()}
});

test('asynchronous worker replies stay correlated with concurrent reads and synchronous writes',async()=>{
  const code=`const {parentPort}=require('node:worker_threads');parentPort.on('message',({request,asyncId,control,output})=>{const result={value:request.action==='ready'?{layout:'v2'}:{id:request.id}};if(asyncId!==undefined){setTimeout(()=>parentPort.postMessage({asyncId,result}),request.id==='first'?30:1);return;}const bytes=Buffer.from(JSON.stringify(result));new Uint8Array(output).set(bytes);const flags=new Int32Array(control);Atomics.store(flags,1,bytes.length);Atomics.store(flags,0,1);Atomics.notify(flags,0);});`;
  const store=new SupabaseStore({}, {workerFactory:()=>new Worker(code,{eval:true,execArgv:[]})});
  try{
    const first=store.rpcAsync({action:'get',id:'first'}),second=store.rpcAsync({action:'get',id:'second'});
    assert.deepEqual(store.rpc({action:'commit',id:'write'}),{id:'write'});
    assert.deepEqual(await Promise.all([first,second]),[{id:'first'},{id:'second'}]);assert.equal(store.asyncCalls.size,0);
    const lost=store.rpcAsync({action:'get',id:'first'});store.close();await assert.rejects(lost,{code:'supabase_unavailable'});
  }finally{store.close()}
});

test('TOML accepts original Telegram read settings and environment overrides without changing unrelated limits',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'td-read-config-'));
  try{
    const filename=path.join(directory,'config.toml');
    await writeFile(filename,'[telegram]\ndownload-read-parallel=6\ndownload-read-buffers=12\n[node.limits]\ndownload-max-parallel=24\ndownload-read-timeout-seconds=20\n');
    const c=config({CONFIG_FILE:filename,DATA_KEY:randomBytes(32).toString('base64'),STORAGE_BACKEND:'local',DOWNLOAD_READ_PARALLEL:'3'});
    assert.equal(c.downloadReadParallel,3);assert.equal(c.downloadReadBuffers,12);assert.equal(c.downloadMaxParallel,24);assert.equal(c.downloadReadTimeoutSeconds,20);assert.equal(c.concurrency,2);
  }finally{assert.equal(path.dirname(directory),os.tmpdir());await rm(directory,{recursive:true,force:true})}
});
