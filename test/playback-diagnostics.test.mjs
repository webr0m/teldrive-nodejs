import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {PlaybackDiagnostics,traceTransfer,recordTransferInput,recordTransferForwarded,recordPlaybackOutput} from '../src/playback-diagnostics.mjs';
import {mediaTracks,mediaFormat,progressParser} from '../src/media.mjs';
import {config} from '../src/config.mjs';
import {createApp} from '../src/server.mjs';
import {fixture} from './fixtures/managed-bots.mjs';
import {createMediaBalancer} from '../edge/media-balancer.mjs';

test('concurrent playback requests isolate bot counters, keep retry input separate and expose no credentials',async()=>{
  let now=1000;const stats=new PlaybackDiagnostics({},()=>now);let release;
  const gate=new Promise(resolve=>release=resolve);
  const a=stats.run('private-ticket-a',{mode:'original'},()=>traceTransfer({kind:'bot',id:'11',name:'Uno',username:'@uno_bot',tokenCiphertext:'SECRET'},async()=>{
    recordTransferInput(900);recordTransferForwarded(800);recordPlaybackOutput(800);await gate;recordTransferInput(300);recordTransferForwarded(200);recordPlaybackOutput(200);
  }));
  await stats.run('private-ticket-b',{mode:'video'},()=>traceTransfer({kind:'bot',id:'22',username:'dos_bot'},async()=>{recordTransferInput(70);recordPlaybackOutput(50)}));
  let first=stats.snapshot('private-ticket-a');assert.equal(first.activeRequests,1);assert.equal(first.sources[0].active,1);assert.equal(first.sources[0].username,'uno_bot');assert.equal(first.outputBytes,800);
  assert.equal(stats.snapshot('private-ticket-b').inputBytes,70);assert.equal(stats.snapshot('private-ticket-b').sources[0].botId,'22');
  now=2000;release();await a;first=stats.snapshot('private-ticket-a');assert.equal(first.outputBytes,1000);assert.equal(first.inputBytes,1200);assert.equal(first.sources[0].forwardedBytes,1000);assert.equal(first.activeRequests,0);assert.equal(first.streams[0].state,'completed');
  const serialized=JSON.stringify(first);assert.ok(!serialized.includes('SECRET'));assert.ok(!serialized.includes('private-ticket-a'));
  now=7000;assert.equal(stats.snapshot('private-ticket-a').sources[0].bytesPerSecond,0,'buffered playback cannot fabricate ongoing throughput');
});

test('real Telegram read retries attribute received data to the actual bot and retain exact output',async()=>{
  const f=fixture(),stats=new PlaybackDiagnostics({});
  f.store.put('bots',{id:'10002',ownerId:'7',enabled:true,username:'backup_bot',tokenCiphertext:'secret'});
  f.telegram.config.downloadBots=20;f.telegram.config.botAttempts=2;
  const data=randomBytes(512*1024+200),chunks=[];
  f.telegram.message=async()=>({message:{}});
  f.telegram.withBot=async(bot,fn)=>fn({async *iterDownload(_message,p){if(bot.id==='10001'&&p.offset>=512*1024)throw new Error('read failed');yield data.subarray(p.offset,p.offset+512*1024);yield data.subarray(p.offset+512*1024);}});
  await stats.run('ticket',{mode:'original'},()=>f.telegram.read('7',{channelId:'99'},3,data.length-3,async chunk=>{chunks.push(chunk);recordPlaybackOutput(chunk.length)}));
  assert.deepEqual(Buffer.concat(chunks),data.subarray(3));
  const result=stats.snapshot('ticket');assert.deepEqual(result.sources.map(s=>s.botId),['10001','10002']);assert.equal(result.sources[0].failures,1);assert.equal(result.sources[1].failures,0);assert.equal(result.outputBytes,data.length-3);assert.ok(result.inputBytes>result.outputBytes);assert.equal(result.streams[0].sourceIds.length,2);
});

test('diagnostic retention is bounded, preserves cumulative totals and can be disabled',async()=>{
  let now=1000;const c={playbackDiagnosticsMaxSessions:1,playbackDiagnosticsTtlSeconds:30};const d=new PlaybackDiagnostics(c,()=>now);
  for(let i=0;i<70;i++)await d.run('one',{mode:'original'},async()=>recordPlaybackOutput(10));
  assert.equal(d.snapshot('one').streams.length,64);assert.equal(d.snapshot('one').outputBytes,700);
  await d.run('two',{mode:'original'},async()=>recordPlaybackOutput(2));assert.equal(d.sessions.size,1);assert.equal(d.snapshot('one').requests,0);
  now+=31000;assert.equal(d.snapshot('two').requests,0);assert.equal(d.sessions.size,0);
  c.playbackDiagnosticsEnabled=0;await d.run('disabled',{mode:'original'},async()=>recordPlaybackOutput(55));assert.equal(d.snapshot('disabled').enabled,false);assert.equal(d.sessions.size,0);
});

test('metadata and progress whitelist technical fields and never return ffprobe input URLs',()=>{
  const tracks=mediaTracks({streams:[{index:1,codec_type:'video',codec_name:'h264',width:1920,height:1080,avg_frame_rate:'24000/1001',tags:{title:'Video',filename:'SECRET'}}]});assert.equal(tracks[0].width,1920);assert.ok(!JSON.stringify(tracks).includes('SECRET'));
  const format=mediaFormat({format:{filename:'https://example/playback?ticket=SECRET',duration:'60.5',bit_rate:'1200000',format_name:'matroska'}});assert.equal(format.duration,60.5);assert.ok(!JSON.stringify(format).includes('SECRET'));
  const changes=[],parse=progressParser(value=>changes.push(value));parse('fps=24\nspeed=1.5');parse('x\nout_time_us=1000000\nfilename=SECRET\nprogress=continue\n');assert.equal(changes[0].speed,1.5);assert.equal(changes[0].out_time_us,1000000);assert.ok(!JSON.stringify(changes).includes('SECRET'));
});

test('HTTP diagnostics require the owning session, validate revocation, and report actual local range reads',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'td-diagnostics-'));let app;
  try{
    const c=config({CONFIG_FILE:'none',DATA_KEY:randomBytes(32).toString('base64'),DATA_DIR:directory,STORAGE_BACKEND:'local',MEDIA_ENABLED:'false',PORT:'0',OWNER_USER_ID:'1'});
    app=createApp(c);await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${app.server.address().port}`;
    const own=app.context.auth.finish({id:1}),other=app.context.auth.finish({id:2});for(const pair of [own,other])app.context.auth.publish(pair,{},false);
    const headers=pair=>({Authorization:`Bearer ${pair.accessToken}`});
    const filename=path.join(directory,'sample.bin');await writeFile(filename,Buffer.alloc(1024));const part=await app.context.storage.put('1',filename,1024,false);
    const file=app.context.catalog.create('1',{name:'sample.mp4'},'file',{size:1024,mimeType:'video/mp4',parts:[{...part,partNo:1}]});
    const grant=await(await fetch(`${origin}/api/v1/files/${file.id}/playback`,{method:'POST',headers:headers(own)})).json();
    const endpoint=`${origin}/api/v1/playback/diagnostics?ticket=${grant.ticket}`;
    assert.equal((await fetch(endpoint)).status,401);assert.equal((await fetch(endpoint,{headers:headers(other)})).status,403);
    const stream=await fetch(`${origin}/api/v1/playback?ticket=${grant.ticket}`,{headers:{Range:'bytes=10-109'}});assert.equal((await stream.arrayBuffer()).byteLength,100);
    const response=await fetch(endpoint,{headers:headers(own)});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');const data=await response.json();
    assert.equal(data.nodes[0].inputBytes,100);assert.equal(data.nodes[0].outputBytes,100);assert.equal(data.nodes[0].sources[0].kind,'local');assert.equal(data.nodes[0].streams[0].rangeStart,10);assert.equal(data.nodes[0].streams[0].state,'completed');assert.ok(!JSON.stringify(data).includes(grant.ticket));
    const share=app.context.shares.create('1',file.id,{}),publicGrant=app.context.playback.create(file,undefined,app.context.store.get('shares',share.id));
    assert.equal((await fetch(`${origin}/api/v1/playback/diagnostics?ticket=${publicGrant.ticket}`,{headers:headers(own)})).status,403);
    app.context.store.transaction(()=>{const session=app.context.store.list('sessions','1')[0];session.revokedAt=new Date().toISOString();app.context.store.put('sessions',session)});
    assert.equal((await fetch(endpoint,{headers:headers(own)})).status,401);
  }finally{await app?.close();if(path.dirname(directory)!==os.tmpdir()||!path.basename(directory).startsWith('td-diagnostics-'))throw new Error('Invalid cleanup path');await rm(directory,{recursive:true,force:true});}
});

test('edge merges both authorized node snapshots and refuses unauthorized fan-out',async()=>{
  const env={PUBLIC_ORIGIN:'https://cloud.example',MEDIA_NODE_ENABLED:'true',MEDIA_NODE_ORIGIN:'https://pc.example',MEDIA_NODE_SECRET:'s'.repeat(43)};
  const calls=[];let deny=false,offline=false;
  const balancer=createMediaBalancer({fetch:async request=>{
    calls.push(request);const secondary=request.url.startsWith(env.MEDIA_NODE_ORIGIN);
    if(!secondary&&deny)return new Response('{}',{status:401});
    if(secondary){assert.equal(request.headers.get('X-Teldrive-Media-Node'),env.MEDIA_NODE_SECRET);if(offline)throw new Error('offline');}
    return Response.json({file:{parts:1},nodes:[{role:secondary?'secondary':'primary',outputBytes:secondary?20:10}]});
  }});
  const request=()=>new Request(`${env.PUBLIC_ORIGIN}/api/v1/playback/diagnostics?ticket=example`,{headers:{Cookie:'session=example'}});
  const result=await(await balancer.fetch(request(),env)).json();assert.equal(result.nodes.length,2);assert.equal(calls.length,2);assert.equal(calls[0].headers.has('X-Teldrive-Media-Node'),false);assert.ok(!JSON.stringify(result).includes(env.MEDIA_NODE_SECRET));
  deny=true;calls.length=0;assert.equal((await balancer.fetch(request(),env)).status,401);assert.equal(calls.length,1);
  deny=false;offline=true;const degraded=await(await balancer.fetch(request(),env)).json();assert.deepEqual(degraded.unavailableNodes,['secondary']);assert.equal(degraded.nodes.length,1);
});
