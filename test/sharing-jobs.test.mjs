import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store,hash,token,now,expires} from '../src/core.mjs';
import {Catalog} from '../src/catalog.mjs';
import {Shares} from '../src/shares.mjs';
import {Jobs} from '../src/jobs.mjs';
import {Uploads} from '../src/uploads.mjs';
import {createApp} from '../src/server.mjs';
import {config} from '../src/config.mjs';

async function fixture() {
  const dir=await mkdtemp(path.join(os.tmpdir(),'td-sharing-'));
  const settings=config({CONFIG_FILE:'none',DATA_KEY:randomBytes(32).toString('base64'),STORAGE_BACKEND:'local',DATA_DIR:dir,MEDIA_ENABLED:'false',PORT:'0',RATE_LIMIT_PER_MINUTE:'10000'});
  return {dir,settings,async remove(){await rm(dir,{recursive:true,force:true});}};
}

test('sharing is recoverable across restarts, deduplicated by policy and compatible with original hash-only links',async()=>{
  const f=await fixture();let store=new Store(f.dir);
  try {
    let catalog=new Catalog(store),shares=new Shares(store,catalog,f.settings);
    const folder=catalog.create('1',{name:'Compartir'}),first=shares.create('1',folder.id,{});
    assert.match(first.token,/^[A-Za-z0-9_-]{43}$/);assert.equal(first.publicUrl.split('/').at(-1),first.token);
    for(let i=0;i<5;i++){const next=shares.create('1',folder.id,{});assert.equal(next.id,first.id);assert.equal(next.token,first.token);}
    assert.equal(store.list('shares').length,1);
    store.close();store=new Store(f.dir);catalog=new Catalog(store);shares=new Shares(store,catalog,f.settings);
    assert.equal(shares.summary(store.get('shares',first.id)).publicUrl,first.publicUrl);
    const oldToken=token(),record=store.get('shares',first.id);record.tokenHash=hash(oldToken);store.put('shares',record);
    assert.equal(shares.resolve(oldToken).id,first.id);assert.equal(shares.resolve(first.token).id,first.id);
    assert.equal(shares.create('1',folder.id,{}).id,first.id);assert.equal(store.list('shares').length,1);
    const protectedLink=shares.create('1',folder.id,{password:'secret',maxDownloads:2});
    assert.equal(shares.create('1',folder.id,{password:'secret',maxDownloads:2}).id,protectedLink.id);
    assert.throws(()=>shares.resolve(protectedLink.token),{status:401});assert.equal(shares.resolve(protectedLink.token,'secret').id,protectedLink.id);
    const limited=store.get('shares',protectedLink.id);limited.downloadCount=2;store.put('shares',limited);
    assert.throws(()=>shares.resolve(protectedLink.token,'secret'),{status:410});
    record.revokedAt=now();store.put('shares',record);
    assert.throws(()=>shares.resolve(oldToken),{status:404});assert.throws(()=>shares.resolve(first.token),{status:404});
    assert.notEqual(shares.create('1',folder.id,{}).id,first.id);
  } finally {store.close();await f.remove();}
});

test('account grants enforce inherited access, owner boundaries, upload rights, private view state and playback revocation',async()=>{
  const f=await fixture(),app=createApp(f.settings);
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${app.server.address().port}/api`;
  const credentials=new Map();for(const id of [1,2,3]){const pair=app.context.auth.finish({id,firstName:`User ${id}`});app.context.auth.publish(pair,{},false);credentials.set(id,pair.accessToken);}
  const req=(actor,url,method='GET',body)=>fetch(base+url,{method,headers:{...(actor?{Authorization:`Bearer ${credentials.get(actor)}`} : {}),...(body?{'Content-Type':Buffer.isBuffer(body)?'application/octet-stream':'application/json'}:{})},body:body===undefined?undefined:Buffer.isBuffer(body)?body:JSON.stringify(body)});
  try {
    const folder=app.context.catalog.create('1',{name:'Compartida'}),nested=app.context.catalog.create('1',{name:'Dentro',parentId:folder.id}),outside=app.context.catalog.create('1',{name:'Privada'});
    const publicLink=await(await req(1,`/v1/files/${folder.id}/shares`,'POST',{})).json();
    const listed=await(await req(1,`/v1/files/${folder.id}/shares`)).json();assert.equal(listed.items[0].publicUrl,publicLink.publicUrl);
    assert.equal((await req(2,`/v1/files/${folder.id}/shares`)).status,404);assert.equal((await req(null,`/v1/files/${folder.id}/shares`)).status,401);
    const grant=await(await req(1,`/v1/files/${folder.id}/grants`,'POST',{granteeUserId:2})).json();assert.ok(grant.id);
    assert.equal((await(await req(2,'/v1/shared/with-me')).json())[0].file.id,folder.id);
    assert.equal((await req(2,`/v1/files?parentId=${folder.id}`)).status,200);
    assert.equal((await req(2,`/v1/files/${nested.id}`)).status,200);
    assert.equal((await req(3,`/v1/files/${nested.id}`)).status,404);
    assert.equal((await req(2,`/v1/files?parentId=${folder.id}&scope=drive`)).status,422);
    assert.equal((await req(2,`/v1/files?parentId=${folder.id}&status=trashed`)).status,422);
    assert.equal((await req(2,`/v1/files/${nested.id}`,'PATCH',{name:'No'})).status,404);
    assert.equal((await req(2,'/v1/folders','POST',{name:'No',parentId:folder.id})).status,404);
    assert.equal((await req(2,`/v1/files/${folder.id}/grants`,'POST',{granteeUserId:3})).status,404);
    assert.equal((await req(2,`/v1/grants/${grant.id}`,'PATCH',{permission:'edit'})).status,404);
    assert.equal((await req(1,`/v1/grants/${grant.id}`,'PATCH',{permission:'edit'})).status,200);
    assert.equal((await req(2,`/v1/files/${nested.id}`,'PATCH',{name:'Renombrada'})).status,200);
    assert.equal((await req(2,`/v1/files/${nested.id}/move`,'POST',{parentId:outside.id})).status,404);
    assert.equal((await req(2,`/v1/files/${nested.id}/move`,'POST',{})).status,403);
    const bytes=Buffer.from('Subido por colaborador'),u=await(await req(2,'/v1/uploads','POST',{parentId:folder.id,name:'texto.txt',size:bytes.length})).json();
    assert.equal((await req(2,`/v1/uploads/${u.id}/parts/1`,'PUT',bytes)).status,201);
    const uploaded=await(await req(2,`/v1/uploads/${u.id}/complete`,'POST')).json();assert.ok(uploaded.id);assert.equal(app.context.store.get('files',uploaded.id).ownerId,'1');
    assert.deepEqual(Buffer.from(await(await req(2,`/v1/files/${uploaded.id}/content`)).arrayBuffer()),bytes);
    assert.equal((await req(2,`/v1/files/${uploaded.id}/view-state`,'PUT',{kind:'text',position:{page:3}})).status,200);
    assert.equal((await req(1,`/v1/files/${uploaded.id}/view-state`)).status,204);
    const ticket=await(await req(2,`/v1/files/${uploaded.id}/playback`,'POST')).json();assert.ok(ticket.ticket);
    assert.equal((await req(2,`/v1/shared/spam/${folder.id}`,'POST')).status,204);
    assert.equal((await req(2,`/v1/files/${uploaded.id}/content`)).status,404);
    assert.equal((await(await req(2,'/v1/shared/spam')).json())[0].id,folder.id);
    assert.equal((await(await req(2,'/v1/shared/with-me')).json()).length,0);
    assert.equal((await req(null,`/v1/playback?ticket=${ticket.ticket}`)).status,404);
    assert.equal((await req(2,`/v1/shared/spam/${folder.id}`,'DELETE')).status,204);
    assert.equal((await req(2,`/v1/files/${uploaded.id}/content`)).status,200);
    assert.equal((await req(1,`/v1/grants/${grant.id}`,'DELETE')).status,204);
    assert.equal((await req(2,`/v1/files/${uploaded.id}/content`)).status,404);
    assert.equal((await req(null,`/v1/playback?ticket=${ticket.ticket}`)).status,404);
  } finally {await app.close();await f.remove();}
});

test('maintenance jobs execute bounded owner-only batches, pause, cancel, retry and recover exclusive leases',async()=>{
  const f=await fixture(),store=new Store(f.dir),cleaned=[];
  const uploads={catalog:{all:()=>[]},async abort(userId,id){cleaned.push([userId,id]);store.put('uploads',{...store.get('uploads',id),state:'aborted'});}};
  const jobs=new Jobs(store,uploads,f.settings);jobs.wake=()=>{};
  try {
    for(const [ownerId,id] of [['1','expired-a'],['1','expired-b'],['2','foreign']])store.put('uploads',{id,ownerId,state:'open',expiresAt:expires(-1000)});
    store.put('uploads',{id:'live',ownerId:'1',state:'open',expiresAt:expires(10000)});
    jobs.pause('1','maintenance',true);const first=jobs.create('1',{type:'teldrive_upload_cleanup',args:{batchSize:1}});
    await jobs.run();assert.equal(cleaned.length,0);
    assert.throws(()=>jobs.get('2',first.id),{status:404});jobs.pause('1','maintenance',false);await jobs.run();
    assert.equal(cleaned.length,1);assert.equal(cleaned[0][0],'1');assert.equal(jobs.get('1',first.id).output.remaining,1);assert.equal(jobs.get('1',first.id).status,'completed');
    const queued=jobs.create('1',{type:'teldrive_upload_cleanup',args:{}});jobs.cancel('1',queued.id);await jobs.run();assert.equal(cleaned.length,1);
    jobs.retry('1',queued.id);await jobs.run();assert.equal(cleaned.length,2);assert.equal(jobs.statistics('1').completed,2);
    const leased=jobs.create('1',{type:'teldrive_upload_cleanup',args:{}});
    assert.ok(store.claimJob(leased.id,'a',30));assert.equal(store.claimJob(leased.id,'b',30),undefined);assert.equal(store.claimJob(leased.id,'a',30).attempt,1);
    const crashed=store.get('jobs',leased.id);crashed.leaseExpiresAt=expires(-1);store.put('jobs',crashed);assert.equal(store.claimJob(leased.id,'b',30).attempt,2);
    jobs.cancel('1',leased.id);assert.equal(store.claimJob(leased.id,'b',30),undefined);
    assert.throws(()=>jobs.create('1',{type:'shell',args:{}}),{status:422});assert.throws(()=>jobs.create('1',{type:'teldrive_upload_cleanup',args:{batchSize:10001}}),{status:422});
  }finally{await jobs.close();store.close();await f.remove();}
});

test('pending-file maintenance honors retention and never purges active, recent or foreign files',async()=>{
  const f=await fixture(),store=new Store(f.dir),catalog=new Catalog(store),removed=[];
  const uploads=new Uploads(store,catalog,{async remove(owner,part){removed.push([owner,part.objectId]);}},f.settings);
  const jobs=new Jobs(store,uploads,f.settings);jobs.wake=()=>{};
  try {
    const old=new Date(Date.now()-40*86400_000).toISOString();
    const expiredFile=catalog.create('1',{name:'Pending old'},'file',{status:'deletion_pending',updatedAt:old,size:1,parts:[{objectId:'old-part'}]});
    const recent=catalog.create('1',{name:'Pending recent'},'file',{status:'deletion_pending',size:1,parts:[]});
    const active=catalog.create('1',{name:'Active'},'file',{size:1,parts:[]});
    const foreign=catalog.create('2',{name:'Other owner'},'file',{status:'deletion_pending',updatedAt:old,size:1,parts:[]});
    const job=jobs.create('1',{type:'teldrive_pending_file_purge',args:{}});await jobs.run();
    assert.equal(jobs.get('1',job.id).status,'completed');assert.equal(jobs.get('1',job.id).output.processed,1);
    assert.equal(store.get('files',expiredFile.id),undefined);for(const file of [recent,active,foreign])assert.ok(store.get('files',file.id));
    assert.deepEqual(removed,[['1','old-part']]);
  }finally{await jobs.close();store.close();await f.remove();}
});
