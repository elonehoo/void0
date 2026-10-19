import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {BOOTSTRAP_SCRIPT,DOMAIN_SCRIPT,K3S_BOOTSTRAP_SCRIPT,KUBERNETES_ACTION_SCRIPT,PROBE_SCRIPT,STATUS_SCRIPT,SUBMIT_SCRIPT} from './remote-scripts.js';

let cached:Buffer|undefined;
const asset=(name:string)=>readFileSync(resolve('agent',name));
export function agentInstaller():Buffer{return asset('install.sh');}
export function agentBundle():Buffer {
  if(cached)return cached;
  const python=(script:string,timeoutSeconds:number)=>({language:'python',script,timeoutSeconds,outputLimit:256*1024});
  const shell=(script:string)=>({language:'shell',script,timeoutSeconds:900,outputLimit:256*1024});
  const programs={probe:python(PROBE_SCRIPT,90),bootstrap:{docker:shell(BOOTSTRAP_SCRIPT),k3s:shell(K3S_BOOTSTRAP_SCRIPT)},submit:python(SUBMIT_SCRIPT,180),status:python(STATUS_SCRIPT,60),'kubernetes-action':python(KUBERNETES_ACTION_SCRIPT,180),domain:python(DOMAIN_SCRIPT,240)};
  const files=[['daemon.py',asset('daemon.py')],['programs.json',Buffer.from(JSON.stringify(programs))],['serverdesk-agent.service',asset('serverdesk-agent.service')],['install.sh',agentInstaller()]] as const;
  const blocks:Buffer[]=[];
  for(const [name,data] of files){
    const header=Buffer.alloc(512);
    header.write(name,0,100,'utf8');
    const octal=(offset:number,length:number,value:number)=>header.write(value.toString(8).padStart(length-1,'0')+'\0',offset,length,'ascii');
    octal(100,8,0o600);octal(108,8,0);octal(116,8,0);octal(124,12,data.length);octal(136,12,0);
    header.fill(32,148,156);header.write('0',156);header.write('ustar\0',257,6,'ascii');header.write('00',263,2,'ascii');
    const sum=header.reduce((total,value)=>total+value,0);header.write(sum.toString(8).padStart(6,'0')+'\0 ',148,8,'ascii');
    blocks.push(header,data,Buffer.alloc((512-data.length%512)%512));
  }
  blocks.push(Buffer.alloc(1024));cached=gzipSync(Buffer.concat(blocks));return cached;
}
export function agentManifest(){const bundle=agentBundle();return {version:'0.3.0',sha256:createHash('sha256').update(bundle).digest('hex')};}
