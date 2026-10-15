import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Worker} from 'node:worker_threads';
import {FileTree} from '../src/file-tree.mjs';
import {Catalog} from '../src/catalog.mjs';
import {Shares} from '../src/shares.mjs';
import {Uploads} from '../src/uploads.mjs';
import {AssetCache} from '../src/assets.mjs';
import {SupabaseStore} from '../src/supabase.mjs';
import {createApp} from '../src/server.mjs';
import {config as readConfig} from '../src/config.mjs';
import {randomBytes} from 'node:crypto';

function fixture() {
  const rows = new Map(), reads = [];
  const store = {
    get(bucket,id) {reads.push(['get',bucket]);const value=rows.get(`${bucket}:${id}`);return value&&structuredClone(value);},
    list(bucket,owner) {reads.push(['list',bucket]);return [...rows.entries()].filter(([key,value])=>key.startsWith(`${bucket}:`)&&(owner===undefined||value.ownerId===owner)).map(([,value])=>structuredClone(value));},
    put(bucket,value) {rows.set(`${bucket}:${value.id}`,structuredClone(value));return value;},
    delete(bucket,id) {rows.delete(`${bucket}:${id}`);},transaction(fn){return fn();},
  };
  const file=(id,parentId,extra={})=>store.put('files',{id,parentId,ownerId:'7',kind:'folder',name:id,status:'active',generation:1,createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z',...extra});
  return {store,reads,file,catalog:new Catalog(store)};
}

test('deep catalogs use an iterative tree and reject cycles, orphaned paths and foreign parents',()=>{
  const files=Array.from({length:12000},(_,i)=>({id:String(i),parentId:i?String(i-1):undefined,ownerId:'7',status:'active'})).reverse();
  const tree=new FileTree(files,'7');assert.equal(tree.descendants('0').size,12000);assert.equal(tree.active(files[0]),true);assert.equal(tree.states.size,12000);
  const invalid=new FileTree([{id:'a',parentId:'b',ownerId:'7',status:'active'},{id:'b',parentId:'a',ownerId:'7',status:'active'},{id:'orphan',parentId:'missing',ownerId:'7',status:'active'},{id:'foreign',ownerId:'8',status:'active'}],'7');
  for(const file of invalid.files)assert.equal(invalid.active(file),false);
});

test('folder paths and storage dashboard read the catalog once, and nested trash remains visible',()=>{
  const {catalog,file,reads}=fixture();file('A');file('B','A');file('video','B',{kind:'file',mimeType:'video/mp4',size:123});file('deleted','B',{status:'trashed'});
  assert.deepEqual(catalog.list('7',new URLSearchParams({path:'/A/B'})).map(f=>f.id),['video']);
  assert.deepEqual(reads,[['list','files']]);reads.length=0;
  assert.equal(catalog.dashboard('7').summary.logicalBytes,123);assert.equal(reads.filter(([op,b])=>op==='list'&&b==='files').length,1);
  assert.deepEqual(catalog.list('7',new URLSearchParams({status:'trashed'})).map(f=>f.id),['deleted']);
  assert.equal(catalog.list('7',new URLSearchParams({scope:'drive',search:'video'}))[0].parentPath,'/A/B');
});

test('public playback checks ancestry without listing the drive, and spam revokes Node links permanently',()=>{
  const {catalog,file,store,reads}=fixture();file('root');const media=file('media','root',{kind:'file'});file('outside');
  const shares=new Shares(store,catalog,{publicUrl:'https://drive.test'}),share=shares.create('7','root',{});reads.length=0;
  assert.equal(shares.file({...share,ownerId:'7'},media.id).id,media.id);assert.equal(reads.some(([op,b])=>op==='list'&&b==='files'),false);
  assert.throws(()=>shares.file({...share,ownerId:'7'},'outside'),{code:'file_not_in_share'});
  catalog.spam('7','root');assert.ok(store.get('shares',share.id).revokedAt);
  catalog.restore('7','root');assert.ok(store.get('shares',share.id).revokedAt);
});

test('cleanup batches share a reference index and retain objects referenced by another account',async()=>{
  const {catalog,file,store,reads}=fixture();file('shared',undefined,{ownerId:'8',parts:[{objectId:'kept'}]});
  const removed=[],uploads=new Uploads(store,catalog,{remove:async(_user,part)=>removed.push(part.objectId)},{concurrency:2});
  for(let i=0;i<50;i++)store.put('cleanup',{id:String(i),ownerId:'7',part:{objectId:i?'unused-'+i:'kept'}});
  reads.length=0;await uploads.drainCleanup();assert.equal(removed.length,49);assert.equal(removed.includes('kept'),false);assert.equal(reads.filter(([op,b])=>op==='list'&&b==='files').length,1);
});

test('asset cache deduplicates concurrent reads, respects its limit and invalidates changed bytes',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'td-assets-'));try{
    const config={staticCacheBytes:8},cache=new AssetCache(config),filename=path.join(dir,'a.js');await writeFile(filename,'first');
    const entries=await Promise.all(Array.from({length:10},()=>cache.read(filename)));assert.equal(new Set(entries).size,1);assert.equal(cache.bytes,5);
    await writeFile(filename,'changed');const changed=await cache.read(filename);assert.notEqual(changed.etag,entries[0].etag);assert.equal(cache.bytes,7);
    config.staticCacheBytes=0;await cache.read(filename);assert.equal(cache.bytes,0);assert.equal(cache.entries.size,0);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('hashed interface assets can be cached and revalidated while HTML and API responses remain private',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'td-static-'));let app;
  try{
    const {mkdir}=await import('node:fs/promises');await mkdir(path.join(dir,'assets'));await writeFile(path.join(dir,'index.html'),'<html>test</html>');await writeFile(path.join(dir,'assets','demo-AbCdEfG1.js'),'console.log(1)');
    const config=readConfig({CONFIG_FILE:'none',DATA_KEY:randomBytes(32).toString('base64'),DATA_DIR:path.join(dir,'data'),STATIC_DIR:dir,STORAGE_BACKEND:'local',DEMO_AUTH:'true',PORT:'0'});
    app=createApp(config);await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${app.server.address().port}`;
    const first=await fetch(base+'/assets/demo-AbCdEfG1.js');assert.equal(first.headers.get('cache-control'),'public, max-age=31536000, immutable');assert.equal(await first.text(),'console.log(1)');
    const cached=await fetch(base+'/assets/demo-AbCdEfG1.js',{headers:{'If-None-Match':first.headers.get('etag')}});assert.equal(cached.status,304);assert.equal(await cached.text(),'');
    assert.equal((await fetch(base+'/files')).headers.get('cache-control'),'no-store');assert.equal((await fetch(base+'/api/config')).headers.get('cache-control'),'no-store');
  }finally{if(app)await app.close();await rm(dir,{recursive:true,force:true});}
});

test('a timed-out Supabase response cannot be mistaken for the next database request',()=>{
  let generation=0;
  const code=`const {parentPort,workerData}=require('node:worker_threads');parentPort.on('message',({request,control,output})=>{if(request.action==='slow')Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,200);const body=Buffer.from(JSON.stringify({value:request.action==='ready'?{layout:'v2'}:{id:request.id,generation:workerData.generation}}));new Uint8Array(output).set(body);const flags=new Int32Array(control);Atomics.store(flags,1,body.length);Atomics.store(flags,0,1);Atomics.notify(flags,0);});`;
  const store=new SupabaseStore({}, {timeoutMs:2000,workerFactory:()=>new Worker(code,{eval:true,execArgv:[],workerData:{generation:++generation}})});
  try{const old=store.control;store.timeoutMs=10;assert.throws(()=>store.rpc({action:'slow',id:'old'}),{code:'supabase_timeout'});assert.notEqual(store.control,old);store.timeoutMs=2000;assert.deepEqual(store.rpc({action:'get',id:'new'}),{id:'new',generation:2});}finally{store.close();}
});
