import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import { createApp, type AppOptions } from '../server/app.js';
import {StorageUnavailableError} from '../server/storage.js';
import type { Project, DeployPlan, Job, RemoteJobStatus, RemoteTransport, Server, ServerStatus, Service, SSHCredential, WorkspaceSnapshot, RuntimeService } from '../shared/types.js';

const installCode='fixture-install-code';
const password='fixture-admin-password-123';
const fingerprint='SHA256:fixture-pinned-fingerprint';
const hostKey='ssh-ed25519 Zml4dHVyZS1ob3N0LWtleS1ub3QtYS1yZWFsLWtleQ==';
class FakeRemote implements RemoteTransport {
  probeFailure=false;
  verifications=0;
  probes=0;
  submissions:DeployPlan[]=[];
  statusReads=0;
  bootstrapCalls=0;
  submittedState:RemoteJobStatus['state']='queued';
  observedState:RemoteJobStatus['state']='running';
  async verifyConnection(server:Server,credential:SSHCredential|undefined):Promise<void> {
    assert.equal(server.fingerprint,fingerprint,'new connection must receive the reviewed fingerprint');
    assert.equal(credential?.hostKey,hostKey);this.verifications++;
  }
  async fingerprint(_server:Server):Promise<{fingerprint:string;hostKey:string}> { return {fingerprint,hostKey}; }
  async probe(server:Server,_credential:SSHCredential|undefined):Promise<ServerStatus> {
    assert.equal(server.fingerprint,fingerprint);this.probes++;
    if(this.probeFailure) throw new Error('python3: command not found');
    return {serverId:server.id,checkedAt:new Date().toISOString(),dockerAvailable:true,composeAvailable:true,gitAvailable:true,services:[]};
  }
  async bootstrap(_server:Server,_credential:SSHCredential|undefined):Promise<{log:string}> { this.bootstrapCalls++;return {log:'Dependencies ready'}; }
  async submit(plan:DeployPlan,_credential:SSHCredential|undefined):Promise<RemoteJobStatus> { this.submissions.push(structuredClone(plan));return {state:this.submittedState,stage:'queued',log:''}; }
  async status(_job:Job,_server:Server,_credential:SSHCredential|undefined):Promise<RemoteJobStatus> { this.statusReads++;return {state:this.observedState,stage:'observed',log:'Remote status checked'}; }
}
async function fixture(options:{publicUrl?:string;remote?:FakeRemote;publisher?:AppOptions['publisher'];managedRemote?:boolean}={}) {
  const directory=mkdtempSync(join(tmpdir(),'serverdesk-api-'));
  const remote=options.remote??new FakeRemote();
  const created=await createApp({dataDir:directory,remote:options.managedRemote?undefined:remote,startWorker:false,setupToken:installCode,publicUrl:options.publicUrl,publisher:options.publisher,webRoot:join(directory,'absent-web')});
  let cookie='';let csrf='';
  const request=async(method:'GET'|'POST'|'PUT'|'DELETE',url:string,payload?:InjectOptions['payload'],headers:Record<string,string>={}):Promise<LightMyRequestResponse>=>created.app.inject({method,url,...(payload===undefined?{}:{payload}),headers:{host:'localhost:4317',...(cookie?{cookie}:{}),...(csrf?{'x-csrf-token':csrf}:{}),...headers}});
  const setup=async()=>{
    const response=await request('POST','/api/setup',{setupToken:installCode,password});assert.equal(response.statusCode,200,response.body);
    cookie=String(response.headers['set-cookie']).split(';')[0];csrf=response.json().csrfToken;
    return response;
  };
  const addServer=async(name='Server',host='127.0.0.1'):Promise<Server>=>{const response=await request('POST','/api/servers',{name,host,username:'ubuntu'});assert.equal(response.statusCode,200,response.body);return response.json();};
  const connect=async(server:Server)=>{
    const response=await request('POST',`/api/servers/${server.id}/fingerprint`);assert.equal(response.statusCode,200,response.body);
    const saved=await request('POST',`/api/servers/${server.id}/credentials`,{...response.json<{fingerprint:string;hostKey:string}>(),password:'fixture-server-password'});assert.equal(saved.statusCode,200,saved.body);
  };
  const addImage=async(server:Server,projectId?:string):Promise<Service>=>{const response=await request('POST','/api/services',{name:'web',kind:'image',serverId:server.id,image:'nginx:alpine',...(projectId?{projectId}:{})});assert.equal(response.statusCode,200,response.body);return response.json();};
  return {...created,directory,remote,request,setup,addServer,connect,addImage,auth:()=>({cookie,csrf}),cleanup:async()=>{await created.app.close();rmSync(directory,{recursive:true,force:true});}};
}
async function eventually(predicate:()=>boolean|Promise<boolean>):Promise<void> { for(let index=0;index<100;index++){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('Expected state was not reached'); }

test('database outage returns retryable 503 and health recovers without losing the session',async()=>{
  const f=await fixture();const original=f.store.getSetting.bind(f.store);
  try{
    await f.setup();
    f.store.getSetting=async()=>{throw new StorageUnavailableError();};
    for(const url of ['/healthz','/api/workspace','/api/agent/manifest']) {
      const result=await f.request('GET',url);assert.equal(result.statusCode,503);assert.equal(result.json().error,'数据库暂时不可用，请稍后重试');
    }
    f.store.getSetting=original;
    assert.equal((await f.request('GET','/healthz')).statusCode,200);
    assert.equal((await f.request('GET','/api/session')).json().authenticated,true);
  }finally{f.store.getSetting=original;await f.cleanup();}
});

test('background worker retries a transient database outage without an unhandled rejection',async()=>{
  const f=await fixture();const original=f.store.allJobs.bind(f.store);let calls=0;
  try{
    f.store.allJobs=async()=>{calls++;if(calls===2)throw new StorageUnavailableError();return original();};
    await f.jobs.start();
    for(let i=0;i<250&&calls<3;i++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.ok(calls>=3,'the scheduled worker resumed after the failed tick');
  }finally{f.jobs.stop();f.store.allJobs=original;await f.cleanup();}
});

test('setup, login, Host, Origin and CSRF boundaries protect the management API',async()=>{
  const f=await fixture();try {
    const session=await f.request('GET','/api/session');assert.equal(session.json().setupRequired,true);
    assert.equal((await f.request('GET','/api/workspace')).statusCode,401);
    assert.equal((await f.request('GET','/api/session',undefined,{host:'untrusted.example'})).statusCode,403);
    assert.equal((await f.request('POST','/api/setup',{setupToken:installCode,password},{origin:'https://evil.example'})).statusCode,403);
    assert.equal((await f.request('POST','/api/setup',{setupToken:'wrong',password})).statusCode,403);
    const setup=await f.setup();assert.match(String(setup.headers['set-cookie']),/HttpOnly/i);assert.match(String(setup.headers['set-cookie']),/SameSite=Strict/i);
    assert.equal((await f.request('POST','/api/setup',{setupToken:installCode,password})).statusCode,409);
    assert.equal((await f.request('POST','/api/projects',{name:'Blocked'},{'x-csrf-token':''})).statusCode,403);
    assert.equal((await f.request('POST','/api/projects',{name:'Blocked'},{origin:'https://evil.example'})).statusCode,403);
    const ok=await f.request('POST','/api/projects',{name:'Allowed'});assert.equal(ok.statusCode,200,ok.body);
    assert.equal(ok.headers['cache-control'],'no-store');assert.match(String(ok.headers['content-security-policy']),/frame-ancestors 'none'/);
    const oldCookie=f.auth().cookie;await f.request('POST','/api/logout');
    assert.equal((await f.request('GET','/api/workspace',undefined,{cookie:oldCookie})).statusCode,401);
    assert.equal((await f.request('POST','/api/login',{password:'wrong-password'})).statusCode,401);
  }finally{await f.cleanup();}
});

test('public management URL requires HTTPS and issues secure session cookies',async()=>{
  const f=await fixture({publicUrl:'https://console.example.com'});try {
    const response=await f.setup();assert.match(String(response.headers['set-cookie']),/; Secure/i);
    assert.equal((await f.request('GET','/api/session',undefined,{host:'console.example.com',origin:'https://console.example.com'})).statusCode,200);
    assert.equal((await f.request('POST','/api/settings',{publicUrl:'http://public.example.com'})).statusCode,400);
    assert.equal((await f.request('POST','/api/settings',{publicUrl:'https://user:secret@public.example.com'})).statusCode,400);
    assert.equal((await f.store.getSetting('publicUrl')),'https://console.example.com');
  }finally{await f.cleanup();}
});

test('project API groups different servers together, moves services, and deletes only grouping',async()=>{
  const f=await fixture();try {
    await f.setup();const first=await f.addServer('First');const second=await f.addServer('Second','127.0.0.2');
    const a=await f.addImage(first);const b=await f.addImage(second);
    const group=await f.request('POST','/api/projects',{name:'Business',serviceIds:[a.id,b.id]});assert.equal(group.statusCode,200,group.body);
    assert.deepEqual(group.json().serviceIds,[a.id,b.id]);
    const other=await f.request('POST','/api/projects',{name:'Other'});const moved=await f.request('PUT',`/api/projects/${other.json().id}`,{name:'Other',serviceIds:[b.id]});assert.equal(moved.statusCode,200,moved.body);
    assert.deepEqual((await f.store.getProject(group.json().id))?.serviceIds,[a.id]);assert.deepEqual((await f.store.getProject(other.json().id))?.serviceIds,[b.id]);
    assert.equal((await f.request('DELETE',`/api/projects/${group.json().id}`)).statusCode,200);
    const snapshot=(await f.request('GET','/api/workspace')).json<WorkspaceSnapshot>();assert.equal(snapshot.services.length,2);assert.equal(snapshot.servers.length,2);
    assert.equal((await f.request('DELETE',`/api/servers/${first.id}`)).statusCode,400);
    assert.equal(f.remote.submissions.length,0);assert.equal(f.remote.bootstrapCalls,0);
  }finally{await f.cleanup();}
});

test('source API stores canonical repository URL and never returns environment or integration tokens',async()=>{
  const f=await fixture();try {
    await f.setup();const server=await f.addServer();
    (await f.store.vault.set('github',{token:'fixture-github-token-secret'}));
    const response=await f.request('POST','/api/services',{name:'Source',kind:'source',serverId:server.id,repository:'example/repository.git',branch:'main',dockerfile:'Dockerfile',context:'.',environment:{DATABASE_PASSWORD:'fixture-database-secret'},autoDeploy:false});
    assert.equal(response.statusCode,200,response.body);const resource=response.json<Service>();assert.equal(resource.repository,'https://github.com/example/repository');assert.equal(resource.environment,undefined);
    assert.deepEqual((await f.store.getServiceEnvironment(resource.id)),{DATABASE_PASSWORD:'fixture-database-secret'});
    const workspace=await f.request('GET','/api/workspace');assert.equal(workspace.statusCode,200,workspace.body);
    assert.equal(workspace.body.includes('fixture-database-secret'),false);assert.equal(workspace.body.includes('fixture-github-token-secret'),false);
    assert.equal(workspace.json().integrations.github.connected,true);
    assert.equal((await f.request('GET',`/api/services/${resource.id}`)).body.includes('fixture-database-secret'),false);
    const invalid=await f.request('PUT',`/api/services/${resource.id}`,{name:'Bad',repository:'https://token@github.com/example/repository'});assert.equal(invalid.statusCode,400);
  }finally{await f.cleanup();}
});

test('first credentials use reviewed fingerprint; Python absence does not prevent dependency installation',async()=>{
  const remote=new FakeRemote();remote.probeFailure=true;
  const f=await fixture({remote});try {
    await f.setup();const server=await f.addServer();
    assert.equal((await f.request('POST',`/api/servers/${server.id}/credentials`,{hostKey,fingerprint,password:'fixture-server-password'})).statusCode,400);
    await f.connect(server);assert.equal(remote.verifications,1);assert.equal((await f.store.getServer(server.id))?.fingerprint,fingerprint);
    assert.equal((await f.store.getServer(server.id))?.credentialConfigured,true);
    const snapshot=(await f.request('GET','/api/workspace')).json<WorkspaceSnapshot>();assert.match(snapshot.serverStatuses[0].error??'',/依赖/);
    const plan=await f.request('GET',`/api/servers/${server.id}/bootstrap`);assert.equal(plan.statusCode,200);assert.ok(plan.json().commands.length);
    const queued=await f.request('POST',`/api/servers/${server.id}/bootstrap`);assert.equal(queued.statusCode,200,queued.body);assert.equal(queued.json().state,'queued');assert.equal(remote.bootstrapCalls,0);
    assert.equal((await f.request('POST',`/api/servers/${server.id}/bootstrap`)).statusCode,400);
    assert.equal(JSON.stringify(snapshot).includes('fixture-server-password'),false);
  }finally{await f.cleanup();}
});

test('fingerprint cannot be reused after the connection identity changes',async()=>{
  const f=await fixture();try {
    await f.setup();const server=await f.addServer();const pending=await f.request('POST',`/api/servers/${server.id}/fingerprint`);
    const changed=await f.request('PUT',`/api/servers/${server.id}`,{name:server.name,host:'127.0.0.2',username:'ubuntu',port:22});assert.equal(changed.statusCode,200,changed.body);
    const credentials=await f.request('POST',`/api/servers/${server.id}/credentials`,{...pending.json<{fingerprint:string;hostKey:string}>(),password:'fixture-server-password'});assert.equal(credentials.statusCode,400);
    assert.equal(f.remote.verifications,0);assert.equal((await f.store.getServer(server.id))?.credentialConfigured,false);
  }finally{await f.cleanup();}
});

test('jobs and immutable plans survive logout and restart; unknown handoffs are queried without resubmission',async()=>{
  const f=await fixture();let closed=false;
  try {
    await f.setup();const server=await f.addServer();await f.connect(server);const resource=await f.addImage(server);
    const response=await f.request('POST',`/api/services/${resource.id}/deploy`);assert.equal(response.statusCode,200,response.body);const queued=response.json<Job>();
    assert.equal(queued.state,'queued');assert.ok((await f.store.vault.get(`plan:${queued.id}`)));assert.equal(f.remote.submissions.length,0);
    assert.equal((await f.request('DELETE',`/api/services/${resource.id}`)).statusCode,400);
    assert.equal((await f.request('DELETE',`/api/servers/${server.id}`)).statusCode,400);
    await f.request('POST','/api/logout');assert.equal((await f.store.getJob(queued.id))?.state,'queued');
    (await f.store.updateJob(queued.id,{state:'unknown',stage:'connection interrupted'}));
    await f.app.close();closed=true;
    const remote=new FakeRemote();remote.observedState='succeeded';
    const reopened=await createApp({dataDir:f.directory,remote,startWorker:false,setupToken:installCode,webRoot:join(f.directory,'absent-web')});
    try {
      assert.equal((await reopened.store.getJob(queued.id))?.state,'unknown');
      await reopened.jobs.tick();assert.equal((await reopened.store.getJob(queued.id))?.state,'succeeded');
      assert.equal(remote.statusReads,1);assert.equal(remote.submissions.length,0);
      const login=await reopened.app.inject({method:'POST',url:'/api/login',headers:{host:'localhost:4317'},payload:{password}});assert.equal(login.statusCode,200,login.body);
      const cookie=String(login.headers['set-cookie']).split(';')[0];
      const workspace=await reopened.app.inject({method:'GET',url:'/api/workspace',headers:{host:'localhost:4317',cookie}});assert.equal(workspace.json().jobs[0].id,queued.id);
    }finally{await reopened.app.close();}
  }finally{if(!closed)await f.app.close();rmSync(f.directory,{recursive:true,force:true});}
});

test('accepted queued remote receipt is tracked without resubmitting',async()=>{
  const f=await fixture();try {
    await f.setup();const server=await f.addServer();await f.connect(server);const resource=await f.addImage(server);
    const queued=(await f.request('POST',`/api/services/${resource.id}/deploy`)).json<Job>();
    await f.jobs.tick();await eventually(async ()=>f.remote.submissions.length===1 && (await f.store.getJob(queued.id))?.state==='running');
    await f.jobs.tick();assert.equal(f.remote.submissions.length,1);assert.equal(f.remote.statusReads,1);
    f.remote.observedState='succeeded';await f.jobs.refreshJob(queued.id);assert.equal((await f.store.getJob(queued.id))?.state,'succeeded');
  }finally{await f.cleanup();}
});

test('signed GitHub notification for an obsolete commit never submits old code',async()=>{
  const f=await fixture();const originalFetch=globalThis.fetch;
  try {
    await f.setup();const server=await f.addServer();await f.connect(server);
    (await f.store.vault.set('github',{token:'fixture-github-secret'}));
    const source=await f.request('POST','/api/services',{name:'Source',kind:'source',serverId:server.id,repository:'example/repository',branch:'main',autoDeploy:true});assert.equal(source.statusCode,200,source.body);const resource=source.json<Service>();
    const secret='fixture-webhook-secret';(await f.store.vault.set(`webhook:${resource.id}`,{secret}));
    const stale='a'.repeat(40),latest='b'.repeat(40);
    const body=JSON.stringify({ref:'refs/heads/main',after:stale,repository:{full_name:'example/repository'}});
    const hook=(signature:string)=>f.app.inject({method:'POST',url:`/api/hooks/github/${resource.id}`,payload:body,headers:{host:'localhost:4317','content-type':'application/json','x-github-event':'push','x-hub-signature-256':signature}});
    assert.equal((await hook('sha256='+'0'.repeat(64))).statusCode,403);
    const signature='sha256='+createHmac('sha256',secret).update(body).digest('hex');const accepted=await hook(signature);assert.equal(accepted.statusCode,202,accepted.body);
    const queued=(await f.store.allJobs())[0];assert.equal(queued.revision,stale);
    globalThis.fetch=(async(input:RequestInfo|URL)=>{
      const url=String(input);assert.match(url,/^https:\/\/api\.github\.com\/repos\/example\/repository\/commits\/main$/);
      return new Response(JSON.stringify({sha:latest}),{headers:{'content-type':'application/json'}});
    }) as typeof fetch;
    // Keep source polling from adding a separate latest-version job in this assertion.
    (f.jobs as unknown as {lastGithubPoll:number}).lastGithubPoll=Date.now();
    await f.jobs.tick();await eventually(async ()=>(await f.store.getJob(queued.id))?.state==='cancelled');
    assert.equal(f.remote.submissions.length,0);
  }finally{globalThis.fetch=originalFetch;await f.cleanup();}
});


test('server resource import requires a recent observation and rejects fabricated targets atomically',async()=>{
  const f=await fixture();try {
    await f.setup();const server=await f.addServer();const group=(await f.request('POST','/api/projects',{name:'Observed resources'})).json<{id:string}>();
    const actual:RuntimeService={name:'existing-web-1',kind:'Docker',ready:true,state:'running',composeProject:'existing',composeService:'web'};
    const request=()=>f.request('POST',`/api/servers/${server.id}/import`,{projectId:group.id,services:[actual]});
    assert.equal((await request()).statusCode,400);
    (await f.store.setSetting(`status:server:${server.id}`,{serverId:server.id,checkedAt:new Date(Date.now()-121_000).toISOString(),services:[actual]}));
    assert.equal((await request()).statusCode,400);
    (await f.store.setSetting(`status:server:${server.id}`,{serverId:server.id,checkedAt:new Date().toISOString(),services:[actual]}));
    const fabricated=await f.request('POST',`/api/servers/${server.id}/import`,{projectId:group.id,services:[actual,{...actual,composeService:'not-observed'}]});
    assert.equal(fabricated.statusCode,400);assert.equal((await f.store.allServices()).length,0);assert.deepEqual((await f.store.getProject(group.id))?.serviceIds,[]);
    (await f.store.setSetting(`status:server:${server.id}`,{serverId:server.id,checkedAt:new Date().toISOString(),error:'Connection unavailable',services:[actual]}));
    assert.equal((await request()).statusCode,400);assert.equal(f.remote.submissions.length,0);
  }finally{await f.cleanup();}
});

test('server resource import preserves exact Compose, Kubernetes and container targets and deduplicates IDs',async()=>{
  const f=await fixture();try {
    await f.setup();const server=await f.addServer();const group=(await f.request('POST','/api/projects',{name:'Mixed runtime resources'})).json<{id:string}>();
    const observed:RuntimeService[]=[
      {name:'business-api-1',kind:'Docker',ready:true,state:'running',image:'registry.example/api:v1',composeProject:'business',composeService:'api'},
      {name:'worker',kind:'Kubernetes',ready:true,state:'running',image:'registry.example/worker:v1',namespace:'production',deployment:'worker'},
      {name:'standalone-cache',kind:'Docker',ready:true,state:'running',image:'redis:7'}
    ];
    (await f.store.setSetting(`status:server:${server.id}`,{serverId:server.id,checkedAt:new Date().toISOString(),services:observed}));
    // Display metadata submitted by a browser cannot override the observed image.
    const selected=observed.map(row=>({...row,image:'attacker.invalid/replacement'}));
    const response=await f.request('POST',`/api/servers/${server.id}/import`,{projectId:group.id,services:selected});assert.equal(response.statusCode,200,response.body);assert.deepEqual(response.json(),{imported:3,ignored:0});
    const imported=(await f.store.allServices());const originalIds=imported.map(value=>value.id).sort();
    const compose=imported.find(value=>value.kind==='compose')!;assert.deepEqual(compose.target,{composeProject:'business',composeService:'api'});assert.equal(compose.image,'registry.example/api:v1');
    const kubernetes=imported.find(value=>value.kind==='kubernetes')!;assert.deepEqual(kubernetes.target,{namespace:'production',deployment:'worker'});
    const container=imported.find(value=>value.kind==='container')!;assert.deepEqual(container.target,{containerName:'standalone-cache'});
    assert.equal(imported.every(value=>value.serverId===server.id&&!value.autoDeploy),true);
    const repeated=await f.request('POST',`/api/servers/${server.id}/import`,{projectId:group.id,services:observed});assert.equal(repeated.statusCode,200,repeated.body);assert.deepEqual(repeated.json(),{imported:0,ignored:3});
    assert.deepEqual((await f.store.allServices()).map(value=>value.id).sort(),originalIds);assert.equal((await f.store.getProject(group.id))?.serviceIds.length,3);
    assert.equal(f.remote.submissions.length,0);assert.equal(f.remote.bootstrapCalls,0);assert.equal(f.remote.probes,0);
  }finally{await f.cleanup();}
});

test('server import ignores already managed source/image/Compose resources without moving project membership',async()=>{
  const f=await fixture();try {
    await f.setup();const server=await f.addServer();
    const first=(await f.request('POST','/api/projects',{name:'Existing owner'})).json<{id:string}>();const second=(await f.request('POST','/api/projects',{name:'New target'})).json<{id:string}>();
    const image=await f.addImage(server,first.id);
    const sourceResponse=await f.request('POST','/api/services',{name:'source',kind:'source',serverId:server.id,repository:'example/source',projectId:first.id});assert.equal(sourceResponse.statusCode,200,sourceResponse.body);const source=sourceResponse.json<Service>();
    const imageRuntime:RuntimeService={name:'managed-image-1',kind:'Docker',ready:true,state:'running',composeProject:image.target.composeProject,composeService:image.target.composeService};
    const sourceRuntime:RuntimeService={name:'managed-source-1',kind:'Docker',ready:true,state:'running',composeProject:source.target.composeProject,composeService:source.target.composeService};
    const composeRuntime:RuntimeService={name:'original-api-1',kind:'Docker',ready:true,state:'running',composeProject:'original',composeService:'api'};
    (await f.store.setSetting(`status:server:${server.id}`,{serverId:server.id,checkedAt:new Date().toISOString(),services:[imageRuntime,sourceRuntime,composeRuntime]}));
    const original=await f.request('POST',`/api/servers/${server.id}/import`,{projectId:first.id,services:[composeRuntime]});assert.equal(original.statusCode,200,original.body);
    const beforeIds=(await f.store.allServices()).map(value=>value.id).sort();const beforeMembership=(await f.store.getProject(first.id))?.serviceIds;
    const imported=await f.request('POST',`/api/servers/${server.id}/import`,{projectId:second.id,services:[imageRuntime,sourceRuntime,composeRuntime]});assert.equal(imported.statusCode,200,imported.body);assert.deepEqual(imported.json(),{imported:0,ignored:3});
    assert.deepEqual((await f.store.allServices()).map(value=>value.id).sort(),beforeIds);assert.deepEqual((await f.store.getProject(first.id))?.serviceIds,beforeMembership);assert.deepEqual((await f.store.getProject(second.id))?.serviceIds,[]);
    assert.equal((await f.store.getService(image.id))?.kind,'image');assert.equal((await f.store.getService(source.id))?.kind,'source');assert.equal(f.remote.submissions.length,0);assert.equal(f.remote.bootstrapCalls,0);
  }finally{await f.cleanup();}
});

test('publisher services with empty targets show their owned Docker state and cannot be imported twice',async()=>{
  const f=await fixture();try{
    await f.setup();const server=await f.addServer();
    const project=(await f.request('POST','/api/projects',{name:'Signed services'})).json<Project>();
    const service=await f.addImage(server,project.id);await f.store.saveService({...service,target:{}});
    const runtime:RuntimeService={name:'owned-app-1',kind:'Docker',ready:true,state:'running',composeProject:'sd-'+service.id.replaceAll('-','').toLowerCase(),composeService:'app',image:'sha256:'+'1'.repeat(64)};
    await f.store.setSetting(`status:server:${server.id}`,{serverId:server.id,checkedAt:new Date().toISOString(),services:[runtime]});
    const status=await f.jobs.serviceStatus((await f.store.getService(service.id))!);assert.equal(status.state,'running');assert.equal(status.ready,true);assert.equal(status.image,runtime.image);
    const result=await f.request('POST',`/api/servers/${server.id}/import`,{projectId:project.id,services:[runtime]});assert.equal(result.statusCode,200,result.body);assert.deepEqual(result.json(),{imported:0,ignored:1});assert.equal((await f.store.allServices()).length,1);assert.equal(f.remote.submissions.length,0);
  }finally{await f.cleanup();}
});

test('concurrent first-run requests create exactly one administrator',async()=>{
  const f=await fixture();
  try {
    const passwords=['concurrent-first-password','concurrent-second-password'];
    const responses=await Promise.all(passwords.map(password=>f.request('POST','/api/setup',{setupToken:installCode,password})));
    assert.deepEqual(responses.map(response=>response.statusCode).sort(),[200,409]);
    const winningIndex=responses.findIndex(response=>response.statusCode===200);
    const login=await f.request('POST','/api/login',{password:passwords[winningIndex]});
    assert.equal(login.statusCode,200);
    const rejected=await f.request('POST','/api/login',{password:passwords[1-winningIndex]});
    assert.equal(rejected.statusCode,401,'the losing setup request must not overwrite the administrator');
  }finally{await f.cleanup();}
});


test('independent publisher mode keeps GitHub credentials out of the controller',async()=>{
  const publisher={catalog:async()=>[],revision:async()=> 'a'.repeat(40),publish:async()=>{throw new Error('No release should be requested by a settings test');}};
  const f=await fixture({publisher,managedRemote:true});
  try {
    await f.setup();
    const denied=await f.request('POST','/api/integrations/github',{token:'publisher-mode-token-must-not-be-stored'});
    assert.equal(denied.statusCode,400);assert.match(denied.json().error,/不保存 GitHub Token/);
    assert.equal(await f.store.vault.has('github'),false);
    const server=await f.addServer();await f.store.saveServer({...server,connectionMode:'agent'});
    const pairing=await f.agents.createPairing(server.id);await f.agents.register({...pairing,hostname:'authorized-os',version:'test'});
    const service=await f.request('POST','/api/services',{name:'Published source',kind:'source',serverId:server.id,repository:'https://github.com/fixture/source',autoDeploy:true});
    assert.equal(service.statusCode,200,service.body);
    assert.equal(service.json().autoDeploy,true);
    const workspace=await f.request('GET','/api/workspace');
    assert.deepEqual(workspace.json().platform,{storage:'sqlite',publisherConfigured:true,deploymentConfigurationAuthority:'publisher'});
  }finally{await f.cleanup();}
});

test('enabling an independent publisher refuses existing GitHub credentials without deleting them',async()=>{
  const f=await fixture();
  const publisher={catalog:async()=>[],revision:async()=> 'a'.repeat(40),publish:async()=>{throw new Error('unused');}};
  try {
    await f.store.vault.set('github',{token:'retained-fixture-token'});
    await f.app.close();
    await assert.rejects(createApp({dataDir:f.directory,startWorker:false,publisher,webRoot:join(f.directory,'absent-web')}),/兼容模式断开 GitHub/);
    const reopened=await createApp({dataDir:f.directory,startWorker:false,webRoot:join(f.directory,'absent-web')});
    try {assert.deepEqual(await reopened.store.vault.get('github'),{token:'retained-fixture-token'});}finally{await reopened.app.close();}
  }finally{await f.cleanup();}
});


test('publisher image automatic deployment accepts an online OS without SSH credentials',async()=>{
  const publisher={catalog:async()=>[],revision:async()=> 'a'.repeat(40),publish:async()=>{throw new Error('No release is requested while editing');}};
  const f=await fixture({publisher,managedRemote:true});
  try {
    await f.setup();
    const server=await f.addServer();
    await f.store.saveServer({...server,connectionMode:'agent'});
    const pairing=await f.agents.createPairing(server.id);
    await f.agents.register({...pairing,hostname:'publisher-os',version:'test'});
    assert.equal(await f.store.vault.has(`ssh:${server.id}`),false);
    assert.equal(await f.store.vault.has('github'),false);
    const created=await f.request('POST','/api/services',{name:'Signed image',kind:'image',serverId:server.id,image:'registry.example.com/app@sha256:'+'a'.repeat(64),repository:'https://github.com/fixture/app',autoDeploy:true});
    assert.equal(created.statusCode,200,created.body);
    assert.equal(created.json().autoDeploy,true);
    const edited=await f.request('PUT',`/api/services/${created.json().id}`,{name:'Signed image renamed',autoDeploy:true});
    assert.equal(edited.statusCode,200,edited.body);
    await f.agents.revoke(server.id);
    const offline=await f.request('PUT',`/api/services/${created.json().id}`,{name:'Offline configuration',autoDeploy:true});
    assert.equal(offline.statusCode,400);assert.match(offline.json().error,/在线的 void0 OS/);
  }finally{await f.cleanup();}
});

test('compatibility source automatic deployment accepts an online OS without requiring SSH',async()=>{
  const f=await fixture({managedRemote:true});
  try {
    await f.setup();
    await f.store.vault.set('github',{token:'fixture-compatibility-source-token'});
    const server=await f.addServer();
    await f.store.saveServer({...server,connectionMode:'agent'});
    const pairing=await f.agents.createPairing(server.id);
    await f.agents.register({...pairing,hostname:'compatibility-os',version:'test'});
    assert.equal(await f.store.vault.has(`ssh:${server.id}`),false);
    const source=await f.request('POST','/api/services',{name:'Compatibility source',kind:'source',serverId:server.id,repository:'https://github.com/fixture/app',autoDeploy:true});
    assert.equal(source.statusCode,200,source.body);
    assert.equal(source.json().autoDeploy,true);
    const image=await f.request('POST','/api/services',{name:'Legacy image',kind:'image',serverId:server.id,image:'nginx:alpine',repository:'https://github.com/fixture/app',autoDeploy:true});
    assert.equal(image.statusCode,400,'compatibility mode still requires a source or existing Compose service for automatic deployment');
  }finally{await f.cleanup();}
});

test('publisher catalog imports authorized IDs without images, credentials or automatic deployment',async()=>{
  let catalog:Array<{service:Service;server:Server}>=[];let reads=0;
  const publisher={catalog:async()=>{reads++;return structuredClone(catalog);},revision:async()=> 'a'.repeat(40),publish:async()=>{throw new Error('Import must not publish');}};
  const f=await fixture({publisher,managedRemote:true});
  try {
    assert.equal((await f.request('GET','/api/publisher/services')).statusCode,401);
    await f.setup();
    const original=await f.addServer();
    const server=await f.store.saveServer({...original,connectionMode:'agent'});
    const project=(await f.request('POST','/api/projects',{name:'Authorized services'})).json<Project>();
    const now=new Date().toISOString();
    const service:Service={id:'publisher-web',name:'Authorized web',kind:'image',serverId:server.id,target:{},repository:'https://github.com/fixture/web',branch:'main',environment:{TOKEN:'catalog-credential-must-not-leak'},autoDeploy:true,createdAt:now,updatedAt:now};
    catalog=[{service,server}];
    const listing=await f.request('GET','/api/publisher/services');
    assert.equal(listing.statusCode,200,listing.body);assert.equal(listing.body.includes('catalog-credential'),false);
    assert.equal(listing.json().services[0].service.environment,undefined);
    assert.equal(listing.json().services[0].service.image,undefined);
    const imported=await f.request('POST','/api/publisher/import',{projectId:project.id,serviceIds:[service.id]});
    assert.equal(imported.statusCode,200,imported.body);assert.equal(imported.json().count,1);
    assert.equal(reads,2,'import must fetch the current authoritative catalog instead of using a browser cache');
    const saved=await f.store.getService(service.id);
    assert.ok(saved);assert.equal(saved.autoDeploy,false);assert.equal(saved.image,undefined);assert.deepEqual(saved.target,{});
    assert.deepEqual(await f.store.getServiceEnvironment(service.id),{});
    assert.deepEqual((await f.store.getProject(project.id))?.serviceIds,[service.id]);
    const edit=await f.request('PUT',`/api/services/${service.id}`,{name:'My display name',autoDeploy:false});
    assert.equal(edit.statusCode,200,edit.body);
    const other=(await f.request('POST','/api/projects',{name:'Another group'})).json<Project>();
    const repeated=await f.request('POST','/api/publisher/import',{projectId:other.id,serviceIds:[service.id]});
    assert.equal(repeated.statusCode,200,repeated.body);
    assert.equal((await f.store.allServices()).length,1);
    assert.deepEqual((await f.store.getProject(project.id))?.serviceIds,[]);
    assert.deepEqual((await f.store.getProject(other.id))?.serviceIds,[service.id]);
    assert.equal((await f.store.getService(service.id))?.name,service.name);
    catalog=[];
    const revoked=await f.request('POST','/api/publisher/import',{projectId:other.id,serviceIds:[service.id]});
    assert.equal(revoked.statusCode,400);assert.match(revoked.json().error,/已不在发布器授权目录/);
  }finally{await f.cleanup();}
});

test('publisher import rejects missing or SSH servers, changed targets and busy services atomically',async()=>{
  let catalog:Array<{service:Service;server:Server}>=[];
  const publisher={catalog:async()=>structuredClone(catalog),revision:async()=> 'a'.repeat(40),publish:async()=>{throw new Error('Import must not publish');}};
  const f=await fixture({publisher,managedRemote:true});
  try {
    await f.setup();
    const server=await f.addServer();
    const project=(await f.request('POST','/api/projects',{name:'Import boundary'})).json<Project>();
    const now=new Date().toISOString();
    const make=(id:string,serverId=server.id):Service=>({id,name:id,kind:'image',serverId,target:{},repository:'https://github.com/fixture/app',branch:'main',autoDeploy:false,createdAt:now,updatedAt:now});
    catalog=[{service:make('missing-server','not-added'),server:{...server,id:'not-added',connectionMode:'agent'}}];
    assert.equal((await f.request('POST','/api/publisher/import',{projectId:project.id,serviceIds:['missing-server']})).statusCode,400);
    catalog=[{service:make('ssh-server'),server:{...server,connectionMode:'agent'}}];
    assert.equal((await f.request('POST','/api/publisher/import',{projectId:project.id,serviceIds:['ssh-server']})).statusCode,400);
    await f.store.saveServer({...server,connectionMode:'agent'});
    const original=await f.store.saveService({...make('conflicting-service'),target:{composeProject:'existing-project',composeService:'app'}});
    const newcomer=make('newcomer');
    catalog=[{service:newcomer,server:{...server,connectionMode:'agent'}},{service:make(original.id),server:{...server,connectionMode:'agent'}}];
    const before=await f.store.snapshot();
    const conflict=await f.request('POST','/api/publisher/import',{projectId:project.id,serviceIds:[newcomer.id,original.id]});
    assert.equal(conflict.statusCode,400);assert.match(conflict.json().error,/部署目标与发布器不一致/);
    assert.deepEqual(await f.store.snapshot(),before,'failure after the first import must also restore group membership and remove that inserted service');
    await f.store.saveService({...original,target:{}});
    await f.store.enqueue({id:'publisher-import-active-job',serverId:server.id,serviceId:original.id,type:'deploy',source:'manual',state:'queued',stage:'queued',log:'',createdAt:now,updatedAt:now});
    const busy=await f.request('POST','/api/publisher/import',{projectId:project.id,serviceIds:[original.id]});
    assert.equal(busy.statusCode,400);assert.match(busy.json().error,/未结束的任务/);
    assert.equal((await f.store.getProject(project.id))?.serviceIds.length,0);
    const duplicate=await f.request('POST','/api/publisher/import',{projectId:project.id,serviceIds:[original.id,original.id]});
    assert.equal(duplicate.statusCode,400);
  }finally{await f.cleanup();}
});

test('publisher mode refuses saved SSH credentials, preserves them and permits explicit removal in compatibility mode',async()=>{
  const f=await fixture();
  const publisher={catalog:async()=>[],revision:async()=> 'a'.repeat(40),publish:async()=>{throw new Error('unused');}};
  let reopened:Awaited<ReturnType<typeof createApp>>|undefined;
  try {
    await f.setup();
    const server=await f.addServer();await f.connect(server);
    await f.store.vault.set('ssh:orphaned-server',{privateKey:'fixture-orphaned-private-key'});
    await f.app.close();
    await assert.rejects(createApp({dataDir:f.directory,startWorker:false,publisher,webRoot:join(f.directory,'absent-web')}),/兼容模式删除 SSH 登录凭据/);
    reopened=await createApp({dataDir:f.directory,startWorker:false,webRoot:join(f.directory,'absent-web')});
    assert.equal((await reopened.store.vault.get<SSHCredential>(`ssh:${server.id}`))?.password,'fixture-server-password');
    assert.deepEqual(await reopened.store.vault.get('ssh:orphaned-server'),{privateKey:'fixture-orphaned-private-key'});
    const headers={cookie:f.auth().cookie,'x-csrf-token':f.auth().csrf};
    const removed=await reopened.app.inject({method:'DELETE',url:`/api/servers/${server.id}/credentials`,headers});
    assert.equal(removed.statusCode,200,removed.body);
    assert.equal((await reopened.store.getServer(server.id))?.credentialConfigured,false);
    assert.equal((await reopened.store.getServer(server.id))?.fingerprint,fingerprint,'removing a credential must preserve the server record');
    await reopened.app.close();reopened=undefined;
    await assert.rejects(createApp({dataDir:f.directory,startWorker:false,publisher,webRoot:join(f.directory,'absent-web')}),/SSH 密码或私钥/,'an orphaned credential must also block protected startup');
    reopened=await createApp({dataDir:f.directory,startWorker:false,webRoot:join(f.directory,'absent-web')});
    const orphan=await reopened.app.inject({method:'DELETE',url:'/api/servers/orphaned-server/credentials',headers});
    assert.equal(orphan.statusCode,200,orphan.body);assert.equal(await reopened.store.vault.hasPrefix('ssh:'),false);
    await reopened.app.close();reopened=undefined;
    reopened=await createApp({dataDir:f.directory,startWorker:false,publisher,webRoot:join(f.directory,'absent-web')});
    assert.ok(await reopened.store.getServer(server.id));
  }finally{await reopened?.app.close();await f.cleanup();}
});

test('publisher mode rejects new SSH passwords and private keys before any remote connection',async()=>{
  const publisher={catalog:async()=>[],revision:async()=> 'a'.repeat(40),publish:async()=>{throw new Error('unused');}};
  const f=await fixture({publisher});
  try {
    await f.setup();const server=await f.addServer();
    const response=await f.request('POST',`/api/servers/${server.id}/credentials`,{password:'fixture-denied-password',privateKey:'fixture-denied-key',hostKey,fingerprint});
    assert.equal(response.statusCode,400);assert.match(response.json().error,/不保存 SSH 密码或私钥/);
    assert.equal(await f.store.vault.has(`ssh:${server.id}`),false);
    assert.equal(f.remote.verifications,0);assert.equal(f.remote.probes,0);
  }finally{await f.cleanup();}
});

test('publisher mode refuses existing and newly submitted application variables without deleting legacy values',async()=>{
  const f=await fixture();
  let catalog:Array<{service:Service;server:Server}>=[];
  const publisher={catalog:async()=>structuredClone(catalog),revision:async()=> 'a'.repeat(40),publish:async()=>{throw new Error('unused');}};
  let reopened:Awaited<ReturnType<typeof createApp>>|undefined;
  try {
    await f.setup();
    const original=await f.addServer();
    const server=await f.store.saveServer({...original,connectionMode:'agent'});
    const service=await f.store.saveService({id:'legacy-env-service',name:'Legacy service',kind:'image',serverId:server.id,image:'nginx:alpine',target:{},autoDeploy:false,createdAt:server.createdAt,updatedAt:server.updatedAt,environment:{TOKEN:'legacy-environment-fixture'}});
    await f.app.close();
    await assert.rejects(createApp({dataDir:f.directory,startWorker:false,publisher,webRoot:join(f.directory,'absent-web')}),/撤销或轮换旧凭据/);
    reopened=await createApp({dataDir:f.directory,startWorker:false,webRoot:join(f.directory,'absent-web')});
    assert.deepEqual(await reopened.store.getServiceEnvironment(service.id),{TOKEN:'legacy-environment-fixture'});
    const headers={cookie:f.auth().cookie,'x-csrf-token':f.auth().csrf};
    const cleared=await reopened.app.inject({method:'PUT',url:`/api/services/${service.id}`,headers,payload:{name:service.name,environment:{}}});
    assert.equal(cleared.statusCode,200,cleared.body);
    assert.deepEqual(await reopened.store.getServiceEnvironment(service.id),{});
    await reopened.app.close();reopened=undefined;
    reopened=await createApp({dataDir:f.directory,startWorker:false,publisher,webRoot:join(f.directory,'absent-web')});
    const blocked=await reopened.app.inject({method:'PUT',url:`/api/services/${service.id}`,headers,payload:{name:service.name,environment:{TOKEN:'new-environment-must-not-be-stored'}}});
    assert.equal(blocked.statusCode,400);assert.match(blocked.json().error,/业务服务器本地文件/);
    assert.deepEqual(await reopened.store.getServiceEnvironment(service.id),{});
    const newService=await reopened.app.inject({method:'POST',url:'/api/services',headers,payload:{name:'New environment',kind:'image',serverId:server.id,environment:{TOKEN:'new-environment-must-not-be-stored'}}});
    assert.equal(newService.statusCode,400);
    const project=await reopened.app.inject({method:'POST',url:'/api/projects',headers,payload:{name:'Variable import guard'}});
    assert.equal(project.statusCode,200,project.body);
    catalog=[{service,server}];
    // Simulate a concurrent legacy writer. Import must recheck rather than rely only on startup.
    await reopened.store.setServiceEnvironment(service.id,{TOKEN:'concurrent-legacy-fixture'});
    const imported=await reopened.app.inject({method:'POST',url:'/api/publisher/import',headers,payload:{projectId:project.json().id,serviceIds:[service.id]}});
    assert.equal(imported.statusCode,400);assert.match(imported.json().error,/仍有保存在后台的环境变量/);
    assert.deepEqual((await reopened.store.getProject(project.json().id))?.serviceIds,[]);
    assert.deepEqual(await reopened.store.getServiceEnvironment(service.id),{TOKEN:'concurrent-legacy-fixture'});
  }finally{await reopened?.app.close();await f.cleanup();}
});
