import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AgentController } from '../server/agent-controller.js';
import { JobManager } from '../server/jobs.js';
import { ManagedRemote } from '../server/managed-remote.js';
import { SSHRemote, hostKeyFingerprint } from '../server/remote.js';
import { remoteJobStatus } from '../server/remote-status.js';
import { Store } from '../server/store.js';
import type { Server, Service } from '../shared/types.js';

const workerMetadata={id:'remote-job',serviceId:'remote-service',serverId:'remote-server',
  type:'bootstrap',source:'github',createdAt:'2026-10-19T00:00:00Z',updatedAt:'2026-10-19T00:00:01Z',
  finishedAt:'2026-10-19T00:00:02Z',pid:12345,bootId:'worker-boot',bootstrap:{runtime:'k3s'}};
const queued={...workerMetadata,state:'queued',stage:'queued',log:'accepted',revision:null,message:null};
const complete={...workerMetadata,state:'succeeded',stage:'complete',log:'deployment completed',revision:null,message:'Selected service was updated successfully'};

test('remote receipt strips worker/local identity fields and supports nullable optional metadata',()=>{
  assert.deepEqual(remoteJobStatus(queued),{state:'queued',stage:'queued',log:'accepted'});
  assert.deepEqual(remoteJobStatus({...complete,revision:'a'.repeat(40)}),{
    state:'succeeded',stage:'complete',log:'deployment completed',revision:'a'.repeat(40),message:complete.message,
  });
  assert.deepEqual(remoteJobStatus({state:'unknown',stage:'missing',log:null,revision:null,message:null}),{
    state:'unknown',stage:'missing',log:'',
  });
  assert.deepEqual(remoteJobStatus({state:'unknown',stage:'missing'}),{state:'unknown',stage:'missing',log:''});
});

test('remote receipt rejects malformed results and bounds returned log text',()=>{
  const valid={state:'running',stage:'pulling',log:''};
  for(const invalid of [null,[],{},true,'running',
    {...valid,state:'made-up'}, {...valid,state:1}, {...valid,stage:null}, {...valid,stage:''},
    {...valid,stage:'s'.repeat(513)}, {...valid,log:{}}, {...valid,log:'x'.repeat(4*1024*1024+1)},
    {...valid,revision:123}, {...valid,revision:'a'.repeat(257)},
    {...valid,message:[]}, {...valid,message:'m'.repeat(16*1024+1)},
  ])assert.throws(()=>remoteJobStatus(invalid),/Invalid remote job receipt/);
  const input={...valid,log:'discard-prefix'+'x'.repeat(128*1024)};
  assert.equal(remoteJobStatus(input).log,'x'.repeat(128*1024));
  assert.ok(input.log.startsWith('discard-prefix'),'normalization must not mutate the source result');
});

async function eventually(predicate:()=>boolean|Promise<boolean>):Promise<void> {
  for(let i=0;i<400;i++){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}
  throw new Error('Receipt fixture did not reach the expected state');
}

for(const connection of ['ssh','agent'] as const)test(`${connection}: submission and reconciliation cannot overwrite local Job identity or creation time`,{timeout:20_000},async()=>{
  const directory=mkdtempSync(join(tmpdir(),'serverdesk-receipt-boundary-'));
  const store=new Store(join(directory,'data'));await store.ready();
  let agents:AgentController|undefined;
  let jobs:JobManager|undefined;
  try {
    const now=new Date().toISOString();
    const hostKey='ssh-ed25519 '+Buffer.alloc(51,42).toString('base64');
    const server:Server={id:randomUUID(),name:'Receipt fixture',host:'127.0.0.1',port:22,username:'ubuntu',group:'',notes:'',connectionMode:connection,fingerprint:hostKeyFingerprint(hostKey),createdAt:now,updatedAt:now};
    (await store.saveServer(server));
    const service:Service={id:randomUUID(),name:'Receipt app',kind:'image',serverId:server.id,target:{composeProject:'fixture-app',composeService:'app'},image:'nginx:alpine',autoDeploy:false,createdAt:now,updatedAt:now};
    (await store.saveService(service));
    let malformed=false;
    const submitIds:string[]=[];
    let deliver:((expected:'submit'|'probe'|'status',value:unknown)=>Promise<void>)|undefined;
    if(connection==='ssh') {
      (await store.vault.set(`ssh:${server.id}`,{hostKey}));
      const ssh=join(directory,'ssh');
      const response=join(directory,'response.json');
      writeFileSync(response,JSON.stringify({queued,complete}));
      writeFileSync(ssh,`#!/usr/bin/env python3\nimport json,sys\nfrom pathlib import Path\nraw=sys.stdin.read()\np=json.loads(raw) if raw.strip() else {}\nr=json.loads(Path(${JSON.stringify(response)}).read_text())\nif 'plan' in p: value=r['queued']\nelif 'jobId' in p: value=r['complete']\nelse: value={'hostname':'receipt-fixture','dockerAvailable':True,'composeAvailable':True,'services':[]}\nprint(json.dumps(value))\n`,{mode:0o700});
      jobs=new JobManager(store,new SSHRemote({dataDir:directory,sshPath:ssh}));
      // Used after successful reconciliation to exercise the actual SSH status parser.
      deliver=async()=>{writeFileSync(response,JSON.stringify({queued,complete:{state:'succeeded',stage:'complete',log:123}}));};
    } else {
      agents=new AgentController(store,{waitIntervalMs:1});
      const identity=(await agents.register({...(await agents.createPairing(server.id)),hostname:'receipt-fixture',version:'0.3.0'}));
      assert.equal(identity.serverId,server.id);
      jobs=new JobManager(store,new ManagedRemote(store,agents));
      deliver=async(expected,value)=>{
        let command:Awaited<ReturnType<AgentController['poll']>>['command']=null;
        await eventually(async ()=>{command=(await agents!.poll(server.id,{hostname:'receipt-fixture',version:'0.3.0'})).command;return command!==null;});
        const accepted=command as unknown as {id:string;operation:string};
        assert.equal(accepted.operation,expected);
        if(expected==='submit')submitIds.push(accepted.id);
        await agents!.acknowledge(server.id,accepted.id);
        await agents!.result(server.id,accepted.id,{ok:true,value:malformed?{state:'succeeded',stage:'complete',log:123}:value});
      };
    }

    const created=(await jobs.enqueue(service.id));
    const initial=structuredClone(created);
    const tick=jobs.tick();
    if(connection==='agent') {
      await deliver!('submit',queued);
      await deliver!('probe',{hostname:'receipt-fixture',dockerAvailable:true,composeAvailable:true,services:[]});
    }
    await tick;
    await eventually(async ()=>{const job=await store.getJob(created.id);return job?.state==='running'&&job.stage==='queued';});
    const accepted=(await store.getJob(created.id))!;
    assert.equal(accepted.createdAt,initial.createdAt);
    assert.equal(accepted.stage,'queued');

    const reading=jobs.refreshJob(created.id);
    if(connection==='agent')await deliver!('status',complete);
    const reconciled=await reading;
    assert.equal(reconciled.state,'succeeded');
    assert.equal(reconciled.message,complete.message);
    for(const key of ['id','serverId','serviceId','type','source','createdAt'] as const)assert.equal(reconciled[key],initial[key],key+' must remain local');
    for(const key of ['pid','bootId','bootstrap'])assert.equal(key in reconciled,false);
    assert.notEqual(reconciled.updatedAt,workerMetadata.updatedAt);
    assert.notEqual(reconciled.finishedAt,workerMetadata.finishedAt);
    assert.equal((await store.allJobs()).length,1,'receipt metadata must not insert another Job');
    assert.equal((await store.getJob(workerMetadata.id)),undefined);
    if(connection==='agent')assert.equal(submitIds.length,1,'reconciliation must not resubmit deployment');

    // Both public transports must reject malformed status results, rather than
    // coercing a non-string log and accidentally treating the update as success.
    if(connection==='ssh')await deliver!('status',undefined);
    else malformed=true;
    const transport=jobs.remote;
    const invalid=transport.status(reconciled,server,(await jobs.credentials(server.id)));
    if(connection==='agent')await deliver!('status',undefined);
    await assert.rejects(invalid,/Invalid remote job receipt/);
  } finally {
    jobs?.stop();(await agents?.close());(await store.close());rmSync(directory,{recursive:true,force:true});
  }
});
