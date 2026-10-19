import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { AgentCommandError, AgentController } from '../server/agent-controller.js';
import { Store } from '../server/store.js';

const metadata={hostname:'fixture-host',version:'0.1.0'};
async function fixture() {
  const directory=mkdtempSync(join(tmpdir(),'serverdesk-agent-controller-'));
  const store=new Store(directory);await store.ready();
  let now=Date.now();
  const server=async (name='Fixture')=>{
    const date=new Date(now).toISOString();
    return (await store.saveServer({id:randomUUID(),name,host:'127.0.0.1',port:22,username:'ubuntu',group:'',notes:'',createdAt:date,updatedAt:date}));
  };
  const first=await server(),controller=new AgentController(store,{now:()=>now,waitIntervalMs:1});
  await controller.ready();
  const bind=async (serverId=first.id)=>(await controller.register({...metadata,pairingToken:(await controller.createPairing(serverId)).pairingToken}));
  return {directory,store,server,first,controller,bind,advance:(ms:number)=>{now+=ms;},cleanup:async ()=>{(await controller.close());(await store.close());rmSync(directory,{recursive:true,force:true});}};
}
async function pending(f:Awaited<ReturnType<typeof fixture>>,count:number):Promise<void> {
  for(let i=0;i<200;i++){if((await f.controller.info(f.first.id)).pending===count)return;await new Promise(resolve=>setTimeout(resolve,1));}
  throw new Error('Expected durable command queue state was not reached');
}
const settled=<T>(promise:Promise<T>)=>promise.then(value=>({value,error:undefined}),error=>({value:undefined,error:error as AgentCommandError}));

test('pairing codes expire, are single use and replaced without disconnecting the old agent',async ()=>{
  const f=await fixture();try {
    const initial=await f.bind();assert.equal((await f.controller.authenticate(initial.token)),f.first.id);
    const replacement=(await f.controller.createPairing(f.first.id));
    assert.equal((await f.controller.info(f.first.id)).pairingPending,true);
    assert.equal((await f.controller.authenticate(initial.token)),f.first.id);
    f.advance(15*60_000);
    await assert.rejects(async ()=>(await f.controller.register({...metadata,pairingToken:replacement.pairingToken})),/无效或已过期/);
    assert.equal((await f.controller.info(f.first.id)).pairingPending,false);
    const stale=(await f.controller.createPairing(f.first.id)),fresh=(await f.controller.createPairing(f.first.id));
    await assert.rejects(async ()=>(await f.controller.register({...metadata,pairingToken:stale.pairingToken})),/无效或已过期/);
    const next=(await f.controller.register({...metadata,pairingToken:fresh.pairingToken}));
    await assert.rejects(async ()=>(await f.controller.authenticate(initial.token)),/身份验证失败/);
    assert.equal((await f.controller.authenticate(next.token)),f.first.id);
    await assert.rejects(async ()=>(await f.controller.register({...metadata,pairingToken:fresh.pairingToken})),/无效或已过期/);
    (await f.controller.revoke(f.first.id));
    await assert.rejects(async ()=>(await f.controller.authenticate(next.token)),/身份验证失败/);
    assert.equal((await f.controller.info(f.first.id)).configured,false);
  }finally{await f.cleanup();}
});

test('one server only receives its own command once, and result needs an acknowledgement',async()=>{
  const f=await fixture();try {
    await f.bind();const second=await f.server('Second');await f.bind(second.id);
    const completed=settled(f.controller.command<{services:string[]}>(f.first.id,'probe',{serverId:f.first.id}));await pending(f,1);
    assert.equal((await f.controller.info(f.first.id)).pending,1);
    assert.deepEqual((await f.controller.poll(second.id,metadata)),{command:null});
    const command=(await f.controller.poll(f.first.id,metadata)).command!;
    assert.equal(command.operation,'probe');assert.deepEqual(command.payload,{serverId:f.first.id});
    assert.deepEqual((await f.controller.poll(f.first.id,metadata)),{command:null});
    await assert.rejects(async ()=>(await f.controller.acknowledge(second.id,command.id)),/不存在/);
    await assert.rejects(async ()=>(await f.controller.result(f.first.id,command.id,{ok:true,value:'unacknowledged'})),/不可重复提交/);
    (await f.controller.acknowledge(f.first.id,command.id));(await f.controller.acknowledge(f.first.id,command.id));
    await assert.rejects(async ()=>(await f.controller.result(second.id,command.id,{ok:true,value:'wrong-server'})),/不存在/);
    (await f.controller.result(f.first.id,command.id,{ok:true,value:{services:['web']}}));
    assert.deepEqual((await completed).value,{services:['web']});
    (await f.controller.acknowledge(f.first.id,command.id));
    (await f.controller.result(f.first.id,command.id,{ok:true,value:{services:['web']}}));
    await assert.rejects(async ()=>(await f.controller.result(f.first.id,command.id,{ok:true,value:'overwrite'})),/不可重复提交/);
    assert.equal((await f.controller.info(f.first.id)).pending,0);
  }finally{await f.cleanup();}
});

test('busy heartbeats keep an agent online without claiming queued work',async()=>{
  const f=await fixture();try {
    await f.bind();const completed=settled(f.controller.command(f.first.id,'probe',{}));await pending(f,1);
    f.advance(40_000);
    assert.deepEqual((await f.controller.poll(f.first.id,{...metadata,busy:true})),{command:null});
    f.advance(40_000);assert.equal((await f.controller.info(f.first.id)).online,true);
    const command=(await f.controller.poll(f.first.id,metadata)).command!;assert.ok(command);
    (await f.controller.acknowledge(f.first.id,command.id));(await f.controller.result(f.first.id,command.id,{ok:true,value:true}));
    assert.equal((await completed).value,true);
    f.advance(45_001);assert.equal((await f.controller.info(f.first.id)).online,false);
    const offline=await settled(f.controller.command(f.first.id,'probe',{}));
    assert.equal(offline.error?.outcomeKnown,true);assert.match(offline.error?.message??'',/尚未连接/);
  }finally{await f.cleanup();}
});

test('unclaimed timeout is definitely unexecuted; a claimed timeout is unknown and never resent',async()=>{
  const f=await fixture();try {
    await f.bind();
    const unclaimed=settled(f.controller.command(f.first.id,'bootstrap',{runtime:'docker'},10));await pending(f,1);
    f.advance(11);assert.equal((await unclaimed).error?.outcomeKnown,true);
    assert.deepEqual((await f.controller.poll(f.first.id,metadata)),{command:null});
    const claimed=settled(f.controller.command(f.first.id,'bootstrap',{runtime:'docker'},10));await pending(f,1);
    const command=(await f.controller.poll(f.first.id,metadata)).command!;
    f.advance(11);const error=(await claimed).error!;
    assert.equal(error.outcomeKnown,false);assert.match(error.message,/结果未知/);
    assert.deepEqual((await f.controller.poll(f.first.id,metadata)),{command:null});
    await assert.rejects(async ()=>(await f.controller.acknowledge(f.first.id,command.id)),/不可确认/);
    await assert.rejects(async ()=>(await f.controller.result(f.first.id,command.id,{ok:true,value:'late'})),/不可重复提交/);
  }finally{await f.cleanup();}
});

test('controller restart cancels queued work and does not replay work already handed to an agent',async()=>{
  const f=await fixture();let reopened:AgentController|undefined;
  try {
    const identity=await f.bind();
    const claimed=settled(f.controller.command(f.first.id,'submit',{secret:'fixture-private-environment'}));await pending(f,1);
    const command=(await f.controller.poll(f.first.id,metadata)).command!;
    (await f.controller.acknowledge(f.first.id,command.id));
    const queued=settled(f.controller.command(f.first.id,'status',{id:'job-reference'}));await pending(f,2);
    reopened=new AgentController(f.store,{waitIntervalMs:1});
    assert.equal((await reopened.authenticate(identity.token)),f.first.id);
    assert.deepEqual((await reopened.poll(f.first.id,metadata)),{command:null});
    assert.equal((await claimed).error?.outcomeKnown,false);
    assert.equal((await queued).error?.outcomeKnown,true);
    assert.equal((await reopened.info(f.first.id)).pending,0);
  }finally{(await reopened?.close());await f.cleanup();}
});

test('payloads, results and authentication secrets are absent from settings and database plaintext',async()=>{
  const f=await fixture();try {
    const pairing=(await f.controller.createPairing(f.first.id)),identity=(await f.controller.register({...metadata,pairingToken:pairing.pairingToken}));
    const payloadSecret='fixture-payload-super-secret',resultSecret='fixture-result-super-secret';
    const completed=settled(f.controller.command(f.first.id,'submit',{environment:{PASSWORD:payloadSecret}}));await pending(f,1);
    const db=new DatabaseSync(join(f.directory,'workspace.sqlite'),{readOnly:true});
    const plaintext=()=>JSON.stringify(db.prepare('SELECT json FROM settings').all())+JSON.stringify(db.prepare('SELECT value FROM secrets').all());
    for (const secret of [pairing.pairingToken,identity.token,payloadSecret]) assert.equal(plaintext().includes(secret),false);
    const command=(await f.controller.poll(f.first.id,metadata)).command!;
    (await f.controller.acknowledge(f.first.id,command.id));(await f.controller.result(f.first.id,command.id,{ok:true,value:{private:resultSecret}}));
    assert.deepEqual((await completed).value,{private:resultSecret});
    assert.equal(plaintext().includes(resultSecret),false);db.close();
    assert.equal(JSON.stringify((await f.controller.info(f.first.id))).includes(identity.token),false);
    for (const suffix of ['', '-wal']) { const data=readFileSync(join(f.directory,`workspace.sqlite${suffix}`));for (const secret of [pairing.pairingToken,identity.token,payloadSecret,resultSecret]) assert.equal(data.includes(Buffer.from(secret)),false); }
  }finally{await f.cleanup();}
});

test('a returned failure exposes no raw error and preserves the known or unknown outcome',async()=>{
  const f=await fixture();try {
    await f.bind();
    for (const outcomeKnown of [false,true]) {
      const completed=settled(f.controller.command(f.first.id,'bootstrap',{}));await pending(f,1);
      const command=(await f.controller.poll(f.first.id,metadata)).command!;(await f.controller.acknowledge(f.first.id,command.id));
      (await f.controller.result(f.first.id,command.id,{ok:false,error:'PASSWORD=fixture-must-not-leak',outcomeKnown}));
      const error=(await completed).error!;assert.ok(error instanceof AgentCommandError);assert.equal(error.outcomeKnown,outcomeKnown);assert.equal(error.message.includes('fixture-must-not-leak'),false);
    }
  }finally{await f.cleanup();}
});

test('active jobs prevent pairing, replacing and revoking an agent inside the controller',async ()=>{
  const f=await fixture();try {
    const identity=await f.bind(),replacement=(await f.controller.createPairing(f.first.id));
    const now=new Date().toISOString(),jobId=randomUUID();
    (await f.store.enqueue({id:jobId,serviceId:'',serverId:f.first.id,type:'bootstrap',source:'manual',state:'queued',stage:'queued',log:'',createdAt:now,updatedAt:now}));
    for (const state of ['queued','running','unknown'] as const) {
      (await f.store.updateJob(jobId,{state}));
      await assert.rejects(async ()=>(await f.controller.createPairing(f.first.id)),/未结束的任务/);
      await assert.rejects(async ()=>(await f.controller.register({...metadata,pairingToken:replacement.pairingToken})),/未结束的任务/);
      await assert.rejects(async ()=>(await f.controller.revoke(f.first.id)),/未结束的任务/);
      assert.equal((await f.controller.authenticate(identity.token)),f.first.id);
    }
    (await f.store.updateJob(jobId,{state:'succeeded'}));
    const next=(await f.controller.register({...metadata,pairingToken:replacement.pairingToken}));assert.equal((await f.controller.authenticate(next.token)),f.first.id);
  }finally{await f.cleanup();}
});

test('shutdown marks accepted commands unknown before closing the database',async()=>{
  const f=await fixture();try {
    await f.bind();const accepted=settled(f.controller.command(f.first.id,'submit',{}));await pending(f,1);
    (await f.controller.poll(f.first.id,metadata));
    const queued=settled(f.controller.command(f.first.id,'probe',{}));await pending(f,2);
    (await f.controller.close());
    assert.equal((await accepted).error?.outcomeKnown,false);
    assert.equal((await queued).error?.outcomeKnown,true);
    await assert.rejects(async ()=>(await f.controller.info(f.first.id)),/已停止/);
  }finally{await f.cleanup();}
});

test('hashed agent authentication survives reopening the real SQLite database',async ()=>{
  const f=await fixture();const identity=await f.bind();
  (await f.controller.close());(await f.store.close());
  const store=new Store(f.directory);await store.ready();
  const controller=new AgentController(store);await controller.ready();
  try {
    assert.equal((await controller.authenticate(identity.token)),f.first.id);
    assert.equal((await controller.info(f.first.id)).hostname,metadata.hostname);
    assert.deepEqual((await controller.poll(f.first.id,metadata)),{command:null});
    await assert.rejects(async ()=>(await controller.authenticate(`${identity.token}tampered`)),/身份验证失败/);
    (await controller.revoke(f.first.id));
    await assert.rejects(async ()=>(await controller.authenticate(identity.token)),/身份验证失败/);
  }finally{(await controller.close());(await store.close());rmSync(f.directory,{recursive:true,force:true});}
});

test('invalid operations, oversized command bodies and malformed metadata never enter the queue',async()=>{
  const f=await fixture();try {
    await f.bind();
    const invalid=await settled(f.controller.command(f.first.id,'shell' as never,{command:'arbitrary code'}));
    assert.equal(invalid.error?.outcomeKnown,true);
    const oversized=await settled(f.controller.command(f.first.id,'submit',{archive:'x'.repeat(30*1024*1024)}));
    assert.equal(oversized.error?.outcomeKnown,true);
    await assert.rejects(async ()=>(await f.controller.poll(f.first.id,{...metadata,hostname:'line\nbreak'})),/资料无效/);
    await assert.rejects(async ()=>(await f.controller.poll(f.first.id,{...metadata,busy:'yes' as never})),/资料无效/);
    await assert.rejects(async ()=>(await f.controller.register({...metadata,pairingToken:'x'.repeat(200)})),/无效或已过期/);
    await assert.rejects(async ()=>(await f.controller.authenticate('')),/身份验证失败/);
    assert.equal((await f.controller.info(f.first.id)).pending,0);
    assert.deepEqual((await f.controller.poll(f.first.id,metadata)),{command:null});
  }finally{await f.cleanup();}
});

test('revocation cancels unclaimed work and preserves uncertainty for accepted work',async()=>{
  const f=await fixture();try {
    const identity=await f.bind();
    const accepted=settled(f.controller.command(f.first.id,'submit',{}));await pending(f,1);
    (await f.controller.poll(f.first.id,metadata));
    const queued=settled(f.controller.command(f.first.id,'probe',{}));await pending(f,2);
    (await f.controller.revoke(f.first.id));
    assert.equal((await accepted).error?.outcomeKnown,false);
    assert.equal((await queued).error?.outcomeKnown,true);
    assert.equal((await f.controller.info(f.first.id)).configured,false);
    await assert.rejects(async ()=>(await f.controller.authenticate(identity.token)),/身份验证失败/);
  }finally{await f.cleanup();}
});

test('concurrent registration and polling preserve single-use identity and command delivery',async()=>{
  const f=await fixture();
  try {
    const pairing=await f.controller.createPairing(f.first.id);
    const registrations=await Promise.allSettled([
      f.controller.register({...metadata,pairingToken:pairing.pairingToken}),
      f.controller.register({...metadata,pairingToken:pairing.pairingToken}),
    ]);
    assert.equal(registrations.filter(result=>result.status==='fulfilled').length,1);
    assert.equal(registrations.filter(result=>result.status==='rejected').length,1);
    const completed=settled(f.controller.command(f.first.id,'probe',{}));
    await pending(f,1);
    const responses=await Promise.all([f.controller.poll(f.first.id,metadata),f.controller.poll(f.first.id,metadata)]);
    const commands=responses.flatMap(response=>response.command?[response.command]:[]);
    assert.equal(commands.length,1,'concurrent polling must only claim a command once');
    await f.controller.acknowledge(f.first.id,commands[0].id);
    await f.controller.result(f.first.id,commands[0].id,{ok:true,value:'single-delivery'});
    assert.equal((await completed).value,'single-delivery');
  }finally{await f.cleanup();}
});

test('deployment protection reflects the latest node heartbeat and never defaults to strict',async()=>{
  const f=await fixture();
  try {
    await f.bind();
    assert.deepEqual((await f.controller.info(f.first.id)).deploymentProtection,{mode:'compatibility'});
    await f.controller.poll(f.first.id,{...metadata,busy:true,deploymentProtection:{mode:'strict',policyVersion:7}});
    assert.deepEqual((await f.controller.info(f.first.id)).deploymentProtection,{mode:'strict',policyVersion:7});
    await f.controller.poll(f.first.id,{...metadata,busy:true});
    assert.deepEqual((await f.controller.info(f.first.id)).deploymentProtection,{mode:'compatibility'},'an older node must not inherit a stale strict status');
    await assert.rejects(()=>f.controller.poll(f.first.id,{...metadata,deploymentProtection:{mode:'strict',policyVersion:0}}),/保护资料无效/);
  }finally{await f.cleanup();}
});
