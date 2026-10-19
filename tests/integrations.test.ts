import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {repositoryName,validWebhook,GitHub,Vercel} from '../server/integrations.js';

test('repository names accept canonical GitHub URLs but never credentials, paths or arbitrary hosts',()=>{
  assert.equal(repositoryName('https://github.com/org/project.git'),'org/project');
  assert.equal(repositoryName('org/project'),'org/project');
  for(const value of ['https://token@github.com/org/project','https://elsewhere.com/org/project','org/project?token=x','org/project/../other','../project'])assert.throws(()=>repositoryName(value));
});
test('GitHub notification signatures follow the official SHA256 vector and reject tampering',()=>{
  const secret="It's a Secret to Everybody",body=Buffer.from('Hello, World!');
  const signature='sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';
  assert.equal(validWebhook(secret,signature,body),true);
  assert.equal(validWebhook(secret,signature,Buffer.from('Hello, World?')),false);
  assert.equal(validWebhook(secret,'sha256=bad',body),false);
  assert.equal(validWebhook(secret,undefined,body),false);
});
test('GitHub fixed API host does not follow credential-bearing redirects and sanitizes errors',async()=>{
  let requested='';let options:RequestInit|undefined;
  const gh=new GitHub('private-secret',async(input,init)=>{requested=String(input);options=init;return new Response(JSON.stringify({message:'private-secret'}),{status:403});});
  await assert.rejects(gh.commit('org/repo','feature/a'),error=>error instanceof Error&&!error.message.includes('private-secret'));
  assert.equal(requested,'https://api.github.com/repos/org/repo/commits/feature%2Fa');
  assert.equal(options?.redirect,'error');
});
test('Vercel preview failure does not replace a ready production state',async()=>{
  const fetcher:typeof fetch=async input=>{
    const url=String(input);let data:unknown;
    if(url.includes('/deployments?'))data={deployments:[{uid:'preview',state:'ERROR',url:'preview.example'}]};
    else if(url.includes('/domains'))data={domains:[{name:'production.example'}]};
    else data={targets:{production:{id:'production',readyState:'READY',url:'prod.vercel.app'}}};
    return new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
  };
  const now=new Date().toISOString();
  const result=await new Vercel('secret',fetcher).status({id:'service',name:'web',kind:'vercel',target:{vercelProjectId:'prj_one'},autoDeploy:false,createdAt:now,updatedAt:now});
  assert.equal(result.ready,true);assert.equal(result.state,'running');assert.equal(result.deployments?.[0].state,'ERROR');
});
