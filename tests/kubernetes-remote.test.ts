import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile,rm,access,realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { SSHRemote,hostKeyFingerprint } from '../server/remote.js';
import { DEFAULT_K3S_VERSION,K3S_INSTALLER_SHA256,K3S_INSTALLER_URL,K3S_INSTALL_SCRIPT,K3S_FIREWALL_SCRIPT,KUBERNETES_ACTION_SCRIPT,PROBE_SCRIPT,k3sBootstrapScript } from '../server/remote-scripts.js';
import type { Server } from '../shared/types.js';

async function python(script:string,input:unknown={},env:NodeJS.ProcessEnv={}) {
 return await new Promise<{code:number;stdout:string;stderr:string}>((resolve,reject)=>{
  const child=spawn('python3',['-c',script],{env:{...process.env,...env},stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
  child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.on('error',reject);child.on('close',code=>resolve({code:code??-1,stdout,stderr}));child.stdin.end(JSON.stringify(input));
 });
}

async function actionFixture(initial:Record<string,unknown>={}) {
 const root=await mkdtemp(join(tmpdir(),'serverdesk-kubernetes-'));const bin=join(root,'bin'),state=join(root,'state.json'),calls=join(root,'calls.jsonl');await mkdir(bin);
 await writeFile(state,JSON.stringify({replicas:4,previous:undefined,fail:false,...initial}));
 await writeFile(join(bin,'sudo'),'#!/bin/sh\nshift\nexec "$@"\n',{mode:0o700});
 await writeFile(join(bin,'k3s'),String.raw`#!/usr/bin/env python3
import sys,json
from pathlib import Path
a=sys.argv[1:];p=Path(STATE);s=json.loads(p.read_text())
with open(CALLS,'a') as f:f.write(json.dumps(a)+'\n')
if s.get('fail'):sys.exit(1)
def save():p.write_text(json.dumps(s))
if 'get' in a:print(str(s['replicas'])+'\t'+str(s.get('previous') or ''))
elif 'annotate' in a:s['previous']=int(next(v.split('=',1)[1] for v in a if v.startswith('serverdesk.io/previous-replicas=')));save();print('annotated')
elif 'scale' in a:
 expected=int(next(v.split('=',1)[1] for v in a if v.startswith('--current-replicas=')))
 if expected!=s['replicas']:sys.exit(1)
 s['replicas']=int(next(v.split('=',1)[1] for v in a if v.startswith('--replicas=')));save();print('scaled')
elif 'rollout' in a:print('restarted')
elif 'logs' in a:print(s.get('log','hello from selected deployment'))
else:sys.exit(2)
`.replaceAll('STATE',JSON.stringify(state)).replaceAll('CALLS',JSON.stringify(calls)),{mode:0o700});
 return {root,state,calls,bin,async run(action:string,options:unknown={},target:unknown={namespace:'apps',deployment:'api'}){const result=await python(KUBERNETES_ACTION_SCRIPT,{action,target,options},{PATH:bin+':'+process.env.PATH});return {...result,value:JSON.parse(result.stdout)};},async commands(){return (await readFile(calls,'utf8')).trim().split('\n').map(row=>JSON.parse(row) as string[]);},async close(){await rm(root,{recursive:true,force:true});}};
}

test('remote Kubernetes programs compile and the preview uses the actual pinned installer script',async()=>{
 const result=await python("import json,sys\nfor value in json.load(sys.stdin):compile(value,'remote','exec')",[K3S_INSTALL_SCRIPT,KUBERNETES_ACTION_SCRIPT,PROBE_SCRIPT]);assert.equal(result.code,0,result.stderr);
 const script=k3sBootstrapScript();assert.ok(script.includes(DEFAULT_K3S_VERSION));assert.ok(script.includes(K3S_INSTALLER_URL));assert.ok(script.includes(K3S_INSTALLER_SHA256));assert.ok(!script.includes('curl |'));assert.ok(script.includes('--bind-address=0.0.0.0'));assert.ok(script.includes('--disable=traefik'));assert.ok(script.includes('--disable=servicelb'));assert.ok(script.includes('--flannel-backend=host-gw'));assert.ok(script.includes('env -i'));assert.ok(script.includes('iptables-restore'));assert.ok(script.includes('ExecStartPre='));assert.ok(script.includes('ExecStartPost='));
 assert.throws(()=>k3sBootstrapScript("v1.36.4+k3s1'; touch /tmp/escaped"),/fixed stable/);
 assert.ok(!KUBERNETES_ACTION_SCRIPT.includes("'get','secrets'"));assert.ok(!KUBERNETES_ACTION_SCRIPT.includes('.spec.template.spec.containers'));
});

test('stopping a Deployment saves its replicas remotely and repeated stop preserves them',async()=>{
 const f=await actionFixture();try{
  const one=await f.run('stop');assert.equal(one.code,0,one.stderr);assert.equal(one.value.replicas,4);assert.deepEqual(JSON.parse(await readFile(f.state,'utf8')),{replicas:0,previous:4,fail:false});
  const two=await f.run('stop');assert.equal(two.value.replicas,4);assert.equal((await f.commands()).filter(args=>args.includes('annotate')).length,1);assert.equal((await f.commands()).filter(args=>args.includes('scale')).length,1);
 }finally{await f.close();}
});

test('start restores persisted Deployment replicas after a new invocation and supports an explicit override',async()=>{
 const f=await actionFixture();try{
  await f.run('stop');const started=await f.run('start');assert.equal(started.value.replicas,4);assert.match(started.value.log,/4 replicas/);
  await f.run('stop');assert.equal((await f.run('start',{replicas:6})).value.replicas,6);assert.equal(JSON.parse(await readFile(f.state,'utf8')).replicas,6);
 }finally{await f.close();}
});

test('start without a saved positive replica count uses one and invalid replicas never change the Deployment',async()=>{
 const f=await actionFixture({replicas:0});try{
  assert.equal((await f.run('start')).value.replicas,1);
  for(const replicas of [0,-1,101,1.5,true,'4'])assert.equal((await f.run('start',{replicas})).code,1);
  assert.equal((await f.commands()).filter(args=>args.includes('scale')).length,1);
 }finally{await f.close();}
});

test('repeated start preserves an already running Deployment and does not reduce it to one replica',async()=>{
 const f=await actionFixture({replicas:4,previous:2});try{const result=await f.run('start');assert.equal(result.value.replicas,4);assert.ok(!(await f.commands()).some(args=>args.includes('scale')));assert.equal(JSON.parse(await readFile(f.state,'utf8')).replicas,4);}finally{await f.close();}
});

test('restart changes only the named Deployment and leaves its replica count alone',async()=>{
 const f=await actionFixture();try{
  const result=await f.run('restart');assert.equal(result.value.replicas,4);const commands=await f.commands();assert.equal(commands.length,3);assert.ok(commands[1]?.includes('deployment/api'));assert.ok(commands[1]?.includes('--namespace'));assert.ok(!commands[1]?.includes('scale'));assert.ok(commands[2]?.includes('status'));assert.ok(commands[2]?.includes('--timeout=120s'));assert.equal(JSON.parse(await readFile(f.state,'utf8')).replicas,4);
 }finally{await f.close();}
});

test('logs select a single Deployment with 100-line and byte limits, and redact credential patterns',async()=>{
 const f=await actionFixture({log:'password=hidden token=private Authorization: Bearer abcdefgh hello'});try{
  const result=await f.run('logs');assert.equal(result.code,0);assert.ok(!result.value.log.includes('hidden'));assert.ok(!result.value.log.includes('private'));assert.ok(!result.value.log.includes('abcdefgh'));const command=(await f.commands())[1]!;assert.ok(command.includes('deployment/api'));assert.ok(command.includes('--tail=100'));assert.ok(command.includes('--limit-bytes=32768'));assert.ok(command.includes('--all-containers=false'));assert.ok(!command.includes('--all-pods'));
 }finally{await f.close();}
});

test('shell-like targets and system namespaces are rejected before kubectl runs',async()=>{
 const f=await actionFixture();try{
  for(const target of [{namespace:'apps;touch /tmp/no',deployment:'api'},{namespace:'apps',deployment:'api;touch /tmp/no'},{namespace:'kube-system',deployment:'coredns'},{namespace:'apps',deployment:'../api'}])assert.equal((await f.run('restart',{},target)).code,1);
  await assert.rejects(access(f.calls));
 }finally{await f.close();}
});

test('missing or unreachable Kubernetes does not report a successful action',async()=>{
 const f=await actionFixture({fail:true});try{const result=await f.run('stop');assert.equal(result.code,1);assert.match(result.value.error,/confirm the Deployment state/);assert.equal((await f.commands()).length,1);}finally{await f.close();}
});

async function installFixture(options:Record<string,unknown>={}) {
 const root=await realpath(await mkdtemp(join(tmpdir(),'serverdesk-k3s-install-')));const bin=join(root,'bin'),calls=join(root,'calls.jsonl'),installed=join(root,'installed.json');await mkdir(bin);
 for(const part of ['etc','run/systemd/system','proc','sys/fs/cgroup','usr/local/bin'])await mkdir(join(root,part),{recursive:true});
 await writeFile(join(root,'etc/os-release'),'ID=ubuntu\n');await writeFile(join(root,'proc/meminfo'),'MemTotal: 4194304 kB\nMemAvailable: 2097152 kB\n');
 const fakeBinary=String.raw`#!/usr/bin/env python3
import sys
a=sys.argv[1:]
if a==['--version']:print('k3s version v1.36.4+k3s1 (pinned)')
elif 'get' in a:print('single-node\tTrue')
elif 'wait' in a:print('node/single-node condition met')
else:sys.exit(2)
`;
 const binarySource=join(root,'fake-k3s');await writeFile(binarySource,fakeBinary,{mode:0o700});
 const installer='#!/bin/sh\npython3 - <<\'STUB\'\nimport os,json,shutil\nfrom pathlib import Path\nPath('+JSON.stringify(installed)+').write_text(json.dumps({k:v for k,v in os.environ.items() if k.startswith("INSTALL_K3S_")}))\nshutil.copy2('+JSON.stringify(binarySource)+','+JSON.stringify(join(root,'usr/local/bin/k3s'))+')\nSTUB\n';
 await writeFile(join(bin,'curl'),String.raw`#!/usr/bin/env python3
import sys
from pathlib import Path
a=sys.argv[1:]
Path(a[a.index('--output')+1]).write_text(INSTALLER)
`.replace('INSTALLER',JSON.stringify(installer)),{mode:0o700});
 await writeFile(join(bin,'uname'),'#!/bin/sh\nprintf x86_64\n',{mode:0o700});
 await writeFile(join(bin,'systemctl'),String.raw`#!/usr/bin/env python3
import sys,json
from pathlib import Path
a=sys.argv[1:]
with open(CALLS,'a') as f:f.write(json.dumps(a)+'\n')
if 'show' in a:print('loaded' if a[-1]==LOADED else 'not-found')
`.replace('CALLS',JSON.stringify(calls)).replace('LOADED',JSON.stringify(options.loaded??'')),{mode:0o700});
 const firewallState=join(root,'firewall.json');await writeFile(firewallState,JSON.stringify({}));
 const iptables=String.raw`#!/usr/bin/env python3
import sys,json,shlex
from pathlib import Path
a=sys.argv[1:];name=Path(sys.argv[0]).name;family='v6' if name.startswith('ip6') else 'v4';p=Path(STATE);s=json.loads(p.read_text());f=s.setdefault(family,{'input':['-A INPUT -p tcp --dport 22 -j ACCEPT'],'chain':None})
if name.endswith('-restore'):
 if FAIL:sys.exit(1)
 rows=sys.stdin.read().splitlines();chain=[]
 for row in rows:
  if row.startswith('-A SERVERDESK_K3S_INPUT'):chain.append(row)
  if row.startswith('-D INPUT'):
   old=row.replace('-D ','-A ',1)
   if old in f['input']:f['input'].remove(old)
  if row.startswith('-I INPUT 1 '):f['input'].insert(0,row.replace('-I INPUT 1 ','-A INPUT ',1))
 f['chain']=chain;p.write_text(json.dumps(s))
elif '-S' in a:
 chain=a[-1]
 if chain=='INPUT':print('-P INPUT ACCEPT\n'+'\n'.join(f['input']))
 elif f['chain'] is None:sys.exit(1)
 else:print('\n'.join(f['chain']))
else:sys.exit(2)
`.replace('STATE',JSON.stringify(firewallState)).replace('FAIL',options.firewallFail?'True':'False');
 for(const executable of ['iptables','iptables-restore','ip6tables','ip6tables-restore'])await writeFile(join(bin,executable),iptables,{mode:0o700});
 const script=options.checksumFailure?K3S_INSTALL_SCRIPT:K3S_INSTALL_SCRIPT.replace(K3S_INSTALLER_SHA256,createHash('sha256').update(installer).digest('hex'));
 const env={PATH:bin+':'+process.env.PATH,SERVERDESK_TEST_K3S_ROOT:root,SERVERDESK_TEST_CPU:String(options.cpu??2),SERVERDESK_TEST_DISK:String(options.disk??10*1024**3),SERVERDESK_K3S_VERSION:DEFAULT_K3S_VERSION};
 if(options.existing){await mkdir(join(root,'etc/rancher/k3s'),{recursive:true});await writeFile(join(root,'etc/rancher/k3s/k3s.yaml'),'private kubeconfig sentinel');await writeFile(join(root,'usr/local/bin/k3s'),fakeBinary,{mode:0o700});}
 return {root,bin,installed,calls,script,env,firewallState,run:()=>python(script,{},env),async close(){await rm(root,{recursive:true,force:true});}};
}

test('isolated K3s installation checks the installer checksum and uses a pinned single-node configuration',async()=>{
 const f=await installFixture();try{
  const result=await f.run();assert.equal(result.code,0,result.stderr);assert.match(result.stdout,/Single-node K3s is ready/);
  const env=JSON.parse(await readFile(f.installed,'utf8'));assert.equal(env.INSTALL_K3S_VERSION,DEFAULT_K3S_VERSION);assert.equal(env.INSTALL_K3S_SKIP_START,'true');assert.equal(env.INSTALL_K3S_SYMLINK,'skip');assert.match(env.INSTALL_K3S_EXEC,/--bind-address=0.0.0.0/);assert.match(env.INSTALL_K3S_EXEC,/--disable=traefik --disable=servicelb/);assert.ok(!env.INSTALL_K3S_EXEC.includes('--server='));
  assert.ok((await readFile(f.calls,'utf8')).includes('enable'));
  const dropin=await readFile(join(f.root,'etc/systemd/system/k3s.service.d/10-serverdesk-firewall.conf'),'utf8');assert.match(dropin,/Requires=serverdesk-k3s-firewall.service/);assert.match(dropin,/ExecStartPre=/);assert.match(dropin,/ExecStartPost=/);
 }finally{await f.close();}
});

test('a checksum mismatch executes no installer and starts no service',async()=>{
 const f=await installFixture({checksumFailure:true});try{const result=await f.run();assert.equal(result.code,1);assert.match(result.stderr,/checksum did not match/);await assert.rejects(access(f.installed));assert.ok(!(await readFile(f.calls,'utf8')).split('\n').filter(Boolean).some(line=>{const args=JSON.parse(line);return args.includes('enable')&&args.includes('k3s.service');}));}finally{await f.close();}
});

test('existing healthy K3s is reused without reading its kubeconfig, changing version, or restarting',async()=>{
 const f=await installFixture({existing:true});try{
  const result=await f.run();assert.equal(result.code,0,result.stderr);assert.match(result.stdout,/left unchanged/);assert.ok(!result.stdout.includes('private kubeconfig sentinel'));assert.equal(await readFile(join(f.root,'etc/rancher/k3s/k3s.yaml'),'utf8'),'private kubeconfig sentinel');await assert.rejects(access(f.installed));assert.ok(!(await readFile(f.calls,'utf8')).includes('enable'));
 }finally{await f.close();}
});

test('existing unready K3s and an unowned firewall chain are rejected without executing the installer',async()=>{
 const unhealthy=await installFixture({existing:true});try{
  await writeFile(join(unhealthy.root,'usr/local/bin/k3s'),'#!/bin/sh\nif [ "$1" = --version ]; then printf "k3s version v1.36.4+k3s1\\n"; else printf "single-node\\tFalse\\n"; fi\n',{mode:0o700});
  const result=await unhealthy.run();assert.equal(result.code,1);assert.match(result.stderr,/Existing K3s is not ready/);await assert.rejects(access(unhealthy.installed));assert.ok(!(await readFile(unhealthy.calls,'utf8')).includes('enable'));
 }finally{await unhealthy.close();}
 const collision=await installFixture();try{
  await writeFile(collision.firewallState,JSON.stringify({v4:{input:[],chain:['-A SERVERDESK_K3S_INPUT -j ACCEPT']}}));const before=await readFile(collision.firewallState,'utf8');const result=await collision.run();assert.equal(result.code,1);assert.match(result.stderr,/reserved K3s firewall chain already exists/);assert.equal(await readFile(collision.firewallState,'utf8'),before);await assert.rejects(access(collision.installed));
 }finally{await collision.close();}
});

test('existing Kubernetes workers and insufficient resources are rejected before downloads or installation',async()=>{
 for(const options of [{loaded:'k3s-agent.service'},{loaded:'kubelet.service'},{cpu:1},{disk:1024}]){
  const f=await installFixture(options);try{const result=await f.run();assert.equal(result.code,1);await assert.rejects(access(f.installed));assert.ok(!(await readFile(f.calls,'utf8')).includes('enable'));}finally{await f.close();}
 }
});

test('isolated host firewall is idempotent, preserves unrelated INPUT rules, and rejects public API traffic',async()=>{
 const f=await installFixture();try{
  assert.equal((await python(K3S_FIREWALL_SCRIPT,{},f.env)).code,0);const once=await readFile(f.firewallState,'utf8');assert.equal((await python(K3S_FIREWALL_SCRIPT,{},f.env)).code,0);assert.equal(await readFile(f.firewallState,'utf8'),once);
  const families=JSON.parse(once);for(const [family,rules] of Object.entries(families) as Array<[string,{input:string[];chain:string[]}]>){assert.equal(rules.input.length,2);assert.match(rules.input[0]!,/--dports 6443,10250 -j SERVERDESK_K3S_INPUT/);assert.equal(rules.input[1],'-A INPUT -p tcp --dport 22 -j ACCEPT');assert.equal(rules.chain.at(-1),'-A SERVERDESK_K3S_INPUT -j DROP');
   const verdict=(iface:string,local:boolean,pod:boolean)=>rules.chain.find(line=>line.includes('-i lo')?iface==='lo':line.includes('--src-type LOCAL')?local:line.includes('-i cni0')?iface==='cni0'&&pod:line.endsWith('-j DROP'))?.split(' -j ')[1];
   assert.equal(verdict('eth0',false,false),'DROP');assert.equal(verdict('lo',false,false),'ACCEPT');assert.equal(verdict('eth0',true,false),'ACCEPT');assert.equal(verdict('cni0',false,true),family==='v4'?'ACCEPT':'DROP');assert.equal(verdict('eth0',false,true),'DROP');
  }
 }finally{await f.close();}
});

test('firewall failure prevents the K3s installer from executing',async()=>{
 const f=await installFixture({firewallFail:true});try{const result=await f.run();assert.equal(result.code,1);await assert.rejects(access(f.installed));assert.ok(!(await readFile(f.calls,'utf8')).split('\n').filter(Boolean).some(line=>{const args=JSON.parse(line);return args.includes('enable')&&args.includes('k3s.service');}));}finally{await f.close();}
});

test('SSH Kubernetes requests carry targets on stdin, enforce host pinning, and do not interpolate targets in commands',async()=>{
 const root=await mkdtemp(join(tmpdir(),'serverdesk-k3s-ssh-'));try{
  const capture=join(root,'capture.json'),ssh=join(root,'ssh');await writeFile(ssh,'#!/usr/bin/env python3\nimport sys,json\nfrom pathlib import Path\nr=json.load(sys.stdin)\nPath('+JSON.stringify(capture)+').write_text(json.dumps({"command":sys.argv[-1],"request":r}))\nprint(json.dumps({"log":"requested","replicas":4}))\n',{mode:0o700});
  const hostKey='ssh-ed25519 '+Buffer.alloc(51,42).toString('base64');const server:Server={id:'one',name:'one',host:'127.0.0.1',port:22,username:'ubuntu',group:'',notes:'',createdAt:'',updatedAt:'',fingerprint:hostKeyFingerprint(hostKey)};
  const remote=new SSHRemote({dataDir:root,sshPath:ssh});assert.equal((await remote.kubernetesAction(server,{hostKey},{namespace:'my-apps',deployment:'hello'},'restart')).replicas,4);const value=JSON.parse(await readFile(capture,'utf8'));assert.deepEqual(value.request.target,{namespace:'my-apps',deployment:'hello'});assert.ok(!value.command.includes('my-apps'));assert.ok(!value.command.includes('hello'));
  await assert.rejects(remote.kubernetesAction(server,{hostKey},{namespace:'my-apps',deployment:'hello;id'},'restart'),/Invalid Kubernetes target/);await assert.rejects(remote.kubernetesAction({...server,fingerprint:undefined},{hostKey},{namespace:'apps',deployment:'hello'},'stop'),/pin/);
 }finally{await rm(root,{recursive:true,force:true});}
});
