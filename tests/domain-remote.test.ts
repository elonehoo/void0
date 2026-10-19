import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,readFile,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DOMAIN_SCRIPT} from '../server/remote-scripts.js';
import type {DomainOperation} from '../shared/types.js';

async function python(script:string,input:unknown,environment:Record<string,string>={}) {
  return new Promise<{code:number;value:any;stderr:string}>((resolve,reject)=>{
    const child=spawn('python3',['-c',script],{env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',...environment},stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
    child.stdout.on('data',part=>stdout+=part);child.stderr.on('data',part=>stderr+=part);child.on('error',reject);child.on('close',code=>{try{resolve({code:code??-1,value:JSON.parse(stdout),stderr});}catch{reject(new Error('Invalid Python receipt: '+stderr));}});child.stdin.end(JSON.stringify(input));
  });
}
async function fixture() {
  // macOS's default TMPDIR exceeds the Unix socket path length limit.
  const dir=await realpath(await mkdtemp('/tmp/void0-domain-remote-')),bin=join(dir,'bin'),root=join(dir,'state'),log=join(dir,'docker-calls.jsonl'),proxy=join(dir,'proxy.json'),failure=join(dir,'fail-reload'),active=join(dir,'active.json');await mkdir(bin);await mkdir(join(root,'domains','admin'),{recursive:true,mode:0o700});
  const admin=createServer(async(_request,response)=>{try{response.setHeader('Content-Type','application/json');response.end(await readFile(active,'utf8'));}catch{response.writeHead(503);response.end('{}');}});await new Promise<void>(resolve=>admin.listen(join(root,'domains','admin','admin.sock'),resolve));
  const http=createServer((_req,res)=>{res.writeHead(200);res.end('selected HTTP service');});await new Promise<void>(resolve=>http.listen(0,'127.0.0.1',resolve));const address=http.address();assert.ok(address&&typeof address==='object');const port=address.port;
  const script=`#!/usr/bin/env python3
import json,sys,os,re
from pathlib import Path
args=sys.argv[1:]
root=${JSON.stringify(join(root,'domains'))}
proxy=Path(${JSON.stringify(proxy)})
with open(${JSON.stringify(log)},'a') as out:out.write(json.dumps(args)+'\\n')
if args[:1]==['ps']:print('fixture-app')
elif args[:1]==['inspect']:
 if args[1]=='void0-domains':
  if not proxy.exists():sys.exit(1)
  print(proxy.read_text())
 else:print(json.dumps([{'Name':'/fixture-app','State':{'Running':True},'Config':{'Labels':{'com.docker.compose.project':'sd-service','com.docker.compose.service':'app'}},'NetworkSettings':{'Ports':{'80/tcp':[{'HostIp':'0.0.0.0','HostPort':'${port}'}]}}}]))
elif args[:1]==['run']:
 if '--rm' not in args:proxy.write_text(json.dumps([{'State':{'Running':True},'Config':{'Labels':{'io.void0.domains':'1','io.void0.domains.root':root}},'HostConfig':{'NetworkMode':'host'}}]))
 print('proxy-container')
elif args[:1]==['exec']:
 failure=Path(${JSON.stringify(failure)})
 if failure.exists():failure.unlink();sys.exit(1)
 text=Path(root,'Caddyfile').read_text()
 routes=[]
 for name,port,owner in re.findall(r'([a-z0-9.-]+) \\{\\n reverse_proxy 127\\.0\\.0\\.1:([0-9]+)\\n header X-Void0-Service ([A-Za-z0-9_-]+)\\n\\}',text):
  header={'handler':'headers','response':{'set':{'X-Void0-Service':[owner]}}}
  upstream={'handler':'reverse_proxy','upstreams':[{'dial':'127.0.0.1:'+port}]}
  routes.append({'match':[{'host':[name]}],'handle':[{'handler':'subroute','routes':[{'handle':[header,upstream]}]}]})
 Path(${JSON.stringify(active)}).write_text(json.dumps({'apps':{'http':{'servers':{'srv0':{'routes':routes}}}}}))
 print('reload successful')
elif args[:1]==['rm']:
 if proxy.exists():proxy.unlink()
elif args[:1]==['start']:print('started')
else:sys.exit(1)
`;
  await writeFile(join(bin,'docker'),script,{mode:0o700});await writeFile(join(bin,'sudo'),'#!/bin/sh\n[ "$1" != "-n" ] || shift\nexec "$@"\n',{mode:0o700});
  const operation:DomainOperation={action:'add',service:{id:'service',kind:'image',target:{},containerPort:80,hostPort:port},name:'web.example.com'};
  const env={SERVERDESK_TEST_ROOT:root,SERVERDESK_TEST_PATH:bin+':'+(process.env.PATH??'')};
  // The remote program's port conflict logic is exercised separately with an occupied
  // unprivileged port; tests never bind the developer's host 80 or 443.
  const safeScript=DOMAIN_SCRIPT.replace('for port in (80,443):','for port in ():');
  return {dir,root,log,failure,operation,port,env,safeScript,run:(request=operation)=>python(safeScript,request,env),async close(){http.closeAllConnections();admin.closeAllConnections();await Promise.all([new Promise<void>(resolve=>http.close(()=>resolve())),new Promise<void>(resolve=>admin.close(()=>resolve()))]);await rm(dir,{recursive:true,force:true});}};
}
test('fixed remote domain program writes a real Caddy route and restores it when reload fails',async()=>{
  const f=await fixture();try {
    const add=await f.run();assert.equal(add.code,0,add.stderr+JSON.stringify(add.value));assert.deepEqual(add.value,{domains:[{name:'web.example.com',hostPort:f.port}],proxyReady:true,upstreamReady:true});
    const config=join(f.root,'domains','Caddyfile'),before=await readFile(config,'utf8');assert.match(before,new RegExp('reverse_proxy 127\\.0\\.0\\.1:'+f.port));assert.match(before,/admin unix\/\/run\/void0-admin\/admin.sock/);assert.ok(!before.includes('docker.sock'));
    await writeFile(f.failure,'1');const failed=await f.run({...f.operation,name:'broken.example.com'});assert.equal(failed.code,1);assert.equal(failed.value.outcomeKnown,true);assert.equal(await readFile(config,'utf8'),before);
    const list=await f.run({action:'list',service:f.operation.service});assert.deepEqual(list.value.domains,[{name:'web.example.com',hostPort:f.port}]);
    await writeFile(join(f.root,'domains','domains.json'),'{}');await writeFile(config,'stale interrupted configuration');const recovered=await f.run({action:'list',service:f.operation.service});assert.deepEqual(recovered.value.domains,[{name:'web.example.com',hostPort:f.port}]);assert.equal(await readFile(config,'utf8'),before,'active Caddy state repairs interrupted registry and disk configuration');
    const remove=await f.run({...f.operation,action:'remove'});assert.equal(remove.code,0,JSON.stringify(remove.value));assert.deepEqual(remove.value.domains,[]);assert.ok(!(await readFile(config,'utf8')).includes('web.example.com'));
    const calls=(await readFile(f.log,'utf8')).trim().split('\n').map(line=>JSON.parse(line) as string[]);assert.ok(calls.some(args=>args.includes('validate')));assert.ok(calls.some(args=>args.includes('reload')));assert.ok(calls.some(args=>args.includes('host')));
  }finally{await f.close();}
});
test('remote routing rejects occupied ingress ports, unverified service ports and arbitrary upstreams',async()=>{
  const f=await fixture();try {
    const conflict=await python(DOMAIN_SCRIPT.replace('for port in (80,443):',`for port in (${f.port},):`),f.operation,f.env);assert.equal(conflict.code,1);assert.match(conflict.value.error,/already in use/);
    const wrong=await f.run({...f.operation,service:{...f.operation.service,hostPort:f.port+1}});assert.equal(wrong.code,1);assert.match(wrong.value.error,/Publish one HTTP host port/);
    const injection=await f.run({...f.operation,upstream:'http://169.254.169.254/'} as DomainOperation);assert.equal(injection.code,1);assert.match(injection.value.error,/Invalid domain operation/);
    const invalid=await f.run({...f.operation,name:'example.com\nadmin off'});assert.equal(invalid.code,1);assert.match(invalid.value.error,/Invalid public domain/);
    const calls=(await readFile(f.log,'utf8')).trim().split('\n').map(line=>JSON.parse(line) as string[]);assert.equal(calls.some(args=>args[0]==='run'),false);
  }finally{await f.close();}
});
test('Python OS executes only installed domain programs and strict mode rejects this mutation',async()=>{
  const f=await fixture();try {
    const programs=join(f.dir,'programs.json');await writeFile(programs,JSON.stringify({domain:{language:'python',script:f.safeScript,timeoutSeconds:10}}),{mode:0o600});
    const code=`import importlib.util,sys,threading,json
s=importlib.util.spec_from_file_location('agent',${JSON.stringify(resolve('agent/daemon.py'))});m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
p=m.Programs(${JSON.stringify(programs)})
result=p.execute('domain',json.load(sys.stdin),threading.Event())
policy=m.ReleasePolicy.__new__(m.ReleasePolicy);policy.policy={'mode':'strict'}
try:policy.authorize('domain',{});raise AssertionError('strict mode accepted a domain change')
except m.AgentError:pass
print(json.dumps(result))`;
    // Programs intentionally discards ambient environment. An installed fixture
    // checks the operation boundary without importing arbitrary request scripts.
    await writeFile(programs,JSON.stringify({domain:{language:'python',script:"import json,sys\np=json.load(sys.stdin)\nprint(json.dumps({'domains':[], 'proxyReady':False, 'upstreamReady':False}))",timeoutSeconds:10}}),{mode:0o600});
    const result=await python(code,{...f.operation,script:'raise Exception("never executed")'});assert.equal(result.code,0,result.stderr);assert.equal(result.value.ok,true);assert.deepEqual(result.value.value,{domains:[],proxyReady:false,upstreamReady:false});
  }finally{await f.close();}
});
