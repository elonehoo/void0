import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { InjectOptions } from 'fastify';
import { createApp } from '../server/app.js';
import type { BootstrapOptions, BootstrapPlan, DeployPlan, Job, KubernetesAction, KubernetesActionResult, RemoteJobStatus, RemoteTransport, Server, ServerStatus, Service, SSHCredential } from '../shared/types.js';

const installCode='fixture-kubernetes-install-code';
const administratorPassword='fixture-admin-password-123';
const hostKey='ssh-ed25519 Zml4dHVyZS1ob3N0LWtleQ==';
const environmentSecret='fixture-database-environment-secret';
const sshPassword='fixture-ssh-password-secret';
const secrets=[environmentSecret,sshPassword,'fixture-bearer-token-secret','fixture-db-password-secret','fixture-logged-password-secret'];
const unsafeLog=[
  'Service is ready',
  `DATABASE_PASSWORD=${environmentSecret}`,
  `SSH_PASSWORD=${sshPassword}`,
  'Authorization: Bearer fixture-bearer-token-secret',
  'database=postgresql://dbuser:fixture-db-password-secret@db.example:5432/app',
  'password=fixture-logged-password-secret',
].join('\n');

class KubernetesRemote implements RemoteTransport {
  bootstrapCalls:Array<{serverId:string;options:BootstrapOptions|undefined}>=[];
  actionCalls:Array<{serverId:string;target:{namespace:string;deployment:string};action:KubernetesAction;options:{replicas?:number}|undefined}>=[];
  submissions:DeployPlan[]=[];
  statusReads=0;
  probes=0;
  bootstrapLog='Dependencies ready';
  actionLog='Action complete';
  failAction:Error|undefined;
  async fingerprint():Promise<{fingerprint:string;hostKey:string}> {return {fingerprint:'SHA256:fixture',hostKey};}
  async probe(server:Server):Promise<ServerStatus> {
    this.probes++;
    return {serverId:server.id,checkedAt:new Date().toISOString(),dockerAvailable:true,composeAvailable:true,k3sAvailable:true,k3sReady:true,k3sNodeCount:1,k3sVersion:'v1.34.6+k3s1',services:[{name:'production/api',kind:'Kubernetes',namespace:'production',deployment:'api',ready:true,state:'4/4',image:'example/api:current'}]};
  }
  async bootstrap(server:Server,_credential:SSHCredential|undefined,options?:BootstrapOptions):Promise<{log:string}> {
    this.bootstrapCalls.push({serverId:server.id,options:options?structuredClone(options):undefined});
    return {log:this.bootstrapLog};
  }
  async kubernetesAction(server:Server,_credential:SSHCredential|undefined,target:{namespace:string;deployment:string},action:KubernetesAction,options?:{replicas?:number}):Promise<KubernetesActionResult> {
    this.actionCalls.push({serverId:server.id,target:structuredClone(target),action,options:options?structuredClone(options):undefined});
    if(this.failAction)throw this.failAction;
    return {log:this.actionLog,...(action==='stop'?{replicas:4}:{})};
  }
  async submit(plan:DeployPlan):Promise<RemoteJobStatus> {this.submissions.push(plan);return {state:'succeeded',stage:'Complete',log:'Done'};}
  async status():Promise<RemoteJobStatus> {this.statusReads++;return {state:'succeeded',stage:'Complete',log:'Done'};}
}

async function fixture(options:{credentials?:boolean;setup?:boolean}={}) {
  const directory=mkdtempSync(join(tmpdir(),'serverdesk-kubernetes-api-'));
  const remote=new KubernetesRemote();
  const created=await createApp({dataDir:directory,remote,startWorker:false,setupToken:installCode,webRoot:join(directory,'absent-web')});
  let cookie='',csrf='';
  const request=(method:InjectOptions['method'],url:string,payload?:InjectOptions['payload'],headers:Record<string,string>={})=>created.app.inject({method,url,...(payload===undefined?{}:{payload}),headers:{host:'localhost:4317',...(cookie?{cookie}:{}),...(csrf?{'x-csrf-token':csrf}:{}),...headers}});
  const setup=async()=>{
    const response=await request('POST','/api/setup',{setupToken:installCode,password:administratorPassword});
    assert.equal(response.statusCode,200,response.body);
    cookie=String(response.headers['set-cookie']).split(';')[0];csrf=response.json().csrfToken;
  };
  const now=new Date().toISOString();
  const server=(await created.store.saveServer({id:randomUUID(),name:'Test server',host:'127.0.0.1',port:22,username:'ubuntu',group:'Tests',notes:'',fingerprint:'SHA256:fixture',createdAt:now,updatedAt:now}));
  const service=(await created.store.saveService({id:randomUUID(),name:'API',kind:'kubernetes',serverId:server.id,target:{namespace:'production',deployment:'api'},autoDeploy:false,environment:{DATABASE_PASSWORD:environmentSecret},createdAt:now,updatedAt:now}));
  const image=(await created.store.saveService({id:randomUUID(),name:'Docker service',kind:'image',serverId:server.id,target:{composeProject:'fixture-app',composeService:'app'},image:'nginx:alpine',autoDeploy:false,createdAt:now,updatedAt:now}));
  const connect=async ()=>(await created.store.vault.set(`ssh:${server.id}`,{password:sshPassword,hostKey}));
  if(options.credentials!==false)connect();
  if(options.setup!==false)await setup();
  return {...created,directory,remote,server,service,image,request,setup,connect,auth:()=>({cookie,csrf}),close:async()=>{await created.app.close();rmSync(directory,{recursive:true,force:true});}};
}
async function eventually(predicate:()=>boolean|Promise<boolean>):Promise<void> {
  for(let attempt=0;attempt<150;attempt++){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}
  throw new Error('Expected asynchronous job state was not reached');
}
function noSecrets(value:unknown):void {const text=typeof value==='string'?value:JSON.stringify(value);for(const secret of secrets)assert.equal(text.includes(secret),false,`Secret must not appear in a response or saved job: ${secret}`);}

test('K3s plans are authenticated and read-only; omitted runtime preserves the Docker plan',async()=>{
  const f=await fixture({setup:false,credentials:false});
  try {
    assert.equal((await f.request('GET',`/api/servers/${f.server.id}/bootstrap?runtime=k3s`)).statusCode,401);
    await f.setup();
    const before=(await f.store.snapshot());
    const k3s=await f.request('GET',`/api/servers/${f.server.id}/bootstrap?runtime=k3s`);
    assert.equal(k3s.statusCode,200,k3s.body);
    const plan=k3s.json<BootstrapPlan>();
    assert.equal(plan.runtime,'k3s');assert.equal(plan.serverId,f.server.id);
    assert.match(plan.version??'',/^v1\.\d+\.\d+\+k3s\d+$/);
    assert.ok(plan.commands.length>0);assert.match(plan.commands.join('\n'),/k3s/);
    const docker=await f.request('GET',`/api/servers/${f.server.id}/bootstrap`);
    assert.equal(docker.statusCode,200,docker.body);assert.equal(docker.json().runtime,'docker');
    assert.match(docker.json<BootstrapPlan>().commands.join('\n'),/docker/i);
    assert.equal((await f.request('GET',`/api/servers/${f.server.id}/bootstrap?runtime=unsupported`)).statusCode,400);
    assert.deepEqual((await f.store.snapshot()),before);
    assert.equal(f.remote.bootstrapCalls.length,0);assert.equal(f.remote.actionCalls.length,0);assert.equal(f.remote.probes,0);
  }finally{await f.close();}
});

test('K3s installation and service controls reject unauthenticated, CSRF, unbound and invalid requests',async()=>{
  const f=await fixture({setup:false,credentials:false});
  try {
    const bootstrap=`/api/servers/${f.server.id}/bootstrap`;
    const actions=`/api/services/${f.service.id}/actions`;
    const logs=`/api/services/${f.service.id}/logs`;
    assert.equal((await f.request('POST',bootstrap,{runtime:'k3s'})).statusCode,401);
    assert.equal((await f.request('POST',actions,{action:'restart'})).statusCode,401);
    assert.equal((await f.request('GET',logs)).statusCode,401);
    await f.setup();
    assert.equal((await f.request('POST',bootstrap,{runtime:'k3s'})).statusCode,400);
    assert.equal((await f.request('POST',actions,{action:'restart'})).statusCode,400);
    assert.equal((await f.request('GET',logs)).statusCode,400);
    f.connect();
    assert.equal((await f.request('POST',bootstrap,{runtime:'unsupported'})).statusCode,400);
    assert.equal((await f.request('POST',bootstrap,{runtime:'k3s',version:'v1.0.0+k3s1'})).statusCode,400);
    assert.equal((await f.request('POST',bootstrap,{runtime:'k3s'},{'x-csrf-token':''})).statusCode,403);
    assert.equal((await f.request('POST',actions,{action:'restart'},{'x-csrf-token':''})).statusCode,403);
    assert.equal((await f.request('POST',actions,{action:'delete'})).statusCode,400);
    assert.equal((await f.request('POST',`/api/services/${f.image.id}/actions`,{action:'stop'})).statusCode,400);
    await assert.rejects(async ()=>(await f.store.saveService({...f.service,id:randomUUID(),name:'Missing target',target:{}})),/namespace/);
    const invalidTarget=(await f.store.saveService({...f.service,id:randomUUID(),name:'Invalid target',target:{namespace:'Production',deployment:'api'}}));
    assert.equal((await f.request('POST',`/api/services/${invalidTarget.id}/actions`,{action:'start'})).statusCode,400);
    assert.equal((await f.request('GET',`/api/services/${invalidTarget.id}/logs`)).statusCode,400);
    assert.equal((await f.store.allJobs()).length,0);assert.equal(f.remote.bootstrapCalls.length,0);assert.equal(f.remote.actionCalls.length,0);
  }finally{await f.close();}
});

test('installation runtime and pinned version persist in the queued job across backend restart',async()=>{
  const f=await fixture();let closed=false;
  try {
    const review=await f.request('GET',`/api/servers/${f.server.id}/bootstrap?runtime=k3s`);
    const plan=review.json<BootstrapPlan>();
    const response=await f.request('POST',`/api/servers/${f.server.id}/bootstrap`,{runtime:'k3s'});
    assert.equal(response.statusCode,200,response.body);
    const queued=response.json<Job>();
    assert.equal(queued.type,'bootstrap');assert.equal(queued.state,'queued');
    assert.deepEqual(queued.bootstrap,{runtime:'k3s',version:plan.version});
    assert.equal(f.remote.bootstrapCalls.length,0);
    await f.app.close();closed=true;
    const remote=new KubernetesRemote();
    const reopened=await createApp({dataDir:f.directory,remote,startWorker:false,setupToken:installCode,webRoot:join(f.directory,'absent-web')});
    try {
      assert.deepEqual((await reopened.store.getJob(queued.id))?.bootstrap,{runtime:'k3s',version:plan.version});
      await reopened.jobs.tick();
      await eventually(async ()=>(await reopened.store.getJob(queued.id))?.state==='succeeded');
      assert.equal(remote.bootstrapCalls.length,1);
      assert.deepEqual(remote.bootstrapCalls[0],{serverId:f.server.id,options:{runtime:'k3s',version:plan.version}});
      assert.equal(remote.actionCalls.length,0);assert.equal(remote.submissions.length,0);
    }finally{await reopened.app.close();}
  }finally{if(!closed)await f.app.close();rmSync(f.directory,{recursive:true,force:true});}
});

test('Docker remains the default installation runtime and setup output is sanitized',async()=>{
  const f=await fixture();
  try {
    f.remote.bootstrapLog=unsafeLog;
    const response=await f.request('POST',`/api/servers/${f.server.id}/bootstrap`);
    assert.equal(response.statusCode,200,response.body);
    const queued=response.json<Job>();assert.equal(queued.bootstrap?.runtime,'docker');
    await f.jobs.tick();await eventually(async ()=>(await f.store.getJob(queued.id))?.state==='succeeded');
    assert.equal(f.remote.bootstrapCalls.length,1);assert.equal(f.remote.bootstrapCalls[0].options?.runtime,'docker');
    noSecrets((await f.store.getJob(queued.id)));
  }finally{await f.close();}
});

test('same-service management jobs deduplicate and server installation is mutually exclusive',async()=>{
  const f=await fixture();
  try {
    const actions=`/api/services/${f.service.id}/actions`;
    const bootstrap=`/api/servers/${f.server.id}/bootstrap`;
    const response=await f.request('POST',actions,{action:'restart'});
    assert.equal(response.statusCode,200,response.body);
    const queued=response.json<Job>();
    assert.equal(queued.type,'kubernetes');assert.equal(queued.action,'restart');assert.equal(queued.state,'queued');
    assert.equal((await f.request('POST',actions,{action:'stop'})).statusCode,400);
    assert.equal((await f.request('POST',bootstrap,{runtime:'k3s'})).statusCode,400);
    assert.equal((await f.store.allJobs()).length,1);
    (await f.store.updateJob(queued.id,{state:'cancelled',finishedAt:new Date().toISOString()}));
    const installation=await f.request('POST',bootstrap,{runtime:'k3s'});
    assert.equal(installation.statusCode,200,installation.body);
    assert.equal((await f.request('POST',actions,{action:'start'})).statusCode,400);
    assert.equal((await f.request('POST',`/api/services/${f.image.id}/deploy`)).statusCode,400);
    assert.equal(f.remote.actionCalls.length,0);assert.equal(f.remote.bootstrapCalls.length,0);assert.equal(f.remote.submissions.length,0);
  }finally{await f.close();}
});

test('Kubernetes actions use the exact saved target, do not guess replicas and sanitize persisted output',async()=>{
  const f=await fixture();
  try {
    f.remote.actionLog=unsafeLog;
    for(const action of ['stop','start','restart'] as const){
      const response=await f.request('POST',`/api/services/${f.service.id}/actions`,{action});
      assert.equal(response.statusCode,200,response.body);
      const job=response.json<Job>();
      await f.jobs.tick();await eventually(async ()=>(await f.store.getJob(job.id))?.state==='succeeded');
      const call=f.remote.actionCalls.at(-1)!;
      assert.deepEqual(call.target,{namespace:'production',deployment:'api'});assert.equal(call.serverId,f.server.id);assert.equal(call.action,action);
      assert.equal(call.options?.replicas,undefined,'replica count must be restored remotely from its saved annotation');
      noSecrets((await f.store.getJob(job.id)));
    }
    assert.equal(f.remote.actionCalls.length,3);assert.equal(f.remote.submissions.length,0);
  }finally{await f.close();}
});

test('unknown Kubernetes control results are never reissued on polling or backend restart',async()=>{
  const f=await fixture();let closed=false;
  try {
    f.remote.failAction=new Error(`SSH response lost after handoff; password=${environmentSecret}`);
    const response=await f.request('POST',`/api/services/${f.service.id}/actions`,{action:'restart'});
    assert.equal(response.statusCode,200,response.body);const queued=response.json<Job>();
    await f.jobs.tick();await eventually(async ()=>(await f.store.getJob(queued.id))?.state==='unknown');
    noSecrets((await f.store.getJob(queued.id)));
    await f.jobs.tick();await f.jobs.refreshJob(queued.id);
    assert.equal(f.remote.actionCalls.length,1);assert.equal(f.remote.statusReads,0);
    assert.equal((await f.request('POST',`/api/services/${f.service.id}/actions`,{action:'restart'})).statusCode,400);
    await f.app.close();closed=true;
    const remote=new KubernetesRemote();
    const reopened=await createApp({dataDir:f.directory,remote,startWorker:false,setupToken:installCode,webRoot:join(f.directory,'absent-web')});
    try {
      await reopened.jobs.tick();await reopened.jobs.refreshJob(queued.id);
      assert.equal((await reopened.store.getJob(queued.id))?.state,'unknown');
      assert.equal(remote.actionCalls.length,0);assert.equal(remote.bootstrapCalls.length,0);assert.equal(remote.statusReads,0);
    }finally{await reopened.app.close();}
  }finally{if(!closed)await f.app.close();rmSync(f.directory,{recursive:true,force:true});}
});

test('Kubernetes logs are read-only and redact saved environment and common credential formats',async()=>{
  const f=await fixture();
  try {
    f.remote.actionLog=unsafeLog;
    const before=(await f.store.snapshot());
    const response=await f.request('GET',`/api/services/${f.service.id}/logs`);
    assert.equal(response.statusCode,200,response.body);
    assert.equal(typeof response.json().log,'string');assert.match(response.json().log,/Service is ready/);
    noSecrets(response.body);
    assert.equal(f.remote.actionCalls.length,1);assert.equal(f.remote.actionCalls[0].action,'logs');
    assert.deepEqual(f.remote.actionCalls[0].target,{namespace:'production',deployment:'api'});
    assert.deepEqual((await f.store.snapshot()),before,'reading service logs must not enqueue a job or change catalog records');
    assert.equal(f.remote.submissions.length,0);assert.equal(f.remote.bootstrapCalls.length,0);
  }finally{await f.close();}
});

test('a backend interruption marks a running Kubernetes action unknown without issuing it again',async()=>{
  const f=await fixture();let closed=false;
  try {
    const response=await f.request('POST',`/api/services/${f.service.id}/actions`,{action:'stop'});
    assert.equal(response.statusCode,200,response.body);const queued=response.json<Job>();
    // A persisted running record is the state seen after the controller is interrupted.
    (await f.store.updateJob(queued.id,{state:'running',stage:'Executing remote stop'}));
    await f.app.close();closed=true;
    const remote=new KubernetesRemote();
    const reopened=await createApp({dataDir:f.directory,remote,startWorker:true,setupToken:installCode,webRoot:join(f.directory,'absent-web')});
    try {
      await eventually(async ()=>(await reopened.store.getJob(queued.id))?.state==='unknown');
      await reopened.jobs.refreshJob(queued.id);
      assert.equal(remote.actionCalls.length,0);assert.equal(remote.statusReads,0);assert.equal(remote.submissions.length,0);
      assert.equal((await reopened.store.getJob(queued.id))?.action,'stop');
    }finally{await reopened.app.close();}
  }finally{if(!closed)await f.app.close();rmSync(f.directory,{recursive:true,force:true});}
});


test('Kubernetes log errors also redact saved secrets and credentials',async()=>{
  const f=await fixture();
  try {
    f.remote.failAction=new Error(unsafeLog);
    const response=await f.request('GET',`/api/services/${f.service.id}/logs`);
    assert.equal(response.statusCode,400,response.body);
    assert.match(response.json().error,/Service is ready/);
    noSecrets(response.body);
    assert.equal((await f.store.allJobs()).length,0);assert.equal(f.remote.actionCalls.length,1);
  }finally{await f.close();}
});

test('an explicitly confirmed remote failure is failed rather than unknown and allows a manual retry',async()=>{
  const f=await fixture();
  try {
    f.remote.failAction=Object.assign(new Error(unsafeLog),{outcomeKnown:true});
    const response=await f.request('POST',`/api/services/${f.service.id}/actions`,{action:'start'});
    assert.equal(response.statusCode,200,response.body);const queued=response.json<Job>();
    await f.jobs.tick();await eventually(async ()=>(await f.store.getJob(queued.id))?.state==='failed');
    const failed=(await f.store.getJob(queued.id))!;
    assert.ok(failed.finishedAt);assert.ok(Number.isFinite(Date.parse(failed.finishedAt)));
    noSecrets(failed);
    assert.equal(f.remote.actionCalls.length,1);assert.equal(f.remote.statusReads,0);
    f.remote.failAction=undefined;
    const retry=await f.request('POST',`/api/services/${f.service.id}/actions`,{action:'start'});
    assert.equal(retry.statusCode,200,retry.body);assert.notEqual(retry.json().id,queued.id);
    await f.jobs.tick();await eventually(async ()=>(await f.store.getJob(retry.json().id))?.state==='succeeded');
    assert.equal(f.remote.actionCalls.length,2);
  }finally{await f.close();}
});
