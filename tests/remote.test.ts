import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,readFile,rm,mkdir,symlink,stat,realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash,randomBytes } from 'node:crypto';
import { SSHRemote,hostKeyFingerprint } from '../server/remote.js';
import { BOOTSTRAP_SCRIPT,PROBE_SCRIPT,STATUS_SCRIPT,SUBMIT_SCRIPT } from '../server/remote-scripts.js';
import type { DeployPlan,Server,SSHCredential } from '../shared/types.js';

const OLD='sha256:'+'a'.repeat(64),NEW='sha256:'+'b'.repeat(64);
const server:Server={id:'server-1',name:'test',host:'127.0.0.1',port:22,username:'ubuntu',group:'',notes:'',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
const plan=():DeployPlan=>({server,service:{id:'service-1',name:'API',kind:'compose',serverId:server.id,target:{composeProject:'test-project',composeService:'api'},image:'example/api:stable',autoDeploy:false,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()},job:{id:'job-1',serverId:server.id,serviceId:'service-1',type:'deploy',source:'manual',state:'queued',stage:'queued',log:'',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}});

async function python(script:string,input:unknown,env:NodeJS.ProcessEnv={}) {
  return await new Promise<{code:number;stdout:string;stderr:string}>((resolve,reject)=>{
    const p=spawn('python3',['-c',script],{env:{...process.env,...env},stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
    p.stdout.on('data',x=>stdout+=x);p.stderr.on('data',x=>stderr+=x);p.on('error',reject);p.on('close',code=>resolve({code:code??-1,stdout,stderr}));p.stdin.end(JSON.stringify(input));
  });
}
async function fixture(options:Record<string,unknown>={}) {
  const temp=await realpath(await mkdtemp(join(tmpdir(),'serverdesk-remote-test-')));const bin=join(temp,'bin'),root=join(temp,'data'),original=join(temp,'compose.json'),statePath=join(temp,'docker-state.json'),calls=join(temp,'calls.jsonl');
  await mkdir(bin);await writeFile(original,JSON.stringify({services:{api:{image:'old',environment:{UNCHANGED:'yes'},volumes:['data:/data']},redis:{image:'redis'}},volumes:{data:{}}}));
  const explicitEnv=join(temp,'production.env'),defaultEnv=join(temp,'.env');if(options.explicitEnv)await writeFile(explicitEnv,'VALUE=original-explicit\n',{mode:0o600});if(options.defaultEnv)await writeFile(defaultEnv,'VALUE=original-default\n',{mode:0o600});
  await writeFile(statePath,JSON.stringify({image:OLD,next:NEW,exists:true,failNew:false,failRollback:false,drift:false,...options}));
  const docker=String.raw`#!/usr/bin/env python3
import sys,json,os,time
from pathlib import Path
a=sys.argv[1:];statefile=PATH_STATE;state=json.loads(Path(statefile).read_text())
with open(PATH_CALLS,'a') as f:f.write(json.dumps(a)+'\n')
def save():Path(statefile).write_text(json.dumps(state))
if a[0]=='ps':
 if state.get('exists'):print('c'*64)
elif a[0]=='inspect':print(json.dumps({'imageID':state['image'],'image':'example/api:stable','files':PATH_ORIGINAL,'directory':PATH_DIRECTORY,'envFiles':PATH_ENV if state.get('explicitEnv') else None}))
elif a[:2]==['image','inspect']:print(state['next'])
elif a[0] in ('pull','build'):
 time.sleep(state.get('delay',0))
 if state.get('drift'):Path(PATH_ORIGINAL).write_text('changed while building')
 if state.get('changedDuringBuild'):state['image']='sha256:'+'d'*64;save()
 if state.get('envDrift')=='explicit':Path(PATH_ENV).write_text('VALUE=changed-explicit')
 if state.get('envDrift') in ('default','create'):Path(PATH_DEFAULT_ENV).write_text('VALUE=changed-default')
 print(state.get('output','image ready'))
elif a[0]=='compose':
 if 'up' not in a:sys.exit(4)
 files=[a[i+1] for i,x in enumerate(a) if x=='-f'];override=json.loads(Path(files[-1]).read_text());image=list(override['services'].values())[0]['image'];state['image']=image;state['exists']=True;save()
 if (image==state['next'] and state.get('failNew')) or (image!=state['next'] and state.get('failRollback')):print('health check failed');sys.exit(1)
 print('container is healthy')
else:sys.exit(4)
`.replace('PATH_STATE',JSON.stringify(statePath)).replace('PATH_CALLS',JSON.stringify(calls)).replaceAll('PATH_ORIGINAL',JSON.stringify(original)).replace('PATH_DIRECTORY',JSON.stringify(temp)).replaceAll('PATH_ENV',JSON.stringify(explicitEnv)).replaceAll('PATH_DEFAULT_ENV',JSON.stringify(defaultEnv));
  await writeFile(join(bin,'docker'),docker,{mode:0o700});
  const env={SERVERDESK_TEST_ROOT:root,SERVERDESK_TEST_PATH:bin+':'+process.env.PATH,SERVERDESK_TEST_SYNC:'1'};
  return {temp,root,bin,original,statePath,calls,explicitEnv,defaultEnv,env,async submit(p=plan(),extra?:unknown){const result=await python(SUBMIT_SCRIPT,{plan:p,...(extra as object??{})},env);assert.equal(result.stderr,'');return {code:result.code,status:JSON.parse(result.stdout) as {state:string;stage:string;log:string;message?:string}};},async commands(){return (await readFile(calls,'utf8')).trim().split('\n').map(x=>JSON.parse(x) as string[]);},async close(){await rm(temp,{recursive:true,force:true});}};
}

test('remote programs compile and probe never reads container environment',async()=>{
  const result=await python("import json,sys\nfor value in json.load(sys.stdin):compile(value,'remote','exec')\nprint('ok')",[PROBE_SCRIPT,SUBMIT_SCRIPT,STATUS_SCRIPT]);assert.equal(result.code,0,result.stderr);
  assert.equal(result.stdout.trim(),'ok');assert.ok(!PROBE_SCRIPT.includes('.Config.Env'));assert.ok(!SUBMIT_SCRIPT.includes('.Config.Env'));assert.ok(!SUBMIT_SCRIPT.includes('remove-orphans'));assert.ok(!SUBMIT_SCRIPT.includes("['down'"));
  assert.ok(BOOTSTRAP_SCRIPT.includes('download.docker.com'));assert.ok(!BOOTSTRAP_SCRIPT.includes('get.docker.com'));
});

test('updates only selected Compose service using immutable image and leaves original config intact',async()=>{
 const f=await fixture();try{const before=await readFile(f.original,'utf8');const {status}=await f.submit();assert.equal(status.state,'succeeded',status.message);assert.equal(await readFile(f.original,'utf8'),before);const commands=await f.commands();const up=commands.find(a=>a[0]==='compose'&&a.includes('up'))!;assert.equal(up.at(-1),'api');assert.ok(up.includes('--no-deps'));assert.ok(up.includes('--no-build'));assert.ok(up.includes('--wait'));assert.ok(up.includes('never'));const override=JSON.parse(await readFile(up[up.lastIndexOf('-f')+1]!,'utf8'));assert.equal(override.services.api.image,NEW);assert.deepEqual(Object.keys(override.services),['api']);assert.equal((await stat(join(f.root,'jobs','job-1','status.json'))).mode&0o777,0o600);}finally{await f.close();}
});

test('same image completes without recreating containers and repeat submit is idempotent',async()=>{
 const f=await fixture({next:OLD});try{assert.equal((await f.submit()).status.state,'succeeded');const count=(await f.commands()).length;assert.equal((await f.submit()).status.state,'succeeded');assert.equal((await f.commands()).length,count);assert.ok(!(await f.commands()).some(a=>a.includes('up')));}finally{await f.close();}
});

test('failed readiness restores previous image while reporting rollback limits',async()=>{
 const f=await fixture({failNew:true});try{const {status}=await f.submit();assert.equal(status.state,'rolled_back');assert.ok(status.message?.includes('Database and volume changes cannot be rolled back'));assert.equal(JSON.parse(await readFile(f.statePath,'utf8')).image,OLD);assert.equal((await f.commands()).filter(a=>a.includes('up')).length,2);}finally{await f.close();}
});

test('rollback failure is distinct from a restored service',async()=>{
 const f=await fixture({failNew:true,failRollback:true});try{assert.equal((await f.submit()).status.state,'rollback_failed');}finally{await f.close();}
});

test('Compose drift during pull prevents deployment',async()=>{
 const f=await fixture({drift:true});try{const {status}=await f.submit();assert.equal(status.state,'failed');assert.ok(status.message?.includes('configuration changed'));assert.ok(!(await f.commands()).some(a=>a.includes('up')));}finally{await f.close();}
});

test('symlinked original Compose file is rejected',async()=>{
 const f=await fixture();try{const real=join(f.temp,'real.json');await writeFile(real,'{}');await rm(f.original);await symlink(real,f.original);const {status}=await f.submit();assert.equal(status.state,'failed');assert.ok(status.message?.includes('symlinks'));assert.ok(!(await f.commands()).some(a=>a.includes('up')));}finally{await f.close();}
});

test('service environment values are removed from persisted logs',async()=>{
 const secret=randomBytes(24).toString('hex');const f=await fixture({output:`build says ${secret} and token=another-secret`});try{const p=plan();p.service.environment={PASSWORD:secret};const {status}=await f.submit(p);assert.equal(status.state,'succeeded');assert.ok(!status.log.includes(secret));assert.ok(!status.log.includes('another-secret'));assert.ok(status.log.includes('[redacted]'));}finally{await f.close();}
});

test('Kubernetes deployment and secret-bearing remote requests are rejected',async()=>{
 const f=await fixture();try{const p=plan();p.service.kind='kubernetes';assert.equal((await f.submit(p)).status.state,'failed');const p2=plan();p2.job.id='job-2';p2.repository={owner:'test',repo:'test',commit:'a'.repeat(40),token:'not-to-persist'};const result=await f.submit(p2);assert.equal(result.code,1);assert.ok(result.status.message?.includes('credentials'));}finally{await f.close();}
});

test('status after a lost worker is unknown and never reruns Docker',async()=>{
 const f=await fixture();try{await f.submit();const path=join(f.root,'jobs','job-1','status.json');await writeFile(path,JSON.stringify({state:'running',stage:'building',pid:99999999,bootId:'old-host-boot'}),{mode:0o600});const count=(await f.commands()).length;const result=await python(STATUS_SCRIPT,{jobId:'job-1'},f.env);assert.equal(JSON.parse(result.stdout).state,'unknown');assert.equal((await f.commands()).length,count);}finally{await f.close();}
});

test('host key pin is required before SSH is launched',async()=>{
 const remote=new SSHRemote({sshPath:'/this-command-must-not-run'});await assert.rejects(remote.probe(server,{password:'secret'}),/pin/);const hostKey='ssh-ed25519 '+Buffer.alloc(51,42).toString('base64');assert.ok(hostKeyFingerprint(hostKey).startsWith('SHA256:'));await assert.rejects(remote.probe({...server,fingerprint:'SHA256:other'},{hostKey}),/does not match/);
});

test('GitHub archive token is not forwarded to codeload or SSH argv',async()=>{
 const temp=await mkdtemp(join(tmpdir(),'serverdesk-ssh-test-'));try{
  const capture=join(temp,'capture.json'),ssh=join(temp,'ssh');
  await writeFile(ssh,`#!/usr/bin/env python3\nimport sys,json\nfrom pathlib import Path\ndata=json.load(sys.stdin)\nPath(${JSON.stringify(capture)}).write_text(json.dumps({'args':sys.argv[1:],'request':data}))\nprint(json.dumps({'state':'queued','stage':'queued','log':''}))\n`,{mode:0o700});
  const token='gh-secret-never-on-disk',requests:Array<{url:string;headers:Headers}>=[];
  const fetcher=async(input:string|URL|Request,init?:RequestInit)=>{requests.push({url:String(input),headers:new Headers(init?.headers)});return requests.length===1?new Response(null,{status:302,headers:{location:'https://codeload.github.com/test/repo/legacy.tar.gz/'+ 'a'.repeat(40)}}):new Response(Buffer.from('archive'));};
  const remote=new SSHRemote({dataDir:temp,sshPath:ssh,fetch:fetcher as typeof fetch});const p=plan();const hostKey='ssh-ed25519 '+Buffer.alloc(51,42).toString('base64');p.server={...server,fingerprint:hostKeyFingerprint(hostKey)};p.repository={owner:'test',repo:'repo',commit:'a'.repeat(40),token};
  const credential:SSHCredential={hostKey,password:'ssh-secret'};assert.equal((await remote.submit(p,credential)).state,'queued');assert.equal(requests[0]?.headers.get('Authorization'),'Bearer '+token);assert.equal(requests[1]?.headers.get('Authorization'),null);
  const raw=await readFile(capture,'utf8');assert.ok(!raw.includes(token));assert.ok(!raw.includes('ssh-secret'));const captured=JSON.parse(raw);assert.ok(captured.request.archive);assert.equal(captured.request.plan.repository.token,undefined);assert.ok(!captured.args.join(' ').includes('ssh-secret'));
 }finally{await rm(temp,{recursive:true,force:true});}
});

async function archive(unsafe=false):Promise<string> {
 const result=await python(`import sys,json,tarfile,io,base64\nunsafe=json.load(sys.stdin)['unsafe']\nbuf=io.BytesIO()\nwith tarfile.open(fileobj=buf,mode='w:gz') as tar:\n data=b'FROM scratch\\n'\n info=tarfile.TarInfo('repo/../../escaped' if unsafe else 'repo/Dockerfile');info.size=len(data);tar.addfile(info,io.BytesIO(data))\nprint(base64.b64encode(buf.getvalue()).decode())`,{unsafe});assert.equal(result.code,0,result.stderr);return result.stdout.trim();
}

test('pinned source archive builds on the target server without GitHub Actions',async()=>{
 const f=await fixture({exists:false});try{
  const p=plan();p.service.kind='source';p.service.target={composeProject:'sd-service1',composeService:'app'};p.service.repository='https://github.com/test/repo';p.service.containerPort=8080;p.service.hostPort=18080;p.service.environment={PASSWORD:'private-value'};p.service.volumes=[{name:'data',mountPath:'/data'}];p.repository={owner:'test',repo:'repo',commit:'a'.repeat(40)};
  const {status}=await f.submit(p,{archive:await archive()});assert.equal(status.state,'succeeded',status.message);const commands=await f.commands();const build=commands.find(a=>a[0]==='build')!;assert.ok(build.includes('org.opencontainers.image.revision='+'a'.repeat(40)));assert.ok(!commands.some(a=>a[0]==='pull'));const up=commands.find(a=>a[0]==='compose'&&a.includes('up'))!;assert.equal(up.at(-1),'app');assert.equal(up[up.indexOf('--project-name')+1],'sd-service1');const base=join(f.root,'services','service-1','compose.json');const spec=JSON.parse(await readFile(base,'utf8')).services.app;assert.deepEqual(spec.ports,['18080:8080']);assert.deepEqual(spec.volumes,['data:/data']);assert.equal((await stat(base)).mode&0o777,0o600);await assert.rejects(stat(join(f.root,'jobs','job-1','source')));await assert.rejects(stat(join(f.root,'jobs','job-1','source.tar.gz')));
 }finally{await f.close();}
});

test('unsafe source archive paths fail before Docker build or service update',async()=>{
 const f=await fixture();try{const p=plan();p.repository={owner:'test',repo:'repo',commit:'a'.repeat(40)};const {status}=await f.submit(p,{archive:await archive(true)});assert.equal(status.state,'failed');assert.ok(status.message?.includes('unsafe path'));assert.ok(!(await f.commands()).some(a=>a[0]==='build'||a.includes('up')));}finally{await f.close();}
});

test('concurrent submissions with one job ID execute the service update once',async()=>{
 const f=await fixture({delay:.2});try{const [one,two]=await Promise.all([f.submit(),f.submit()]);assert.equal(one.status.state,'succeeded');assert.equal(two.status.state,'succeeded');assert.equal((await f.commands()).filter(a=>a.includes('up')).length,1);}finally{await f.close();}
});

test('remote worker continues after its submitting SSH process has exited',async()=>{
 const f=await fixture({delay:.2});try{
  const response=await python(SUBMIT_SCRIPT,{plan:plan()},{...f.env,SERVERDESK_TEST_SYNC:'0'});assert.equal(response.code,0,response.stderr);assert.equal(JSON.parse(response.stdout).state,'queued');
  let status:{state:string;message?:string}|undefined;
  for(let attempt=0;attempt<40;attempt++){const result=await python(STATUS_SCRIPT,{jobId:'job-1'},f.env);status=JSON.parse(result.stdout);if(!['queued','running'].includes(status!.state))break;await new Promise(resolve=>setTimeout(resolve,50));}
  assert.equal(status?.state,'succeeded',status?.message);assert.equal((await f.commands()).filter(a=>a.includes('up')).length,1);
 }finally{await f.close();}
});

test('a Compose project lock blocks a second service job before Docker is touched',async()=>{
 const f=await fixture();let holder:ReturnType<typeof spawn>|undefined;
 try{
  const locks=join(f.root,'locks');await mkdir(locks,{recursive:true});
  holder=spawn('python3',['-c',"import fcntl,sys\nf=open(sys.argv[1],'w');fcntl.flock(f,fcntl.LOCK_EX);print('locked',flush=True);sys.stdin.read()",join(locks,'test-project.lock')],{stdio:['pipe','pipe','pipe']});
  await new Promise<void>((resolve,reject)=>{holder!.stdout!.once('data',()=>resolve());holder!.once('error',reject);});
  const {status}=await f.submit();assert.equal(status.state,'failed');assert.ok(status.message?.includes('Another deployment'));await assert.rejects(stat(f.calls));
 }finally{if(holder){holder.stdin!.end();await new Promise(resolve=>holder!.once('close',resolve));}await f.close();}
});

test('a container changed outside the app during a build prevents the update',async()=>{
 const f=await fixture({changedDuringBuild:true});try{const {status}=await f.submit();assert.equal(status.state,'failed');assert.ok(status.message?.includes('service changed during build'));assert.ok(!(await f.commands()).some(a=>a.includes('up')));}finally{await f.close();}
});

test('fresh server connection verification requires only an SSH shell, without Python or Docker',async()=>{
 const temp=await mkdtemp(join(tmpdir(),'serverdesk-connect-test-'));try{
  const capture=join(temp,'command.txt'),ssh=join(temp,'ssh');await writeFile(ssh,`#!/usr/bin/env python3\nimport sys\nfrom pathlib import Path\nPath(${JSON.stringify(capture)}).write_text(sys.argv[-1])\nprint('SERVERDESK_CONNECTED')\n`,{mode:0o700});
  const hostKey='ssh-ed25519 '+Buffer.alloc(51,42).toString('base64');const remote=new SSHRemote({dataDir:temp,sshPath:ssh});await remote.verifyConnection({...server,fingerprint:hostKeyFingerprint(hostKey)},{hostKey,password:'test-password'});const command=await readFile(capture,'utf8');assert.ok(command.startsWith('printf '));assert.ok(!command.includes('python'));assert.ok(!command.includes('docker'));assert.ok(!command.includes('test-password'));
 }finally{await rm(temp,{recursive:true,force:true});}
});

test('owned internal ports stay private and dollar signs in environment values stay literal',async()=>{
 const f=await fixture({exists:false});try{const p=plan();p.service.kind='source';p.service.containerPort=8080;p.service.environment={SECRET_LITERAL:'foo$BAR${BAZ}'};p.repository={owner:'test',repo:'repo',commit:'a'.repeat(40)};const {status}=await f.submit(p,{archive:await archive()});assert.equal(status.state,'succeeded',status.message);const spec=JSON.parse(await readFile(join(f.root,'services',p.service.id,'compose.json'),'utf8')).services.app;assert.deepEqual(spec.expose,['8080']);assert.equal(spec.ports,undefined);assert.equal(spec.environment.SECRET_LITERAL,'foo$$BAR$${BAZ}');}finally{await f.close();}
});

test('a host port without a container port is rejected',async()=>{
 const f=await fixture({exists:false});try{const p=plan();p.service.kind='image';p.service.hostPort=8080;const {status}=await f.submit(p);assert.equal(status.state,'failed');assert.ok(status.message?.includes('requires a container port'));assert.ok(!(await f.commands()).some(args=>args.includes('up')||args[0]==='pull'));}finally{await f.close();}
});

test('imported Compose restores explicit env files and original project directory without reading container environment',async()=>{
 const f=await fixture({explicitEnv:true,defaultEnv:true});try{const {status}=await f.submit();assert.equal(status.state,'succeeded',status.message);const up=(await f.commands()).find(args=>args.includes('up'))!;assert.equal(up[up.indexOf('--env-file')+1],f.explicitEnv);assert.equal(up[up.indexOf('--project-directory')+1],f.temp);assert.equal(await readFile(f.explicitEnv,'utf8'),'VALUE=original-explicit\n');assert.equal(await readFile(f.defaultEnv,'utf8'),'VALUE=original-default\n');assert.ok(!status.log.includes('VALUE=original'));}finally{await f.close();}
});

test('explicit, default, and newly created env file drift blocks updating an imported service',async()=>{
 for(const envDrift of ['explicit','default','create']){const f=await fixture({explicitEnv:envDrift==='explicit',defaultEnv:envDrift==='default',envDrift});try{const {status}=await f.submit();assert.equal(status.state,'failed');assert.ok(status.message?.includes('environment file changed'),status.message);assert.ok(!(await f.commands()).some(args=>args.includes('up')));}finally{await f.close();}}
});

test('a symlinked explicit Compose env file is rejected',async()=>{
 const f=await fixture({explicitEnv:true});try{const actual=join(f.temp,'secret.env');await writeFile(actual,'VALUE=private');await rm(f.explicitEnv);await symlink(actual,f.explicitEnv);const {status}=await f.submit();assert.equal(status.state,'failed');assert.ok(status.message?.includes('symlinks'));assert.ok(!status.log.includes('VALUE=private'));}finally{await f.close();}
});
