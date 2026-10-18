import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSessionTransport} from '../ui/src/api/session-transport.ts';
import {retryUploadPart,abortableDelay} from '../ui/src/features/uploads/retry.ts';

test('parallel and late 401 responses share one refresh and replay their original bodies',async()=>{
  let refreshes=0;const attempts=new Map();
  const transport=createSessionTransport(async(input,init)=>{
    const req=input instanceof Request?input:new Request(input,init),p=new URL(req.url).pathname;
    if(p.endsWith('/refresh')){refreshes++;return new Response('{}');}
    const attempt=(attempts.get(p)||0)+1;attempts.set(p,attempt);assert.equal(await req.text(),'payload');
    if(attempt===1){if(p.endsWith('/late'))await new Promise(resolve=>setTimeout(resolve,30));return new Response('{}',{status:401});}
    return new Response('ok');
  },'https://drive.test');
  const results=await Promise.all(['/api/v1/fast','/api/v1/late'].map(p=>transport.request(p,{method:'POST',body:'payload'})));
  assert.equal(refreshes,1);assert.ok(results.every(r=>r.status===200));
});

test('public share failures do not refresh a private session; Blob uploads need no stream clone',async()=>{
  let refreshes=0,clones=0;const original=Request.prototype.clone;Request.prototype.clone=function(){clones++;return original.call(this)};
  try{
    const transport=createSessionTransport(async(input)=>{const req=input instanceof Request?input:new Request(input);if(req.url.includes('refresh'))refreshes++;return new Response('{}',{status:req.url.includes('/public/')?401:200});},'https://drive.test');
    assert.equal((await transport.request('/api/v1/public/shares/example')).status,401);
    assert.equal((await transport.request('/api/v1/uploads/part',{method:'PUT',body:new Blob([new Uint8Array(2*1024*1024)])})).status,200);
    assert.equal(refreshes,0);assert.equal(clones,0);
  }finally{Request.prototype.clone=original;}
});

test('upload fragments recover expired access and temporary overload without retrying invalid data',async()=>{
  let calls=0,refreshes=0;const delays=[],statuses=[401,429,503,200],signal=new AbortController().signal;
  const result=await retryUploadPart(async()=>{const status=statuses[calls++];if(status!==200)throw{status};return'uploaded'},signal,async()=>{refreshes++;return true},5,async ms=>{delays.push(ms)});
  assert.equal(result,'uploaded');assert.equal(refreshes,1);assert.deepEqual(delays,[1000,2000]);
  calls=0;await assert.rejects(()=>retryUploadPart(async()=>{calls++;throw{status:422}},signal,async()=>true,5,async()=>{}));assert.equal(calls,1);
  calls=0;await assert.rejects(()=>retryUploadPart(async()=>{calls++;throw{status:503}},signal,async()=>true,1,async()=>{}));assert.equal(calls,2);
  const controller=new AbortController(),waiting=abortableDelay(10000,controller.signal);controller.abort();await assert.rejects(waiting,{name:'AbortError'});
});

test('owner playback statistics refresh private authentication while public media tickets do not',async()=>{
  let refreshes=0,reads=0;const transport=createSessionTransport(async input=>{
    const url=String(input.url||input);if(url.endsWith('/refresh')){refreshes++;return new Response('{}');}
    reads++;return new Response('{}',{status:reads===1?401:200});
  },'https://drive.test');
  assert.equal((await transport.request('/api/v1/playback/diagnostics?ticket=private')).status,200);assert.equal(refreshes,1);
});
