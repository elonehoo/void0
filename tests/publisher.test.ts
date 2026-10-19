import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {canonicalJson,contentSha256,servicePolicyHash,verifyRelease} from '../server/releases.js';
import {createPublisherApp,Publisher,PublisherClient,type PublishedService,type PublisherConfig} from '../server/publisher.js';
import {Store} from '../server/store.js';
import {JobManager} from '../server/jobs.js';
import type {RemoteTransport,SignedRelease} from '../shared/types.js';

const keys=generateKeyPairSync('ed25519',{privateKeyEncoding:{format:'pem',type:'pkcs8'},publicKeyEncoding:{format:'pem',type:'spki'}});
const date='2026-10-19T00:00:00.000Z',commit='a'.repeat(40),token='test-publisher-token-which-is-long-enough';
function entry():PublishedService{return {
  repository:'example/web',branch:'main',imageRepository:'registry.example/apps/web',
  server:{id:'server',name:'Server',host:'example.com',port:22,username:'ubuntu',group:'Test',notes:'',connectionMode:'agent',createdAt:date,updatedAt:date},
  service:{id:'web',name:'Web',kind:'image',serverId:'server',target:{},repository:'https://github.com/example/web',branch:'main',containerPort:8080,hostPort:18081,environment:{},volumes:[],autoDeploy:true,createdAt:date,updatedAt:date}
};}
function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'serverdesk-publisher-test-'));
  const config:PublisherConfig={version:1,keyId:'publisher-v1',services:[entry()]};
  let builds=0;
  const options={dataDirectory:directory,privateKey:keys.privateKey,apiToken:token,config:async()=>structuredClone(config),commit:async()=>commit,build:async()=>{builds++;return 'registry.example/apps/web@sha256:'+'1'.repeat(64);}};
  return {directory,config,options,get builds(){return builds;},clean:()=>rmSync(directory,{recursive:true,force:true})};
}

test('canonical release encoding is deterministic and rejects ambiguous JSON',()=>{
  assert.equal(canonicalJson({z:'中文😀',a:[1,null,true]}),'{"a":[1,null,true],"z":"中文😀"}');
  for(const value of [undefined,NaN,0.1,2**53,{x:undefined},{'名字':'x'},'\ud800'])assert.throws(()=>canonicalJson(value));
  assert.equal(contentSha256({b:1,a:2}),contentSha256({a:2,b:1}));
});

test('independent publisher signs immutable image and complete target, reuses durable request after restart',async()=>{
  const f=fixture();try {
    const publisher=new Publisher(f.options);
    const release=await publisher.publish('web','job-one');
    const manifest=verifyRelease(release,keys.publicKey);
    assert.equal(manifest.repository,'example/web');assert.equal(manifest.commit,commit);assert.equal(manifest.sequence,1);
    assert.match(release.payload.plan.service.image!,/@sha256:/);
    assert.equal(release.payload.plan.repository,undefined);
    assert.deepEqual(await new Publisher(f.options).publish('web','job-one'),release);
    const next=await publisher.publish('web','job-two');assert.equal(verifyRelease(next,keys.publicKey).sequence,2);assert.equal(f.builds,1);
  }finally{f.clean();}
});

test('image, mount, port, environment, server or signature changes invalidate publication',async()=>{
  const f=fixture();try{
    const release=await new Publisher(f.options).publish('web','job');
    const attacks:Array<(r:SignedRelease)=>void>=[r=>r.payload.plan.service.image='evil/image:latest',r=>r.payload.plan.service.volumes=[{name:'host-root',mountPath:'/'}],r=>r.payload.plan.service.hostPort=22,r=>r.payload.plan.service.environment={SECRET:'stolen'},r=>r.payload.plan.server.id='other',r=>r.authorization.signature=Buffer.alloc(64).toString('base64')];
    for(const attack of attacks){const changed=structuredClone(release);attack(changed);assert.throws(()=>verifyRelease(changed,keys.publicKey));}
    const expiration=verifyRelease(release,keys.publicKey).expiresAt;
    assert.throws(()=>verifyRelease(release,keys.publicKey,expiration));
    const other=generateKeyPairSync('ed25519');assert.throws(()=>verifyRelease(release,other.publicKey.export({type:'spki',format:'pem'}).toString()));
  }finally{f.clean();}
});

test('publisher cannot be asked to choose a repository, image, server or arbitrary service',async()=>{
  const f=fixture(),{app}=await createPublisherApp(f.options);
  try{
    assert.equal((await app.inject({method:'POST',url:'/v1/releases',payload:{serviceId:'web',jobId:'job'}})).statusCode,401);
    const headers={Authorization:'Bearer '+token};
    for(const extra of [{image:'evil:latest'},{repository:'evil/repo'},{serverId:'other'},{plan:{}}])assert.equal((await app.inject({method:'POST',url:'/v1/releases',headers,payload:{serviceId:'web',jobId:'job',...extra}})).statusCode,400);
    assert.equal((await app.inject({method:'POST',url:'/v1/releases',headers,payload:{serviceId:'unknown',jobId:'job'}})).statusCode,400);
    assert.equal((await app.inject({method:'POST',url:'/v1/releases',headers,payload:{serviceId:'web',jobId:'job'}})).statusCode,200);
  }finally{await app.close();f.clean();}
});

test('trusted service policy changes require a new node policy, image revisions do not',()=>{
  const original=entry().service,hash=servicePolicyHash(original);
  assert.equal(servicePolicyHash({...original,image:'registry.example/apps/web@sha256:'+'1'.repeat(64),lastCommit:commit}),hash);
  assert.notEqual(servicePolicyHash({...original,hostPort:22}),hash);
  assert.notEqual(servicePolicyHash({...original,environment:{TOKEN:'x'}}),hash);
});

test('publisher client refuses insecure remote URLs and redirects',async()=>{
  assert.throws(()=>new PublisherClient('http://example.com',token));
  assert.throws(()=>new PublisherClient('https://example.com/path',token));
  const client=new PublisherClient('http://127.0.0.1:4321',token,async(_url,init)=>{assert.equal(init?.redirect,'error');assert.equal((init?.headers as Record<string,string>).Authorization,'Bearer '+token);return new Response(JSON.stringify({commit}),{status:200});});
  assert.equal(await client.revision('web'),commit);
});

test('unattended source checks and deployment use independent publisher without backend GitHub credentials',async()=>{
  const f=fixture(),store=new Store(join(f.directory,'controller'));await store.ready();
  let submitted:SignedRelease|undefined;
  const remote:RemoteTransport={canControl:()=>true,fingerprint:async()=>({fingerprint:'',hostKey:''}),probe:async server=>({serverId:server.id,checkedAt:date,services:[]}),bootstrap:async()=>({log:''}),submit:async()=>{throw new Error('Unsigned deployment must not be used');},status:async()=>({state:'succeeded',stage:'complete',log:''}),submitSigned:async release=>{submitted=release;verifyRelease(release,keys.publicKey);return {state:'succeeded',stage:'complete',log:'',revision:commit};}};
  const publisher=new Publisher(f.options),jobs=new JobManager(store,remote,publisher);
  try{
    await store.saveServer(entry().server);await store.saveService(entry().service);
    assert.equal(await store.vault.has('github'),false);
    await jobs.checkSources();
    const queued=(await store.allJobs())[0];assert.equal(queued.source,'github');assert.equal(queued.revision,commit);
    await jobs.tick();
    for(let i=0;i<100&&(await store.getJob(queued.id))?.state!=='succeeded';i++)await new Promise(r=>setTimeout(r,10));
    assert.equal((await store.getJob(queued.id))?.state,'succeeded');assert.ok(submitted);assert.equal((await store.getService('web'))?.lastCommit,commit);
    await jobs.checkSources();assert.equal((await store.allJobs()).length,1);
  }finally{jobs.stop();await store.close();f.clean();}
});
