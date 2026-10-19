import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Pool } from 'pg';
import type { LightMyRequestResponse } from 'fastify';
import { createApp } from '../server/app.js';
import type { AgentCommand } from '../server/agent-controller.js';
import type { Job, RemoteTransport, Service } from '../shared/types.js';

const testUrl=(process.env.VOID0_TEST_POSTGRES_URL??process.env.SERVERDESK_TEST_POSTGRES_URL);

test('PostgreSQL API preserves sessions, single-use Agent handoff and interrupted deployment reconciliation',{skip:!testUrl,timeout:30_000},async()=>{
  assert.ok(testUrl);
  const parsed=new URL(testUrl);
  if(!parsed.pathname.slice(1).startsWith('serverdesk_test'))throw new Error('PostgreSQL API tests require a dedicated serverdesk_test database');
  const administrator=new Pool({connectionString:testUrl});
  const name=`serverdesk_test_${randomUUID().replaceAll('-','')}`;
  await administrator.query(`CREATE DATABASE "${name}"`);
  parsed.pathname='/'+name;
  const directory=mkdtempSync(join(tmpdir(),'serverdesk-pg-api-'));
  const options={dataDir:directory,databaseUrl:parsed.toString(),startWorker:false,setupToken:'pg-api-install-token',webRoot:join(directory,'absent')};
  let submissions=0;
  const remote:RemoteTransport={
    fingerprint:async()=>({fingerprint:'unused',hostKey:'unused'}),
    bootstrap:async()=>({log:''}),
    probe:async server=>({serverId:server.id,checkedAt:new Date().toISOString(),services:[]}),
    submit:async()=>{submissions++;throw new Error('An interrupted deployment must never be resubmitted');},
    status:async()=>({state:'succeeded',stage:'complete',log:'reconciled independently'}),
  };
  let current:Awaited<ReturnType<typeof createApp>>|undefined;
  try {
    current=await createApp({...options,remote});
    const passwords=['pg-first-admin-password','pg-second-admin-password'];
    const setups=await Promise.all(passwords.map(password=>current!.app.inject({method:'POST',url:'/api/setup',payload:{password,setupToken:options.setupToken}})));
    assert.deepEqual(setups.map(response=>response.statusCode).sort(),[200,409]);
    const session=setups.find(response=>response.statusCode===200)!;
    const cookie=String(session.headers['set-cookie']).split(';')[0];
    const csrf=session.json().csrfToken;
    const now=new Date().toISOString();
    const server=await current.store.saveServer({id:randomUUID(),name:'PostgreSQL fixture',host:'127.0.0.1',port:22,username:'ubuntu',group:'',notes:'',connectionMode:'agent',createdAt:now,updatedAt:now});
    const pairing=await current.agents.createPairing(server.id);
    const registrations=await Promise.allSettled([current.agents.register({...pairing,hostname:'pg-node',version:'test'}),current.agents.register({...pairing,hostname:'pg-node',version:'test'})]);
    const accepted=registrations.find(result=>result.status==='fulfilled');
    assert.ok(accepted?.status==='fulfilled');
    assert.equal(registrations.filter(result=>result.status==='fulfilled').length,1);
    const identity=accepted.value;
    const commandResult=current.agents.command(server.id,'probe',{},5_000).then(value=>({value,error:undefined}),error=>({value:undefined,error}));
    let command:AgentCommand|undefined;
    for(let attempt=0;attempt<100&&!command;attempt++){
      const response:LightMyRequestResponse=await current.app.inject({method:'POST',url:'/api/agent/poll',headers:{authorization:'Bearer '+identity.token},payload:{hostname:'pg-node',version:'test',deploymentProtection:{mode:'strict',policyVersion:3}}});
      assert.equal(response.statusCode,200,response.body);
      command=response.json().command??undefined;
      if(!command)await new Promise(resolve=>setTimeout(resolve,5));
    }
    assert.ok(command);
    const headers={authorization:'Bearer '+identity.token};
    const acknowledgement=await current.app.inject({method:'POST',url:`/api/agent/commands/${command.id}/ack`,headers,payload:{}});
    assert.equal(acknowledgement.statusCode,200,acknowledgement.body);
    const result=await current.app.inject({method:'POST',url:`/api/agent/commands/${command.id}/result`,headers,payload:{ok:true,value:'pg-round-trip'}});
    assert.equal(result.statusCode,200,result.body);
    assert.deepEqual((await commandResult).value,'pg-round-trip');
    const service:Service=await current.store.saveService({id:randomUUID(),name:'PG recovery',kind:'image',serverId:server.id,image:'nginx:alpine',target:{},autoDeploy:false,createdAt:now,updatedAt:now});
    const job:Job=await current.store.enqueue({id:randomUUID(),serverId:server.id,serviceId:service.id,type:'deploy',source:'manual',state:'queued',stage:'queued',log:'',createdAt:now,updatedAt:now});
    await current.store.updateJob(job.id,{state:'unknown',stage:'interrupted'});
    await current.app.close();current=undefined;
    current=await createApp({...options,remote});
    const workspace=await current.app.inject({method:'GET',url:'/api/workspace',headers:{cookie}});
    assert.equal(workspace.statusCode,200,workspace.body);
    const snapshot=workspace.json();
    assert.deepEqual(snapshot.platform,{storage:'postgresql',publisherConfigured:false,deploymentConfigurationAuthority:'controller'});
    assert.deepEqual(snapshot.servers[0].agent.deploymentProtection,{mode:'strict',policyVersion:3});
    assert.equal(snapshot.jobs[0].state,'unknown');
    const reconciled=await current.app.inject({method:'GET',url:`/api/jobs/${job.id}`,headers:{cookie}});
    assert.equal(reconciled.statusCode,200,reconciled.body);
    assert.equal(reconciled.json().state,'succeeded');
    assert.equal(reconciled.json().createdAt,job.createdAt);
    assert.equal(submissions,0);
    const logout=await current.app.inject({method:'POST',url:'/api/logout',headers:{cookie,'x-csrf-token':csrf},payload:{}});
    assert.equal(logout.statusCode,200,logout.body);
    assert.equal((await current.app.inject({method:'GET',url:'/api/workspace',headers:{cookie}})).statusCode,401);
  }finally{
    await current?.app.close();
    await administrator.query(`DROP DATABASE "${name}"`);await administrator.end();
    rmSync(directory,{recursive:true,force:true});
  }
});
