import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import type { DeployPlan, Job, RemoteJobStatus, RemoteTransport, Server, ServerStatus, SSHCredential } from '../shared/types.js';
import { BOOTSTRAP_SCRIPT, k3sBootstrapScript, KUBERNETES_ACTION_SCRIPT, PROBE_SCRIPT, STATUS_SCRIPT, SUBMIT_SCRIPT } from './remote-scripts.js';
import { remoteJobStatus } from './remote-status.js';

export interface SSHRemoteOptions { dataDir?:string; sshPath?:string; keyscanPath?:string; fetch?:typeof globalThis.fetch }
interface ProcessOutput { stdout:string; stderr:string; code:number }
const quote = (text:string) => "'" + text.replaceAll("'", "'\\''") + "'";
const limit = 256 * 1024;

function validateServer(server:Server) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.:[\]-]{0,252}$/.test(server.host) || server.host.includes('..')) throw new Error('Invalid server hostname');
  if (!/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(server.username)) throw new Error('Invalid SSH username');
  if (!Number.isInteger(server.port) || server.port < 1 || server.port > 65535) throw new Error('Invalid SSH port');
}

export function hostKeyFingerprint(hostKey:string):string {
  const parts = hostKey.trim().split(/\s+/);
  if (parts.length !== 2 || !/^(ssh-ed25519|ecdsa-sha2-nistp(?:256|384|521)|ssh-rsa)$/.test(parts[0]!) || !/^[A-Za-z0-9+/]+={0,2}$/.test(parts[1]!)) throw new Error('Invalid SSH host key');
  const decoded = Buffer.from(parts[1]!, 'base64');
  if (decoded.length < 20 || decoded.length > 16384 || decoded.toString('base64').replace(/=+$/, '') !== parts[1]!.replace(/=+$/, '')) throw new Error('Invalid SSH host key');
  return 'SHA256:' + createHash('sha256').update(decoded).digest('base64').replace(/=+$/, '');
}

async function run(executable:string, args:string[], input:Buffer|undefined, env:NodeJS.ProcessEnv, timeout:number):Promise<ProcessOutput> {
  return await new Promise((resolve,reject) => {
    const child = spawn(executable,args,{env,stdio:['pipe','pipe','pipe']});
    const stdout:Buffer[] = [],stderr:Buffer[] = [];let outSize=0,errSize=0,expired=false,settled=false;
    const timer=setTimeout(()=>{ expired=true;child.kill('SIGKILL'); },timeout);timer.unref();
    child.stdout.on('data',(chunk:Buffer)=>{outSize+=chunk.length;if(outSize<=limit)stdout.push(chunk);else child.kill('SIGKILL');});
    child.stderr.on('data',(chunk:Buffer)=>{errSize+=chunk.length;if(errSize<=limit)stderr.push(chunk);});
    child.stdin.on('error',()=>{});
    child.on('error',error=>{if(!settled){settled=true;clearTimeout(timer);reject(error);}});
    child.on('close',code=>{if(settled)return;settled=true;clearTimeout(timer);if(expired)reject(new Error('SSH operation timed out; remote work may still be running'));else if(outSize>limit)reject(new Error('SSH response exceeded the size limit'));else resolve({stdout:Buffer.concat(stdout).toString(),stderr:Buffer.concat(stderr).toString(),code:code??-1});});
    child.stdin.end(input);
  });
}

function parseStatus(raw:string):RemoteJobStatus {
  let value:unknown;try { value=JSON.parse(raw.trim()); } catch { throw new Error('Server did not return a valid job receipt'); }
  return remoteJobStatus(value);
}

export class SSHRemote implements RemoteTransport {
  private options:SSHRemoteOptions;
  constructor(options:SSHRemoteOptions={}) { this.options=options; }

  async fingerprint(server:Server):Promise<{fingerprint:string;hostKey:string}> {
    validateServer(server);
    const env={PATH:process.env.PATH,HOME:homedir(),LANG:'C'};
    const result=await run(this.options.keyscanPath??'ssh-keyscan',['-T','10','-p',String(server.port),'-t','ed25519,ecdsa,rsa',server.host],undefined,env,15000);
    const keys=result.stdout.split('\n').filter(x=>x&&!x.startsWith('#')).map(line=>line.trim().split(/\s+/)).filter(x=>x.length===3);
    const selected=keys.find(x=>x[1]==='ssh-ed25519')??keys.find(x=>x[1]?.startsWith('ecdsa-sha2-'))??keys[0];
    if(!selected)throw new Error('Could not read the server SSH host key');
    const hostKey=selected.slice(1).join(' ');return {hostKey,fingerprint:hostKeyFingerprint(hostKey)};
  }

  private async execute(server:Server,credential:SSHCredential|undefined,command:string,input:Buffer|undefined,timeout:number):Promise<ProcessOutput> {
    validateServer(server);
    if(!server.fingerprint || !credential?.hostKey)throw new Error('Review and pin the server SSH fingerprint before connecting');
    if(hostKeyFingerprint(credential.hostKey)!==server.fingerprint)throw new Error('The pinned SSH host key does not match this server');
    const base=this.options.dataDir?join(this.options.dataDir,'ssh-temp'):join(tmpdir(),'serverdesk-ssh');
    await mkdir(base,{recursive:true,mode:0o700});await chmod(base,0o700);
    const dir=await mkdtemp(join(base,'session-'));await chmod(dir,0o700);
    const secrets=[credential.password,credential.privateKey].filter((x):x is string=>Boolean(x));
    const clean=(value:string)=>secrets.reduce((out,secret)=>out.replaceAll(secret,'[redacted]'),value);
    try {
      const knownHosts=join(dir,'known_hosts');
      await writeFile(knownHosts,`[${server.host}]:${server.port} ${credential.hostKey}\n${server.host} ${credential.hostKey}\n`,{mode:0o600});
      const args=['-T','-p',String(server.port),'-o','ConnectTimeout=15','-o','ConnectionAttempts=1','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=2','-o','StrictHostKeyChecking=yes','-o',`UserKnownHostsFile=${knownHosts}`,'-o','GlobalKnownHostsFile=/dev/null','-o','ControlMaster=no','-o','ForwardAgent=no','-o','ClearAllForwardings=yes','-o','LogLevel=ERROR'];
      const env:NodeJS.ProcessEnv={PATH:process.env.PATH,HOME:homedir(),LANG:'C',LC_ALL:'C',SSH_AUTH_SOCK:process.env.SSH_AUTH_SOCK};
      if(credential.privateKey) {
        const keyPath=join(dir,'identity');await writeFile(keyPath,credential.privateKey,{mode:0o600});args.push('-i',keyPath,'-o','IdentitiesOnly=yes');
      } else args.push('-o','IdentitiesOnly=yes');
      if(credential.password) {
        const askpass=join(dir,'askpass');await writeFile(askpass,'#!/bin/sh\nprintf \'%s\\n\' "$SERVERDESK_SSH_PASSWORD"\n',{mode:0o700});
        env.SSH_ASKPASS=askpass;env.SSH_ASKPASS_REQUIRE='force';env.DISPLAY='serverdesk:0';env.SERVERDESK_SSH_PASSWORD=credential.password;args.push('-o','BatchMode=no','-o','NumberOfPasswordPrompts=1');
      } else args.push('-o','BatchMode=yes');
      args.push(`${server.username}@${server.host}`,command);
      const result=await run(this.options.sshPath??'ssh',args,input,env,timeout);
      result.stdout=clean(result.stdout);result.stderr=clean(result.stderr);
      return result;
    } finally { await rm(dir,{recursive:true,force:true}); }
  }

  async probe(server:Server,credential:SSHCredential|undefined):Promise<ServerStatus> {
    const result=await this.execute(server,credential,'python3 -c '+quote(PROBE_SCRIPT),undefined,80000);
    if(result.code!==0)throw new Error('Server status could not be read over SSH');
    let status:ServerStatus;try {status=JSON.parse(result.stdout) as ServerStatus;}catch {throw new Error('Server status response was invalid');}
    return {...status,serverId:server.id,checkedAt:new Date().toISOString()};
  }

  async verifyConnection(server:Server,credential:SSHCredential|undefined):Promise<void> {
    const result=await this.execute(server,credential,"printf '%s\\n' 'SERVERDESK_CONNECTED'",undefined,30000);
    if(result.code!==0||result.stdout.trim()!=='SERVERDESK_CONNECTED')throw new Error('SSH connection could not be verified');
  }

  async bootstrap(server:Server,credential:SSHCredential|undefined,options?:{runtime?:'docker'|'k3s';version?:string}):Promise<{log:string}> {
    if(options?.runtime && !['docker','k3s'].includes(options.runtime))throw new Error('Unsupported server runtime');
    const script=options?.runtime==='k3s'?k3sBootstrapScript(options.version):BOOTSTRAP_SCRIPT;
    const result=await this.execute(server,credential,'sh -s',Buffer.from(script),600000);
    if(result.code!==0)throw new Error((options?.runtime==='k3s'?'K3s':'Dependency')+' installation failed: '+result.stderr.trim().slice(-2048));
    return {log:result.stdout.slice(-65536)};
  }

  async kubernetesAction(server:Server,credential:SSHCredential|undefined,target:{namespace:string;deployment:string},action:'restart'|'stop'|'start'|'logs',options?:{replicas?:number}):Promise<{log:string;replicas?:number}> {
    if(!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(target.namespace) || target.deployment.length>253 || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(target.deployment) || target.deployment.includes('..'))throw new Error('Invalid Kubernetes target');
    if(!['restart','stop','start','logs'].includes(action))throw new Error('Unsupported Kubernetes action');
    if(options?.replicas!==undefined && (!Number.isInteger(options.replicas)||options.replicas<1||options.replicas>100))throw new Error('Replica count must be an integer from 1 to 100');
    const result=await this.execute(server,credential,'python3 -c '+quote(KUBERNETES_ACTION_SCRIPT),Buffer.from(JSON.stringify({target,action,options})),180000);
    let response:{log?:unknown;replicas?:unknown;error?:unknown;outcomeKnown?:unknown};try{response=JSON.parse(result.stdout);}catch{throw new Error('Kubernetes operation returned no valid receipt; confirm the Deployment state before retrying');}
    if(result.code!==0 || response.error){const error=new Error(typeof response.error==='string'?response.error:'Kubernetes operation failed; confirm the Deployment state before retrying');if(response.outcomeKnown===true)Object.assign(error,{outcomeKnown:true});throw error;}
    if(typeof response.log!=='string' || (response.replicas!==undefined&&(!Number.isInteger(response.replicas)||Number(response.replicas)<0)))throw new Error('Kubernetes operation returned an invalid receipt');
    return {log:response.log.slice(-32768),...(typeof response.replicas==='number'?{replicas:response.replicas}:{})};
  }

  async repositoryArchive(repository:NonNullable<DeployPlan['repository']>):Promise<Buffer> {
    if(!/^[A-Za-z0-9_.-]+$/.test(repository.owner)||!/^[A-Za-z0-9_.-]+$/.test(repository.repo)||!/^[a-fA-F0-9]{40,64}$/.test(repository.commit))throw new Error('A valid repository and pinned commit are required');
    const fetcher=this.options.fetch??fetch;
    const headers:Record<string,string>={'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'void0'};
    if(repository.token)headers.Authorization=`Bearer ${repository.token}`;
    // Resolve the API redirect manually; credentials must never follow onto codeload.
    const response=await fetcher(`https://api.github.com/repos/${repository.owner}/${repository.repo}/tarball/${repository.commit}`,{headers,redirect:'manual',signal:AbortSignal.timeout(30000)});
    let archive=response;
    if(response.status===302||response.status===301||response.status===307) {
      const location=response.headers.get('location');if(!location)throw new Error('GitHub did not provide a source archive');
      const url=new URL(location);if(url.protocol!=='https:'||url.hostname!=='codeload.github.com'||url.username||url.password)throw new Error('GitHub archive redirect was not trusted');
      archive=await fetcher(url,{headers:{'User-Agent':'void0'},redirect:'error',signal:AbortSignal.timeout(120000)});
    }
    if(!archive.ok||!archive.body)throw new Error('Could not download the pinned repository source');
    const declared=Number(archive.headers.get('content-length')??0);if(declared>50*1024*1024){await archive.body.cancel();throw new Error('Repository source exceeds 50 MiB');}
    const chunks:Buffer[]=[];let bytes=0;for await(const chunk of archive.body as unknown as AsyncIterable<Uint8Array>){bytes+=chunk.length;if(bytes>50*1024*1024)throw new Error('Repository source exceeds 50 MiB');chunks.push(Buffer.from(chunk));}
    return Buffer.concat(chunks);
  }

  async submit(plan:DeployPlan,credential:SSHCredential|undefined):Promise<RemoteJobStatus> {
    if(!['compose','source','image'].includes(plan.service.kind))throw new Error('This service does not support Docker Compose deployment');
    if(plan.server.id!==plan.job.serverId||plan.service.id!==plan.job.serviceId||plan.service.serverId!==plan.server.id)throw new Error('Deployment service and server do not match');
    const archive=plan.repository?await this.repositoryArchive(plan.repository):undefined;
    const safePlan={...plan,repository:plan.repository?{owner:plan.repository.owner,repo:plan.repository.repo,commit:plan.repository.commit}:undefined};
    const payload=Buffer.from(JSON.stringify({plan:safePlan,archive:archive?.toString('base64')}));
    const result=await this.execute(plan.server,credential,'python3 -c '+quote(SUBMIT_SCRIPT),payload,180000);
    const status=parseStatus(result.stdout);
    if(result.code!==0&&status.state!=='failed')throw new Error('Deployment submission was interrupted; confirm remote state before retrying');
    return status;
  }

  async status(job:Job,server:Server,credential:SSHCredential|undefined):Promise<RemoteJobStatus> {
    if(job.serverId!==server.id)throw new Error('Job server does not match');
    const result=await this.execute(server,credential,'python3 -c '+quote(STATUS_SCRIPT),Buffer.from(JSON.stringify({jobId:job.id})),30000);
    if(result.code!==0)throw new Error('Remote deployment state could not be confirmed');
    return parseStatus(result.stdout);
  }
}
