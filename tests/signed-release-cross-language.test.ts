import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {servicePolicyHash, signRelease} from '../server/releases.js';
import type {DeployPlan, Service} from '../shared/types.js';

async function run(command:string,args:string[],input='') {
  return new Promise<{code:number;stdout:string;stderr:string}>((done,reject)=>{
    const child=spawn(command,args,{env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='';
    const timer=setTimeout(()=>child.kill('SIGKILL'),30_000);
    child.stdout.on('data',part=>stdout+=part);child.stderr.on('data',part=>stderr+=part);
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('close',code=>{clearTimeout(timer);done({code:code??-1,stdout,stderr});});
    child.stdin.end(input);
  });
}

const verify=String.raw`
import copy, importlib.util, json, os, pathlib, shutil, sys, tempfile
fixture=json.load(sys.stdin)
spec=importlib.util.spec_from_file_location('serverdesk_agent',sys.argv[1]);agent=importlib.util.module_from_spec(spec);spec.loader.exec_module(agent)
root=os.geteuid()==0
parent=None
if root:
 parent='/var/lib/serverdesk-cross-language-tests';pathlib.Path(parent).mkdir(mode=0o700,exist_ok=True)
folder=pathlib.Path(tempfile.mkdtemp(prefix='node-python-',dir=parent))
try:
 public=folder/'publisher.pub';public.write_text(fixture['publicKey']);public.chmod(0o600)
 value={'version':1,'mode':'strict','serverId':'node-one','maxReleaseLifetimeSeconds':900,'keys':{'publisher-v1':str(public)},'services':{'web':{'repository':'acme/web','branch':'main','serviceSha256':fixture['serviceHash'],'imageRepositories':['registry.example/acme/web']}}}
 policyfile=folder/'release-policy.json';policyfile.write_text(json.dumps(value));policyfile.chmod(0o600)
 if root:
  policy=agent.ReleasePolicy(policyfile,'node-one',folder/'releases')
 else:
  policy=object.__new__(agent.ReleasePolicy);policy.path=policyfile;policy.server_id='node-one';policy.policy=value;policy.state_directory=folder/'releases';policy.state_directory.mkdir(mode=0o700)
  agent.trusted_root_file=lambda path,**kwargs:pathlib.Path(path).read_bytes()
  if os.uname().sysname=='Darwin':policy.OPENSSL='/opt/homebrew/opt/openssl@3/bin/openssl'
 release=fixture['release'];payload={**release['payload'],'authorization':release['authorization']}
 bad=copy.deepcopy(payload);bad['plan']['service']['hostPort']=22
 try:policy.authorize('submit',bad);raise AssertionError('accepted tampered plan')
 except agent.AgentError:pass
 result=policy.authorize('submit',payload)
 assert result==release['payload']
 try:policy.authorize('submit',payload);raise AssertionError('accepted replay')
 except agent.AgentError as error:assert 'replay' in str(error)
 print(json.dumps({'approved':True,'rootOwnershipVerified':root,'name':result['plan']['service']['name'],'image':result['plan']['service']['image']}))
finally:shutil.rmtree(folder)
`;

test('Node Ed25519 releases and canonical hashes are accepted by the real Python OpenSSL verifier',async()=>{
  const keys=generateKeyPairSync('ed25519',{privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
  const date='2026-10-19T00:00:00Z',commit='b'.repeat(40),image='registry.example/acme/web@sha256:'+'a'.repeat(64);
  const service:Service={id:'web',name:'中文😀\n\t${LITERAL}',kind:'image',serverId:'node-one',target:{},repository:'https://github.com/acme/web',branch:'main',autoDeploy:true,environment:{},containerPort:8080,hostPort:18080,volumes:[{name:'uploads',mountPath:'/data'}],createdAt:date,updatedAt:date};
  const plan:DeployPlan={service:{...service,image,lastCommit:commit},server:{id:'node-one',name:'节点',host:'127.0.0.1',port:22,username:'root',group:'lab',notes:'',connectionMode:'agent',createdAt:date,updatedAt:date},job:{id:'cross-language-job',serviceId:'web',serverId:'node-one',type:'deploy',source:'manual',state:'queued',stage:'等待发布',log:'',createdAt:date,updatedAt:date}};
  const now=Math.floor(Date.now()/1000);
  const release=signRelease({plan},{version:1,keyId:'publisher-v1',releaseId:'cross-language-release',sequence:1,issuedAt:now,expiresAt:now+300,serverId:'node-one',serviceId:'web',repository:'acme/web',branch:'main',commit},keys.privateKey);
  const vm=(process.env.VOID0_RELEASE_POLICY_VM??process.env.SERVERDESK_RELEASE_POLICY_VM);
  const args=vm?['-m',vm,'-u','root','python3','-c',verify,(process.env.VOID0_RELEASE_POLICY_DAEMON??process.env.SERVERDESK_RELEASE_POLICY_DAEMON)??'/var/lib/serverdesk-policy-verification/agent/daemon.py']:['-c',verify,resolve('agent/daemon.py')];
  const result=await run(vm?'orb':'python3',args,JSON.stringify({publicKey:keys.publicKey,serviceHash:servicePolicyHash(service),release}));
  assert.equal(result.code,0,result.stderr);
  const output=JSON.parse(result.stdout) as {approved:boolean;rootOwnershipVerified:boolean;name:string;image:string};
  assert.equal(output.approved,true);assert.equal(output.name,service.name);assert.equal(output.image,image);
  if(vm)assert.equal(output.rootOwnershipVerified,true);
});

test('Python release policy rejection and fixed-operation tests remain part of the normal test suite',async()=>{
  const result=await run('python3',['-m','unittest','discover','-s','agent/tests','-v']);
  assert.equal(result.code,0,result.stderr);
});
