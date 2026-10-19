/** Explicit local-only smoke test. Never connects to an SSH host or production server. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp,writeFile,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeployPlan } from '../shared/types.js';
import { SUBMIT_SCRIPT } from '../server/remote-scripts.js';

async function command(args:string[],input?:string,timeout=180000):Promise<string> {
 return await new Promise((resolve,reject)=>{
  const process=spawn('docker',args,{stdio:['pipe','pipe','pipe']});let output='',error='';const timer=setTimeout(()=>process.kill('SIGKILL'),timeout);
  process.stdout.on('data',value=>output=(output+value).slice(-131072));process.stderr.on('data',value=>error=(error+value).slice(-32768));process.stdin.on('error',()=>{});
  process.on('error',reject);process.on('close',code=>{clearTimeout(timer);if(code!==0)reject(new Error('Local Docker verification command failed ('+String(code)+'): '+error));else resolve(output.trim());});process.stdin.end(input);
 });
}

test('real Docker: selected source update preserves sibling, config and volume; failed image restores previous version',{
 skip:(process.env.VOID0_DOCKER_SMOKE??process.env.SERVERDESK_DOCKER_SMOKE)!=='1'?'Set SERVERDESK_DOCKER_SMOKE=1 to create disposable local Docker verification resources':false,
 timeout:360000,
},async()=>{
 const uuid=randomUUID();const slug=uuid.replaceAll('-','');const project='sdverify'+slug;const helper='serverdesk-verification-'+slug;const helperImage='serverdesk-verification-helper:'+slug;
 const sourceImage='serverdesk/'+uuid;const ownedId=randomUUID(),ownedProject='sd-'+ownedId.replaceAll('-','');const temp=await mkdtemp(join(tmpdir(),'serverdesk-docker-verification-'));let helperStarted=false,ownedStarted=false;
 const inside=(args:string[],input?:string)=>command(['exec','-i',helper,...args],input);
 try {
  await command(['info','--format','{{.ServerVersion}}']);
  await writeFile(join(temp,'Dockerfile.helper'),'FROM docker:29-cli\nRUN apk add --no-cache python3\n');
  await command(['build','--quiet','-t',helperImage,'-f',join(temp,'Dockerfile.helper'),temp],undefined,180000);
  await command(['run','-d','--name',helper,'--label','com.serverdesk.verification='+uuid,'-v','/var/run/docker.sock:/var/run/docker.sock','-v',temp+':/verification',helperImage,'sleep','600']);helperStarted=true;
  await writeFile(join(temp,'submit.py'),SUBMIT_SCRIPT);
  const compose={services:{app:{image:'nginx:1.27-alpine',environment:{SERVERDESK_TEST_PRESERVED:'${PRESERVED}'},volumes:['data:/data'],healthcheck:{test:['CMD','wget','-q','-O','/dev/null','http://127.0.0.1/'],interval:'1s',timeout:'1s',retries:10,start_period:'1s'}},sibling:{image:'redis:7-alpine'}},volumes:{data:{}}};
  const original=JSON.stringify(compose);await writeFile(join(temp,'compose.json'),original);
  await writeFile(join(temp,'.env'),'PRESERVED=from-default-env\n',{mode:0o600});await writeFile(join(temp,'production.env'),'PRESERVED=from-explicit-env\n',{mode:0o600});
  await inside(['docker','compose','--project-name',project,'--project-directory','/verification','--env-file','/verification/production.env','-f','/verification/compose.json','up','-d','--wait','--wait-timeout','45']);
  const container=(service:string)=>command(['ps','-aq','--filter','label=com.docker.compose.project='+project,'--filter','label=com.docker.compose.service='+service]);
  const appBefore=await container('app'),siblingBefore=await container('sibling');assert.match(appBefore,/^[a-f0-9]+$/);assert.match(siblingBefore,/^[a-f0-9]+$/);
  await command(['exec',appBefore,'sh','-c','printf volume-survived > /data/serverdesk-verification']);
  const archiveScript="import sys,json,io,tarfile,base64\ncontent=json.load(sys.stdin)['dockerfile'].encode()\nbuf=io.BytesIO()\nwith tarfile.open(fileobj=buf,mode='w:gz') as tar:\n info=tarfile.TarInfo('repo/Dockerfile');info.size=len(content);tar.addfile(info,io.BytesIO(content))\nprint(base64.b64encode(buf.getvalue()).decode())";
  const date=new Date().toISOString();const plan:DeployPlan={server:{id:uuid,name:'Local isolated verification',host:'127.0.0.1',port:22,username:'root',group:'',notes:'',createdAt:date,updatedAt:date},service:{id:uuid,name:'Disposable verification service',kind:'compose',serverId:uuid,target:{composeProject:project,composeService:'app'},autoDeploy:false,createdAt:date,updatedAt:date},job:{id:randomUUID(),serviceId:uuid,serverId:uuid,type:'deploy',source:'manual',state:'queued',stage:'queued',log:'',createdAt:date,updatedAt:date},repository:{owner:'isolated-test',repo:'isolated-test',commit:'a'.repeat(40)}};
  const submit=async(dockerfile:string)=>{
   const archive=await inside(['python3','-c',archiveScript],JSON.stringify({dockerfile}));
   const result=await inside(['env','SERVERDESK_TEST_ROOT=/verification/state','SERVERDESK_TEST_SYNC=1','python3','/verification/submit.py'],JSON.stringify({plan,archive}));return JSON.parse(result) as {state:string;message?:string;log:string};
  };
  const good=await submit("FROM nginx:1.27-alpine\nRUN printf 'serverdesk-new-release' > /usr/share/nginx/html/index.html\n");assert.equal(good.state,'succeeded',good.message+'\n'+good.log);
  const appAfter=await container('app');assert.notEqual(appAfter,appBefore);assert.equal(await container('sibling'),siblingBefore);
  assert.equal(await command(['exec',appAfter,'cat','/data/serverdesk-verification']),'volume-survived');assert.equal(await command(['exec',appAfter,'printenv','SERVERDESK_TEST_PRESERVED']),'from-explicit-env');assert.equal(await command(['exec',appAfter,'wget','-q','-O','-','http://127.0.0.1/']),'serverdesk-new-release');assert.equal(await readFile(join(temp,'compose.json'),'utf8'),original);
  plan.job.id=randomUUID();plan.repository!.commit='b'.repeat(40);
  const bad=await submit('FROM nginx:1.27-alpine\nCMD ["sh","-c","exit 1"]\n');assert.equal(bad.state,'rolled_back',bad.message);
  const restored=await container('app');assert.equal(await command(['exec',restored,'wget','-q','-O','-','http://127.0.0.1/']),'serverdesk-new-release');assert.equal(await command(['exec',restored,'cat','/data/serverdesk-verification']),'volume-survived');assert.equal(await container('sibling'),siblingBefore);assert.equal(await readFile(join(temp,'compose.json'),'utf8'),original);
  assert.equal(await command(['exec',restored,'printenv','SERVERDESK_TEST_PRESERVED']),'from-explicit-env');
  plan.service={...plan.service,id:ownedId,kind:'source',target:{composeProject:ownedProject,composeService:'app'},containerPort:80,environment:{SECRET_LITERAL:'foo$BAR${BAZ}'}};plan.job={...plan.job,id:randomUUID(),serviceId:ownedId};plan.repository!.commit='c'.repeat(40);ownedStarted=true;
  const owned=await submit('FROM nginx:1.27-alpine\n');assert.equal(owned.state,'succeeded',owned.message+'\n'+owned.log);const ownedContainer=await command(['ps','-aq','--filter','label=com.docker.compose.project='+ownedProject,'--filter','label=com.docker.compose.service=app']);assert.match(ownedContainer,/^[a-f0-9]+$/);assert.equal(await command(['exec',ownedContainer,'printenv','SECRET_LITERAL']),'foo$BAR${BAZ}');const published=await command(['inspect','--format','{{json .HostConfig.PortBindings}}',ownedContainer]);assert.ok(published==='{}'||published==='null');
 } finally {
  if(helperStarted&&ownedStarted)await inside(['docker','compose','--project-name',ownedProject,'-f','/verification/state/services/'+ownedId+'/compose.json','down','--volumes','--remove-orphans']).catch(()=>{});
  if(helperStarted)await inside(['docker','compose','--project-name',project,'-f','/verification/compose.json','down','--volumes','--remove-orphans']).catch(()=>{});
  await command(['rm','-f',helper]).catch(()=>{});
  await command(['image','rm',sourceImage+':'+'a'.repeat(40),sourceImage+':'+'b'.repeat(40)]).catch(()=>{});
  await command(['image','rm','serverdesk/'+ownedId+':'+'c'.repeat(40)]).catch(()=>{});
  await command(['image','rm',helperImage]).catch(()=>{});
  await rm(temp,{recursive:true,force:true});
 }
});
