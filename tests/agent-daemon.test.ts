import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import {mkdtemp, mkdir, writeFile, readFile, rm, stat} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn, type ChildProcess} from 'node:child_process';
import {createHash} from 'node:crypto';

const daemon=resolve('agent/daemon.py');
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check:()=>boolean|Promise<boolean>,message='timed out') {
  const deadline=Date.now()+10_000;
  while(Date.now()<deadline){if(await check())return;await pause(30);}
  assert.fail(message);
}
async function python(code:string,args:string[]=[]) {
  return await new Promise<{code:number;stdout:string;stderr:string}>((resolve,reject)=>{
    const child=spawn('python3',['-c',code,...args],{env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
    child.stdout.on('data',part=>stdout+=part);child.stderr.on('data',part=>stderr+=part);child.on('error',reject);child.on('close',code=>resolve({code:code??-1,stdout,stderr}));
  });
}
type Command={id:string;operation:string;payload:Record<string,unknown>};
async function fixture(programs:Record<string,unknown>) {
  const directory=await mkdtemp(join(tmpdir(),'serverdesk-agent-test-'));
  const config=join(directory,'config.json'),programsPath=join(directory,'programs.json'),state=join(directory,'state');
  await mkdir(state,{mode:0o700});await writeFile(programsPath,JSON.stringify(programs),{mode:0o600});
  const commands:Command[]=[],results=new Map<string,Record<string,unknown>>(),acks:string[]=[],polls:Array<Record<string,unknown>>=[],registrations:Array<Record<string,unknown>>=[];
  let rejectRegistration=false,unauthorized=0;
  const rejectResults=new Set<string>(),rejectAcks=new Set<string>();
  const server=createServer(async(request:IncomingMessage,response:ServerResponse)=>{
    try {
      let raw='';for await(const chunk of request)raw+=chunk;
      const body=JSON.parse(raw||'{}') as Record<string,unknown>;
      response.setHeader('Content-Type','application/json');
      if(request.url==='/api/agent/register'){
        registrations.push(body);if(rejectRegistration){response.writeHead(403);response.end('{}');return;}
        response.end(JSON.stringify({serverId:'server-fixture',token:'private-agent-token',pollIntervalSeconds:.1}));return;
      }
      if(request.headers.authorization!=='Bearer private-agent-token'){unauthorized++;response.writeHead(401);response.end('{}');return;}
      if(request.url==='/api/agent/poll'){
        polls.push(body);response.end(JSON.stringify({command:body.busy?null:(commands.shift()??null),pollIntervalSeconds:.1}));return;
      }
      const match=request.url?.match(/^\/api\/agent\/commands\/([^/]+)\/(ack|result)$/);
      if(match){if((match[2]==='result'&&rejectResults.has(match[1]!))||(match[2]==='ack'&&rejectAcks.has(match[1]!))){response.writeHead(409);response.end('{}');return;}if(match[2]==='ack')acks.push(match[1]!);else results.set(match[1]!,body);response.end('{}');return;}
      response.writeHead(404);response.end('{}');
    }catch{response.writeHead(500);response.end('{}');}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address==='object');
  const url=`http://127.0.0.1:${address.port}`;
  await writeFile(config,JSON.stringify({url,token:'private-agent-token',serverId:'server-fixture'}),{mode:0o600});
  let child:ChildProcess|undefined,stdout='',stderr='';
  return {directory,config,programsPath,state,url,commands,results,acks,polls,registrations,rejectResults,rejectAcks,
    get stdout(){return stdout;},get stderr(){return stderr;},get unauthorized(){return unauthorized;},
    rejectRegistration(){rejectRegistration=true;},
    start(){child=spawn('python3',[daemon,'run','--config',config,'--programs',programsPath,'--state-dir',state],{stdio:['ignore','pipe','pipe']});child.stdout!.on('data',part=>stdout+=part);child.stderr!.on('data',part=>stderr+=part);return child;},
    async stop(){if(child&&child.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>child!.once('close',resolve));}child=undefined;},
    async close(){await this.stop();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true,force:true});}
  };
}

test('agent registration writes private configuration and failed pairing preserves the existing token',async()=>{
  const f=await fixture({});try {
    const code=`import importlib.util,sys\ns=importlib.util.spec_from_file_location('agent',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nm.getpass.getpass=lambda prompt:'one-time-code-never-log'\nm.register(sys.argv[2],sys.argv[3])`;
    const result=await python(code,[daemon,f.config,f.url]);assert.equal(result.code,0,result.stderr);assert.ok(!result.stdout.includes('private-agent-token'));assert.ok(!result.stderr.includes('one-time-code-never-log'));
    assert.equal(f.registrations[0]?.pairingToken,'one-time-code-never-log');assert.equal((await stat(f.config)).mode&0o777,0o600);
    assert.deepEqual(JSON.parse(await readFile(f.config,'utf8')),{url:f.url,token:'private-agent-token',serverId:'server-fixture'});
    const before=await readFile(f.config,'utf8');f.rejectRegistration();const failed=await python(code,[daemon,f.config,f.url]);assert.equal(failed.code,1);assert.equal(await readFile(f.config,'utf8'),before);assert.ok(!failed.stderr.includes('one-time-code-never-log'));
  }finally{await f.close();}
});

test('agent polls during work, runs fixed programs once, and redacts secret results',async()=>{
  const f=await fixture({submit:{language:'python',script:"import json,sys,time\np=json.load(sys.stdin)\ntime.sleep(.5)\nprint(json.dumps({'state':'queued','log':p['environment']['PASSWORD']}))"},status:{language:'python',script:"import json\nprint(json.dumps({'state':'succeeded'}))"}});
  try {
    f.commands.push({id:'command-one',operation:'submit',payload:{environment:{PASSWORD:'agent-only-sensitive-value'},script:"raise Exception('must-not-run')"}},{id:'command-two',operation:'status',payload:{jobId:'job-fixture'}});
    f.start();await until(()=>f.results.size===2);assert.equal(f.unauthorized,0);assert.ok(f.polls.some(p=>p.busy===true));assert.equal(f.results.get('command-one')?.ok,true);assert.deepEqual(f.results.get('command-one')?.value,{state:'queued',log:'[redacted]'});assert.equal(f.results.get('command-two')?.ok,true);assert.ok(f.acks.indexOf('command-one')<f.acks.indexOf('command-two'));
    const before=f.acks.length;f.commands.push({id:'command-one',operation:'submit',payload:{environment:{PASSWORD:'agent-only-sensitive-value'}}});await until(()=>f.commands.length===0);await pause(150);assert.equal(f.acks.length,before,'duplicate command id must not execute or acknowledge again');
    const ledger=await readFile(join(f.state,createHash('sha256').update('command-one').digest('hex')+'.json'),'utf8');assert.ok(!ledger.includes('agent-only-sensitive-value'));assert.ok(!f.stdout.includes('agent-only-sensitive-value'));assert.ok(!f.stderr.includes('private-agent-token'));assert.ok(!ledger.includes('environment'));
  }finally{await f.close();}
});

test('agent restart reports an unfinished receipt as unknown and never re-executes it',async()=>{
  const f=await fixture({submit:{language:'python',script:"raise Exception('must never execute')"}});try {
    const commandId='interrupted-command',receipt=join(f.state,createHash('sha256').update(commandId).digest('hex')+'.json');
    await writeFile(receipt,JSON.stringify({id:commandId,state:'running'}),{mode:0o600});f.commands.push({id:commandId,operation:'submit',payload:{}});f.start();await until(()=>f.results.has(commandId));assert.equal(f.results.get(commandId)?.outcomeKnown,false);assert.equal(f.results.get(commandId)?.ok,false);await until(()=>f.commands.length===0);assert.match(await readFile(receipt,'utf8'),/reported/);
    await f.stop();f.start();await pause(250);assert.equal(f.results.size,1);assert.match(await readFile(receipt,'utf8'),/reported/,'reported receipt must not become unknown again');
  }finally{await f.close();}
});

test('agent rejects unsupported operations and reports bootstrap logs from the installed runtime only',async()=>{
  const f=await fixture({bootstrap:{docker:{language:'shell',script:"printf 'Docker dependencies ready\\n'"},k3s:{language:'shell',script:"printf 'K3s dependencies ready\\n'"}}});try {
    f.commands.push({id:'forbidden',operation:'shell',payload:{script:'touch /must-never-run'}},{id:'bootstrap',operation:'bootstrap',payload:{runtime:'k3s',script:'touch /must-never-run'}});f.start();await until(()=>f.results.size===2);
    assert.equal(f.results.get('forbidden')?.ok,false);assert.equal(f.results.get('forbidden')?.outcomeKnown,true);assert.deepEqual(f.results.get('bootstrap')?.value,{log:'K3s dependencies ready\n'});
  }finally{await f.close();}
});

test('agent refuses non-HTTPS management origins, unsafe configuration and output floods',async()=>{
  const result=await python(`import importlib.util,sys\ns=importlib.util.spec_from_file_location('agent',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nfor value in ['http://example.com','https://user:pass@example.com','https://example.com/other','https://example.com?token=value']:\n try:m.central_url(value);raise AssertionError('accepted unsafe origin')\n except m.AgentError:pass\nassert m.central_url('https://example.com/')=='https://example.com'\nprint('ok')`,[daemon]);assert.equal(result.code,0,result.stderr);
  const f=await fixture({probe:{language:'python',outputLimit:1024,script:"print('x'*2048)"}});try {
    f.commands.push({id:'large-output',operation:'probe',payload:{}});f.start();await until(()=>f.results.has('large-output'));assert.equal(f.results.get('large-output')?.ok,false);assert.match(String(f.results.get('large-output')?.error),/size limit/);
    await f.stop();await writeFile(f.config,'{}',{mode:0o600});await python('import os,sys\nos.chmod(sys.argv[1],0o644)',[f.config]);const child=f.start();await new Promise(resolve=>child.once('close',resolve));assert.equal(child.exitCode,1);assert.match(f.stderr,/0600/);
  }finally{await f.close();}
});

test('expired command acknowledgements and late results cannot block later probes',async()=>{
  const f=await fixture({probe:{language:'python',script:"import json\nprint(json.dumps({'services':[]}))"}});try {
    const receipt=(id:string)=>join(f.state,createHash('sha256').update(id).digest('hex')+'.json');
    await writeFile(receipt('late-result'),JSON.stringify({id:'late-result',state:'completed',result:{ok:true,value:{}}}),{mode:0o600});f.rejectResults.add('late-result');f.rejectAcks.add('expired-command');
    f.commands.push({id:'expired-command',operation:'probe',payload:{}},{id:'fresh-probe',operation:'probe',payload:{}});f.start();await until(()=>f.results.has('fresh-probe'));
    assert.match(await readFile(receipt('late-result'),'utf8'),/rejected/);assert.match(await readFile(receipt('expired-command'),'utf8'),/rejected/);assert.equal(f.results.get('fresh-probe')?.ok,true);assert.ok(f.polls.length>=2);
  }finally{await f.close();}
});
