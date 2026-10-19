import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.js';
import {assertDomainTargetUnchanged,assertServiceDomainsRemoved,normalizeDomain,registerDomainRoutes} from '../server/domains.js';
import {ManagedRemote} from '../server/managed-remote.js';
import {AgentController} from '../server/agent-controller.js';
import {Vercel} from '../server/integrations.js';
import type {DomainOperation,RemoteTransport,Service} from '../shared/types.js';

async function fixture() {
  const dir=await mkdtemp(join(tmpdir(),'void0-domain-test-')),store=new Store(dir);await store.ready();
  const now=new Date().toISOString(),server=await store.saveServer({id:'server',name:'Fixture',host:'192.0.2.10',port:22,username:'ubuntu',group:'',notes:'',createdAt:now,updatedAt:now});
  const service:Service={id:'service',name:'Web',kind:'image',serverId:'server',target:{},image:'nginx:alpine',containerPort:80,hostPort:18080,autoDeploy:false,createdAt:now,updatedAt:now};
  await store.saveService(service);await store.saveProject({id:'project',name:'Fixture',description:'',serviceIds:[service.id],createdAt:now,updatedAt:now});
  const names=new Set<string>(),calls:DomainOperation[]=[];
  let unknown=false,dnsReady=false,tlsReady=false,block:Promise<void>|undefined;
  const unused=async()=>{throw new Error('Unused fixture operation');};
  const remote:RemoteTransport={probe:unused,fingerprint:unused,bootstrap:unused,submit:unused,status:unused,canControl:()=>true,async domain(_server,_credentials,request){calls.push(request);if(request.action==='add'){if(block)await block;if(unknown)throw new Error('connection lost');names.add(request.name!);}if(request.action==='remove')names.delete(request.name!);return {domains:[...names].map(name=>({name,hostPort:18080})),proxyReady:true,upstreamReady:true};}};
  const app=Fastify();app.setErrorHandler((error,_req,reply)=>reply.code(400).send({error:(error as Error).message}));
  registerDomainRoutes(app,{store,remote,dns:async name=>name===server.host||dnsReady?['192.0.2.10']:['192.0.2.20'],tls:async()=>tlsReady});
  return {app,store,service,server,names,calls,setUnknown(value:boolean){unknown=value;},setReady(dns:boolean,tls:boolean){dnsReady=dns;tlsReady=tls;},block(value:Promise<void>){block=value;},async close(){await app.close();await store.close();await rm(dir,{recursive:true,force:true});}};
}
test('domains normalize international hostnames and reject URLs, IPs, paths and injection',()=>{
  assert.equal(normalizeDomain('WWW.Example.COM'),'www.example.com');assert.equal(normalizeDomain('例子.中国'),'xn--fsqu00a.xn--fiqs8s');
  for(const value of ['https://example.com','user@example.com','example.com:443','*.example.com','127.0.0.1','foo.local','foo.test','example.com\nadmin off','example.com/path',' example.com','example..com','-x.example.com'])assert.throws(()=>normalizeDomain(value));
});
test('Docker binding performs actual remote changes and distinguishes DNS from HTTPS readiness',async()=>{
  const f=await fixture();try {
    const add=await f.app.inject({method:'POST',url:'/api/services/service/domains',payload:{name:'www.example.com'}});assert.equal(add.statusCode,200,add.body);
    assert.equal(add.json().domains[0].status,'pending_dns');assert.equal(f.names.has('www.example.com'),true);assert.equal(f.calls.filter(row=>row.action==='add').length,1);assert.deepEqual(add.json().domains[0].records,[{type:'A',name:'www.example.com',value:'192.0.2.10'}]);
    f.setReady(true,false);let check=await f.app.inject({method:'POST',url:'/api/services/service/domains/www.example.com/verify'});assert.equal(check.json().domains[0].status,'pending_https');
    f.setReady(true,true);check=await f.app.inject({method:'POST',url:'/api/services/service/domains/www.example.com/verify'});assert.equal(check.json().domains[0].status,'ready');
    await assert.rejects(assertDomainTargetUnchanged(f.store,f.service,{...f.service,hostPort:18081}),/先移除域名/);await assert.rejects(assertServiceDomainsRemoved(f.store,f.service.id),/先移除域名/);
    const remove=await f.app.inject({method:'DELETE',url:'/api/services/service/domains/www.example.com'});assert.equal(remove.statusCode,200,remove.body);assert.equal(f.names.size,0);await assertServiceDomainsRemoved(f.store,f.service.id);
  }finally{await f.close();}
});
test('domain routes require an existing project and forbid arbitrary upstreams or unknown fields',async()=>{
  const f=await fixture();try {
    const bad=await f.app.inject({method:'POST',url:'/api/services/service/domains',payload:{name:'www.example.com',upstream:'http://169.254.169.254/'}});assert.equal(bad.statusCode,400);assert.equal(f.calls.length,0);
    const project=(await f.store.getProject('project'))!;await f.store.saveProject({...project,serviceIds:[]});await f.store.removeProject('project');const orphan=await f.app.inject({method:'GET',url:'/api/services/service/domains'});assert.equal(orphan.statusCode,400);assert.match(orphan.json().error,/先将此服务归入项目/);
  }finally{await f.close();}
});
test('an interrupted mutation is retained and never automatically resubmitted',async()=>{
  const f=await fixture();try {
    f.setUnknown(true);const add=await f.app.inject({method:'POST',url:'/api/services/service/domains',payload:{name:'www.example.com'}});assert.equal(add.statusCode,400);assert.match(add.json().error,/不会自动重试/);
    assert.equal((await f.store.getSetting<{pending?:unknown}>('domains:service:service'))?.pending!==undefined,true);
    const retry=await f.app.inject({method:'POST',url:'/api/services/service/domains',payload:{name:'www.example.com'}});assert.equal(retry.statusCode,400);assert.equal(f.calls.filter(row=>row.action==='add').length,1);
    f.names.add('www.example.com');await f.app.inject({method:'GET',url:'/api/services/service/domains'});assert.equal((await f.store.getSetting<{pending?:unknown}>('domains:service:service'))?.pending,undefined);
  }finally{await f.close();}
});
test('concurrent GET waits for a mutation and cannot discard its pending state',async()=>{
  const f=await fixture();try {
    let release!:()=>void;f.block(new Promise<void>(resolve=>{release=resolve;}));
    const add=f.app.inject({method:'POST',url:'/api/services/service/domains',payload:{name:'www.example.com'}});
    for(let i=0;i<100&&!f.calls.some(row=>row.action==='add');i++)await new Promise(resolve=>setTimeout(resolve,5));
    const read=f.app.inject({method:'GET',url:'/api/services/service/domains'});await new Promise(resolve=>setTimeout(resolve,20));assert.ok((await f.store.getSetting<{pending?:unknown}>('domains:service:service'))?.pending);
    release();assert.equal((await add).statusCode,200);assert.equal((await read).json().domains.length,1);
  }finally{await f.close();}
});
test('Vercel existing/default domains do not block removing a management record; void0 additions do',async()=>{
  const f=await fixture();try {
    const service:Service={...f.service,id:'vercel',kind:'vercel',serverId:undefined,target:{vercelProjectId:'prj_fixture',vercelScopeId:'team_fixture'}};await f.store.saveService(service);await f.store.moveServices([service.id],'project');
    const names=new Set(['original.vercel.app']);const requests:Array<{url:string;init?:RequestInit}>=[];
    const client=new Vercel('fixture-only',async(input,init)=>{const url=String(input);requests.push({url,init});if(init?.method==='POST'&&url.includes('/domains?'))names.add(JSON.parse(String(init.body)).name);if(init?.method==='DELETE')names.delete(decodeURIComponent(new URL(url).pathname.split('/').at(-1)!));return Response.json(url.includes('/config?')?{misconfigured:true,recommendedCNAME:[{rank:1,value:'target.vercel-dns.example'}]}:init?.method==='POST'?{name:'custom.example.com',verified:false,verification:[{type:'TXT',domain:'_vercel.custom.example.com',value:'ownership-proof'}]}:{domains:[...names].map(name=>({name,verified:!name.startsWith('custom')}))});});
    await f.store.vault.set('vercel',{token:'fixture-only'});const app=Fastify();registerDomainRoutes(app,{store:f.store,remote:{} as RemoteTransport,vercel:()=>client,dns:async()=>[],tls:async()=>false});
    const list=await app.inject({method:'GET',url:'/api/services/vercel/domains'});assert.equal(list.statusCode,200,list.body);await assertServiceDomainsRemoved(f.store,service.id);
    const add=await app.inject({method:'POST',url:'/api/services/vercel/domains',payload:{name:'custom.example.com'}});assert.equal(add.statusCode,200,add.body);await assert.rejects(assertServiceDomainsRemoved(f.store,service.id),/先移除域名/);assert.ok(requests.some(row=>row.init?.method==='POST'&&row.url.includes('teamId=team_fixture')));
    const remove=await app.inject({method:'DELETE',url:'/api/services/vercel/domains/custom.example.com'});assert.equal(remove.statusCode,200,remove.body);await assertServiceDomainsRemoved(f.store,service.id);await app.close();
  }finally{await f.close();}
});
test('strict OS never sends domain commands or falls back to SSH',async()=>{
  const f=await fixture(),controller=new AgentController(f.store);try {
    await controller.ready();const pairing=await controller.createPairing(f.server.id);await controller.register({pairingToken:pairing.pairingToken,hostname:'fixture',version:'0.3.0'});await controller.poll(f.server.id,{hostname:'fixture',version:'0.3.0',deploymentProtection:{mode:'strict'}});
    const remote=new ManagedRemote(f.store,controller);await assert.rejects(remote.domain({...f.server,connectionMode:'agent'},undefined,{action:'list',service:{id:'service',kind:'image',target:{}}}),/独立发布保护/);assert.equal((await controller.info(f.server.id)).pending,0);
  }finally{await controller.close();await f.close();}
});
