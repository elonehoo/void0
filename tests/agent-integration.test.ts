import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';
import { createApp } from '../server/app.js';
import { ManagedRemote } from '../server/managed-remote.js';
import { Store } from '../server/store.js';
import type { Server } from '../shared/types.js';

const installCode='agent-http-fixture-install-code';
const password='agent-http-fixture-admin-password';
async function fixture() {
  const directory=mkdtempSync(join(tmpdir(),'serverdesk-agent-http-'));
  const created=await createApp({dataDir:join(directory,'data'),setupToken:installCode,startWorker:false,webRoot:join(directory,'absent-web')});
  const url=await created.app.listen({host:'127.0.0.1',port:0});
  const server=async (name='Agent fixture'):Promise<Server>=>{
    const date=new Date().toISOString();
    return (await created.store.saveServer({id:randomUUID(),name,host:'127.0.0.1',port:1,username:'ubuntu',group:'',notes:'',createdAt:date,updatedAt:date}));
  };
  const request=(path:string,body?:unknown,headers:Record<string,string>={})=>fetch(url+path,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'content-type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const register=async(serverId:string)=>{
    const pairing=(await created.agents.createPairing(serverId));
    const response=await request('/api/agent/register',{pairingToken:pairing.pairingToken,hostname:'http-fixture-host',version:'0.3.0'});
    assert.equal(response.status,200,'real Agent registration must succeed');
    return {...await response.json() as {serverId:string;token:string;pollIntervalSeconds:number},pairingToken:pairing.pairingToken};
  };
  return {...created,directory,url,server,request,register};
}
async function eventually(predicate:()=>boolean|Promise<boolean>,timeout=20_000):Promise<void> {
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,25));}
  throw new Error('The local Agent did not reach its expected state before the timeout.');
}
async function stop(child:ChildProcess|undefined):Promise<void> {
  if(!child||child.exitCode!==null||child.signalCode!==null)return;
  await new Promise<void>(resolve=>{
    const force=setTimeout(()=>child.kill('SIGKILL'),6_000);
    child.once('exit',()=>{clearTimeout(force);resolve();});
    child.kill('SIGTERM');
  });
}
function tarFiles(bundle:Buffer):Map<string,Buffer> {
  const tar=gunzipSync(bundle),files=new Map<string,Buffer>();
  let offset=0;
  while(offset+512<=tar.length){
    const header=tar.subarray(offset,offset+512);
    if(header.every(byte=>byte===0))break;
    const name=header.subarray(0,100).toString('utf8').replace(/\0.*$/s,'');
    const size=parseInt(header.subarray(124,136).toString('ascii').replace(/\0.*$/s,'').trim(),8);
    assert.ok(Number.isSafeInteger(size)&&size>=0&&offset+512+size<=tar.length,'bundle must contain complete tar members');
    assert.equal(header[156],48,'bundle must only contain regular files');
    assert.equal(files.has(name),false,'bundle must not repeat paths');
    files.set(name,tar.subarray(offset+512,offset+512+size));
    offset+=512+Math.ceil(size/512)*512;
  }
  assert.ok(tar.subarray(offset).every(byte=>byte===0),'bundle must not contain trailing data');
  return files;
}

test('real Python Agent executes fixed operations through real HTTP and persists Jobs without SSH', {timeout:60_000},async()=>{
  const f=await fixture();let child:ChildProcess|undefined;let closed=false;
  let daemonOutput='';
  try {
    const server=await f.server(),identity=await f.register(server.id);
    assert.equal((await f.store.getServer(server.id))?.connectionMode,'agent');
    assert.equal((await f.store.vault.has(`ssh:${server.id}`)),false,'fixture intentionally has no SSH credentials');
    let sshCalls=0;
    const remote=f.jobs.remote as ManagedRemote;
    assert.ok(remote instanceof ManagedRemote);
    for(const method of ['probe','bootstrap','kubernetesAction','submit','status'] as const)Object.defineProperty(remote.ssh,method,{value:async()=>{sshCalls++;throw new Error('This Agent fixture must never use SSH.');}});
    const agentDir=join(f.directory,'agent');mkdirSync(agentDir,{mode:0o700});
    const configPath=join(agentDir,'config.json'),programsPath=join(agentDir,'programs.json');
    writeFileSync(configPath,JSON.stringify({url:f.url,token:identity.token,serverId:server.id}),{mode:0o600});
    const python=(script:string)=>({language:'python',script,timeoutSeconds:10,outputLimit:4096});
    const probe=python('import json\nprint(json.dumps({"hostname":"fixture-agent-executed","dockerAvailable":True,"composeAvailable":True,"k3sAvailable":True,"k3sReady":True,"k3sNodeCount":1,"memoryTotal":8589934592,"services":[{"name":"fixture-app","kind":"Kubernetes","namespace":"fixture","deployment":"web","ready":True,"state":"running"}]}))');
    const bootstrap={language:'shell',script:'printf "Fixture runtime checked by Python Agent\\n"',timeoutSeconds:10,outputLimit:4096};
    writeFileSync(programsPath,JSON.stringify({probe,bootstrap:{docker:bootstrap,k3s:bootstrap},'kubernetes-action':python('import json,sys\np=json.load(sys.stdin)\nassert p["target"]=={"namespace":"fixture","deployment":"web"}\nassert p["action"]=="restart"\nprint(json.dumps({"log":"Fixture restart executed by Python Agent","replicas":1}))'),submit:python('print(\'{"state":"succeeded","stage":"fixture","log":"fixture"}\')'),status:python('print(\'{"state":"succeeded","stage":"fixture","log":"fixture"}\')')}),{mode:0o600});
    child=spawn('python3',[resolve('agent/daemon.py'),'run','--config',configPath,'--programs',programsPath,'--state-dir',join(agentDir,'state')],{stdio:['ignore','pipe','pipe']});
    child.stdout?.on('data',data=>{daemonOutput+=String(data);});child.stderr?.on('data',data=>{daemonOutput+=String(data);});
    await eventually(()=>daemonOutput.includes('void0 OS started'));
    const status=await f.jobs.refreshServer(server.id);
    assert.equal(status.hostname,'fixture-agent-executed');assert.equal(status.serverId,server.id);assert.equal(status.error,undefined);
    assert.equal(status.k3sReady,true);assert.equal(status.services?.[0].deployment,'web');
    assert.equal((await f.store.getSetting<{hostname:string}>(`status:server:${server.id}`))?.hostname,'fixture-agent-executed');
    const date=new Date().toISOString(),service=(await f.store.saveService({id:randomUUID(),name:'Fixture app',kind:'kubernetes',serverId:server.id,target:{namespace:'fixture',deployment:'web'},autoDeploy:false,createdAt:date,updatedAt:date}));
    const operation=(await f.jobs.enqueueKubernetes(service.id,'restart'));assert.equal(operation.state,'queued');
    await f.jobs.tick();await eventually(async ()=>(await f.store.getJob(operation.id))?.state==='succeeded');
    assert.match((await f.store.getJob(operation.id))?.log??'',/Fixture restart executed by Python Agent/);
    await eventually(async ()=>(await f.agents.info(server.id)).pending===0);
    const installation=(await f.jobs.enqueueBootstrap(server.id,{runtime:'k3s'}));assert.equal(installation.state,'queued');
    await f.jobs.tick();await eventually(async ()=>(await f.store.getJob(installation.id))?.state==='succeeded');
    assert.match((await f.store.getJob(installation.id))?.log??'',/Fixture runtime checked by Python Agent/);
    await eventually(async ()=>(await f.agents.info(server.id)).pending===0);
    assert.equal(sshCalls,0);assert.equal(child.exitCode,null,'Agent must remain running between commands');
    assert.equal(daemonOutput.includes(identity.token),false,'Agent output must not expose its credential');
    await stop(child);child=undefined;await f.app.close();closed=true;
    const reopened=new Store(join(f.directory,'data'));await reopened.ready();
    try {for(const id of [operation.id,installation.id])assert.equal((await reopened.getJob(id))?.state,'succeeded','completed jobs must survive reopening SQLite');}finally{(await reopened.close());}
  }finally{
    await stop(child);if(!closed)await f.app.close();rmSync(f.directory,{recursive:true,force:true});
  }
});

test('public Agent bundle is verifiable while pairing and commands enforce account and server boundaries',{timeout:20_000},async()=>{
  const f=await fixture();
  try {
    const server=await f.server(),other=await f.server('Other Agent');
    const manifestResponse=await f.request('/api/agent/manifest');assert.equal(manifestResponse.status,200);
    const manifest=await manifestResponse.json() as {version:string;sha256:string};
    const bundleResponse=await f.request('/api/agent/bundle');assert.equal(bundleResponse.status,200);
    const bundle=Buffer.from(await bundleResponse.arrayBuffer());
    assert.equal(createHash('sha256').update(bundle).digest('hex'),manifest.sha256);
    const files=tarFiles(bundle);
    assert.deepEqual([...files.keys()].sort(),['daemon.py','install.sh','programs.json','serverdesk-agent.service']);
    assert.deepEqual(files.get('daemon.py'),readFileSync(resolve('agent/daemon.py')));
    assert.deepEqual(files.get('install.sh'),readFileSync(resolve('agent/install.sh')));
    assert.deepEqual(Object.keys(JSON.parse(files.get('programs.json')!.toString('utf8'))).sort(),['bootstrap','domain','kubernetes-action','probe','status','submit']);
    const pairingPath=`/api/servers/${server.id}/agent/pairing`;
    assert.equal((await f.request(pairingPath,{})).status,401,'pairing requires the administrator session');
    const setup=await f.request('/api/setup',{setupToken:installCode,password});assert.equal(setup.status,200);
    const cookie=setup.headers.get('set-cookie')!.split(';')[0],csrf=(await setup.json() as {csrfToken:string}).csrfToken;
    assert.equal((await f.request(pairingPath,{},{cookie})).status,403,'pairing requires CSRF protection');
    const admin={cookie,'x-csrf-token':csrf};
    assert.equal((await f.request(pairingPath,{},admin)).status,400,'pairing requires a configured HTTPS management origin');
    assert.equal((await f.request('/api/settings',{publicUrl:'http://example.invalid'},admin)).status,400);
    assert.equal((await f.request('/api/settings',{publicUrl:'https://console.example.invalid'},admin)).status,200);
    const paired=await f.request(pairingPath,{},admin);assert.equal(paired.status,200);
    const pairing=await paired.json() as {pairingToken:string;installCommand:string};
    assert.equal(pairing.installCommand.includes(pairing.pairingToken),false,'installation command must not put a pairing secret in shell history');
    const registration=await f.request('/api/agent/register',{pairingToken:pairing.pairingToken,hostname:'boundary-agent',version:'0.3.0'});assert.equal(registration.status,200);
    const identity=await registration.json() as {serverId:string;token:string};
    const second=await f.register(other.id);
    const workspace=await f.request('/api/workspace',undefined,{cookie});assert.equal(workspace.status,200);const body=await workspace.text();
    for(const secret of [identity.token,second.token,pairing.pairingToken,second.pairingToken])assert.equal(body.includes(secret),false,'workspace must never expose Agent credentials');
    assert.equal((await f.request('/api/agent/poll',{hostname:'unknown',version:'0.3.0'},{authorization:'Bearer sd_agent_not-a-valid-credential'})).status,401);
    const completion=f.agents.command(server.id,'probe',{},5_000).then(value=>({value,error:undefined}),error=>({value:undefined,error}));
    const poll=await f.request('/api/agent/poll',{hostname:'boundary-agent',version:'0.3.0'},{authorization:`Bearer ${identity.token}`});assert.equal(poll.status,200);
    const command=(await poll.json() as {command:{id:string}}).command;assert.ok(command);
    const ackPath=`/api/agent/commands/${command.id}/ack`,resultPath=`/api/agent/commands/${command.id}/result`;
    const wrongAgent={authorization:`Bearer ${second.token}`},rightAgent={authorization:`Bearer ${identity.token}`};
    assert.equal((await f.request(ackPath,{},wrongAgent)).status,400,'another server must not acknowledge this command');
    assert.equal((await f.request(resultPath,{ok:true,value:'wrong server'},wrongAgent)).status,400,'another server must not complete this command');
    assert.equal((await f.request(ackPath,{},rightAgent)).status,200);
    assert.equal((await f.request(resultPath,{ok:true,value:{verified:true}},rightAgent)).status,200);
    assert.deepEqual((await completion).value,{verified:true});
  }finally{await f.app.close();rmSync(f.directory,{recursive:true,force:true});}
});
