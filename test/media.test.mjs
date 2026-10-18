import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Media } from '../src/media.mjs';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { config } from '../src/config.mjs';
import { createApp } from '../src/server.mjs';
const require = createRequire(import.meta.url), ffmpeg=require('ffmpeg-static'), ffprobe=require('@derhuerst/ffprobe-static');
test('real media probe and conversion select video and audio streams through authenticated file tickets', { skip: !existsSync(ffmpeg) || !existsSync(ffprobe) }, async () => {
  const directory=await mkdtemp(path.join(os.tmpdir(),'td-media-'));
  let app;
  try {
    const filename=path.join(directory,'two-tracks.mkv');
    const generated=spawnSync(ffmpeg,['-v','error','-f','lavfi','-i','color=c=red:s=160x90:r=10:d=1','-f','lavfi','-i','color=c=blue:s=96x64:r=10:d=1','-f','lavfi','-i','sine=frequency=440:sample_rate=44100:duration=1','-f','lavfi','-i','sine=frequency=880:sample_rate=48000:duration=1','-map','0:v','-map','1:v','-map','2:a','-map','3:a','-c:v','libx264','-threads','1','-c:a','aac','-metadata:s:a:0','language=spa','-metadata:s:a:1','language=eng','-y',filename],{windowsHide:true});
    assert.equal(generated.status,0,generated.stderr?.toString());
    const c=config({CONFIG_FILE:'none',DATA_KEY:randomBytes(32).toString('base64'),DATA_DIR:directory,STORAGE_BACKEND:'local',DEMO_AUTH:'true',PORT:'0',MEDIA_ENABLED:'true',MEDIA_MAX_WIDTH:'1280'});
    app=createApp(c); await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve)); c.publicUrl=`http://127.0.0.1:${app.server.address().port}`;
    const login=await fetch(`${c.publicUrl}/api/dev/login`,{method:'POST'}), cookie=login.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ');
    const data=await readFile(filename), part=await app.context.storage.put('1',filename,data.length,false);
    const file=app.context.catalog.create('1',{name:'tracks.mkv'},'file',{size:data.length,mimeType:'video/x-matroska',parts:[{...part,partNo:1}]});
    const grant=await (await fetch(`${c.publicUrl}/api/v1/files/${file.id}/playback`,{method:'POST',headers:{Cookie:cookie}})).json(); assert.equal(grant.conversionAvailable,true);
    const [tracksResponse,duplicateProbe]=await Promise.all([1,2].map(()=>fetch(`${c.publicUrl}/api/v1/playback/tracks?ticket=${grant.ticket}`))); assert.equal(tracksResponse.status,200); assert.equal(duplicateProbe.status,200,'concurrent viewers share the same probe instead of exhausting the sole slot');
    const {tracks}=await tracksResponse.json(); assert.equal(tracks.filter(t=>t.kind==='video').length,2); assert.equal(tracks.filter(t=>t.kind==='audio').length,2); assert.ok(tracks.some(t=>t.language==='spa'));
    const chosenVideo=tracks.filter(t=>t.kind==='video')[1], chosenAudio=tracks.filter(t=>t.kind==='audio')[1];
    const stream=await fetch(`${c.publicUrl}/api/v1/playback?ticket=${grant.ticket}&mode=video&video=${chosenVideo.index}&audio=${chosenAudio.index}`); assert.equal(stream.status,200); assert.equal(stream.headers.get('content-type'),'video/mp4');
    const converted=path.join(directory,'converted.mp4'); await writeFile(converted,Buffer.from(await stream.arrayBuffer()));
    const inspected=spawnSync(ffprobe,['-v','error','-show_streams','-of','json',converted],{windowsHide:true}); assert.equal(inspected.status,0);
    const output=JSON.parse(inspected.stdout).streams;
    const diagnostics=await(await fetch(`${c.publicUrl}/api/v1/playback/diagnostics?ticket=${grant.ticket}`,{headers:{Cookie:cookie}})).json();
    const conversion=diagnostics.nodes[0].streams.find(s=>s.mode==='video');
    assert.equal(conversion.conversion.video,'copy');assert.equal(typeof conversion.conversion.speed,'number');
    assert.ok(diagnostics.nodes[0].streams.some(s=>s.purpose==='probe'));assert.ok(diagnostics.nodes[0].streams.some(s=>s.purpose==='conversion-input'));
    assert.ok(diagnostics.nodes[0].inputBytes>0);assert.ok(diagnostics.nodes[0].outputBytes>0);assert.equal(diagnostics.metadata.tracks.length,4);assert.ok(!JSON.stringify(diagnostics).includes(grant.ticket));
    assert.equal(output.find(s=>s.codec_type==='video').width,96); assert.equal(output.find(s=>s.codec_type==='video').height,64); assert.equal(output.find(s=>s.codec_type==='audio').sample_rate,'48000');
    const packetHashes = (filename, stream) => JSON.parse(spawnSync(ffprobe,['-v','error','-select_streams',stream,'-show_packets','-show_data_hash','sha256','-show_entries','packet=data_hash','-of','json',filename],{windowsHide:true}).stdout).packets.map(p=>p.data_hash);
    assert.deepEqual(packetHashes(converted,'v:0'),packetHashes(filename,'v:1'),'compatible H.264 packets are preserved without CPU-heavy re-encoding');
    c.mediaCopyVideo=0; c.mediaMaxWidth=128;
    const scaled=await fetch(`${c.publicUrl}/api/v1/playback?ticket=${grant.ticket}&mode=video&video=0`), scaledFile=path.join(directory,'scaled.mp4');
    assert.equal(scaled.status,200); await writeFile(scaledFile,Buffer.from(await scaled.arrayBuffer()));
    const scaledStreams=JSON.parse(spawnSync(ffprobe,['-v','error','-show_streams','-of','json',scaledFile],{windowsHide:true}).stdout).streams;
    assert.equal(scaledStreams.find(s=>s.codec_type==='video').width,128,'administrators can require re-encoding with a width limit');
    assert.equal((await fetch(`${c.publicUrl}/api/v1/playback?ticket=${grant.ticket}&mode=video&audio=${chosenVideo.index}`)).status,422);
    let nestedRequests=0; app.server.on('request',req=>{if(req.url.includes('/nested-playlist-canary'))nestedRequests++;});
    const playlist=path.join(directory,'blocked.m3u8'), bytes=Buffer.from(`#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n${c.publicUrl}/nested-playlist-canary.ts\n#EXT-X-ENDLIST\n`);
    await writeFile(playlist,bytes); const stored=await app.context.storage.put('1',playlist,bytes.length,false);
    const blocked=app.context.catalog.create('1',{name:'blocked.m3u8'},'file',{size:bytes.length,parts:[{...stored,partNo:1}]});
    const blockedGrant=app.context.playback.create(blocked);
    await assert.rejects(()=>app.context.media.tracks(blockedGrant.ticket),{code:'media_probe_failed'}); assert.equal(nestedRequests,0,'uploaded playlists cannot fetch another URL');
    // A secondary must feed FFmpeg through its protected loopback listener,
    // without sending its internal secret to the public origin.
    const localOrigin = c.publicUrl;
    c.mediaNode = true; c.mediaNodeSecret = randomBytes(32).toString('base64url'); c.port = app.server.address().port;
    c.publicUrl = 'https://unreachable.example.invalid'; app.context.media.cache.clear();
    const nodeHeaders = { 'X-Teldrive-Media-Node': c.mediaNodeSecret };
    const localTracks = await fetch(`${localOrigin}/api/v1/playback/tracks?ticket=${grant.ticket}`, { headers: nodeHeaders });
    assert.equal(localTracks.status, 200); assert.equal((await localTracks.json()).tracks.length, 4);
    const localVideo = await fetch(`${localOrigin}/api/v1/playback?ticket=${grant.ticket}&mode=video`, { headers: nodeHeaders });
    assert.equal(localVideo.status, 200); assert.ok((await localVideo.arrayBuffer()).byteLength > 100);
    const publicGrant = app.context.playback.create(file, undefined, { id: 'counter-on-primary' });
    assert.throws(() => app.context.playback.resolve(publicGrant.ticket), { code: 'media_node_share_pinned' });
  } finally { if(app) await app.close(); await rm(directory,{recursive:true,force:true}); }
});

test('closing a backpressured video releases the multimedia slot for the next playback', async () => {
  const directory=await mkdtemp(path.join(os.tmpdir(),'td-media-abort-'));
  const child=new EventEmitter(); child.stdout=new PassThrough(); child.stderr=new PassThrough();
  let killed=false;
  child.kill=()=>{if(!killed){killed=true;child.stdout.end();queueMicrotask(()=>child.emit('close',null,'SIGKILL'));}};
  const media=new Media({dataDir:directory,mediaConcurrency:1,mediaTimeoutSeconds:10},null,{spawn:()=>child});
  const res=new EventEmitter(); res.setHeader=()=>{}; res.destroyed=false;
  let blocked; const backpressure=new Promise(resolve=>{blocked=resolve}); res.write=()=>{blocked();return false};
  try {
    const running=media.transfers.run(()=>media.pipe({res},[],'video/mp4'));
    child.stdout.write(Buffer.alloc(65536)); await backpressure;
    res.destroyed=true;res.emit('close');
    await Promise.race([running,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('abandoned stream retained its slot')),1000);timer.unref()})]);
    assert.equal(killed,true);assert.equal(media.transfers.active,0);
    assert.equal(await media.transfers.run(()=>42),42);
  } finally {child.kill();await rm(directory,{recursive:true,force:true})}
});
