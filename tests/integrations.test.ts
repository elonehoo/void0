import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {repositoryName,validWebhook,GitHub,Vercel,IntegrationError} from '../server/integrations.js';
import type {Service} from '../shared/types.js';

const timestamp='2026-10-19T12:00:00.000Z';
function vercelService(scope?:string):Service {
  return {id:'vercel-service',name:'Website',kind:'vercel',target:{vercelProjectId:'prj_example',...(scope?{vercelScopeId:scope}:{})},autoDeploy:false,createdAt:timestamp,updatedAt:timestamp};
}

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
test('GitHub requests reject alternate destinations and preserve credentials against case-insensitive header overrides',async()=>{
  const calls:Array<{url:string;init?:RequestInit}>=[];
  const client=new GitHub('fixture-fixed-github-access',async(input,init)=>{calls.push({url:String(input),init});return new Response(JSON.stringify({login:'fixture-user'}));});
  for(const path of ['https://elsewhere.example/user','//elsewhere.example/user','user'])await assert.rejects(client.api(path),/请求地址无效/);
  assert.equal(calls.length,0);
  const overrides:HeadersInit[]=[{authorization:'Bearer caller-lowercase'},{Authorization:'Bearer caller-titlecase'},new Headers({'AUTHORIZATION':'Bearer caller-headers-object'}),[['authorization','Bearer caller-tuple']]];
  for(const headers of overrides){
    assert.deepEqual(await client.api('/user',{redirect:'follow',headers}),{login:'fixture-user'});
  }
  assert.equal(calls.length,4);
  for(const call of calls){
    assert.equal(call.url,'https://api.github.com/user');assert.equal(call.init?.redirect,'error');
    const headers=new Headers(call.init?.headers);assert.equal(headers.get('authorization'),'Bearer fixture-fixed-github-access');
    assert.equal(headers.get('accept'),'application/vnd.github+json');assert.equal(headers.get('x-github-api-version'),'2022-11-28');assert.equal(headers.get('user-agent'),'void0');
  }
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

test('Vercel requests retain the fixed API host, never follow redirects, and reject absolute destinations',async()=>{
  const calls:Array<{url:string;init?:RequestInit}>=[];
  const client=new Vercel('fixture-provider-credential',async(input,init)=>{
    calls.push({url:String(input),init});return new Response(JSON.stringify({ok:true}),{headers:{'content-type':'application/json'}});
  });
  for(const path of ['https://elsewhere.example/v2/user','//elsewhere.example/v2/user','v2/user'])await assert.rejects(client.api(path),/请求地址无效/);
  assert.equal(calls.length,0);
  await client.api('/v2/user',{redirect:'follow',headers:{Authorization:'Bearer caller-must-not-override'}});
  assert.equal(calls.length,1);assert.equal(calls[0].url,'https://api.vercel.com/v2/user');assert.equal(calls[0].init?.redirect,'error');
  assert.equal(new Headers(calls[0].init?.headers).get('authorization'),'Bearer fixture-provider-credential');
  assert.ok(calls[0].init?.signal instanceof AbortSignal);
});

test('Vercel HTTP failures reveal a useful category without exposing the provider response',async()=>{
  for(const [status,expected] of [[401,/登录已过期/],[403,/权限不足/],[409,/已分配给其他/],[404,/无法完成请求/],[500,/无法完成请求/]] as const){
    const client=new Vercel('fixture-private-credential',async()=>new Response(JSON.stringify({error:{message:'fixture-private-credential database-password=fixture-private-response'}}),{status,headers:{'content-type':'application/json'}}));
    await assert.rejects(client.addDomain(vercelService('team_example'),'app.example.com'),error=>{
      assert.ok(error instanceof Error);assert.match(error.message,expected);
      assert.equal(error.message.includes('fixture-private-credential'),false);assert.equal(error.message.includes('fixture-private-response'),false);
      return true;
    });
  }
});

test('Vercel domain mutations use the expected methods, JSON body and team scope, including empty 204 deletion',async()=>{
  const calls:Array<{url:URL;init?:RequestInit}>=[];
  const client=new Vercel('fixture-domain-access',async(input,init)=>{
    calls.push({url:new URL(String(input)),init});
    if(init?.method==='DELETE')return new Response(null,{status:204});
    return new Response(JSON.stringify({name:'app.example.com',verified:init?.body===undefined}),{headers:{'content-type':'application/json'}});
  });
  const service=vercelService('team_example');
  assert.deepEqual(await client.addDomain(service,'app.example.com'),{name:'app.example.com',verified:false});
  assert.deepEqual(await client.verifyDomain(service,'app.example.com'),{name:'app.example.com',verified:true});
  assert.equal(await client.removeDomain(service,'app.example.com'),undefined);
  assert.deepEqual(calls.map(call=>call.url.pathname),['/v10/projects/prj_example/domains','/v9/projects/prj_example/domains/app.example.com/verify','/v9/projects/prj_example/domains/app.example.com']);
  assert.deepEqual(calls.map(call=>call.init?.method),['POST','POST','DELETE']);
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)),{name:'app.example.com'});assert.equal(calls[1].init?.body,undefined);assert.equal(calls[2].init?.body,undefined);
  assert.equal(new Headers(calls[0].init?.headers).get('content-type'),'application/json');
  for(const call of calls){assert.equal(call.url.origin,'https://api.vercel.com');assert.equal(call.url.searchParams.get('teamId'),'team_example');assert.equal(call.init?.redirect,'error');assert.equal(new Headers(call.init?.headers).get('authorization'),'Bearer fixture-domain-access');}
});

test('Vercel domain paths encode names and personal accounts do not become team scopes',async()=>{
  const calls:URL[]=[];
  const client=new Vercel('fixture-domain-access',async(input,init)=>{
    calls.push(new URL(String(input)));return init?.method==='DELETE'?new Response(null,{status:204}):new Response(JSON.stringify({name:'app.example.com',verified:true}),{headers:{'content-type':'application/json'}});
  });
  const service=vercelService('account_personal'),name='app.example.com/path?teamId=unexpected#fragment';
  await client.verifyDomain(service,name);await client.removeDomain(service,name);await client.domainConfig(service,name);
  assert.equal(calls[0].pathname,`/v9/projects/prj_example/domains/${encodeURIComponent(name)}/verify`);
  assert.equal(calls[1].pathname,`/v9/projects/prj_example/domains/${encodeURIComponent(name)}`);
  assert.equal(calls[2].pathname,`/v6/domains/${encodeURIComponent(name)}/config`);assert.equal(calls[2].searchParams.get('projectIdOrName'),'prj_example');
  for(const call of calls){assert.equal(call.origin,'https://api.vercel.com');assert.equal(call.searchParams.has('teamId'),false);assert.equal(call.hash,'');}
});

test('Vercel domain listing follows pagination while preserving the team and every verification record',async()=>{
  const calls:URL[]=[];
  const pending={name:'pending.example.com',verified:false,verification:[{type:'TXT',domain:'_vercel.pending.example.com',value:'vc-domain-verify=pending.example.com,fixture'}]};
  const ready={name:'ready.example.com',verified:true};
  const client=new Vercel('fixture-domain-access',async input=>{
    const url=new URL(String(input));calls.push(url);
    const value=url.searchParams.has('until')?{domains:[ready]}:{domains:[pending],pagination:{next:12345}};
    return new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
  });
  assert.deepEqual(await client.projectDomains(vercelService('team_example')),[pending,ready]);assert.equal(calls.length,2);
  assert.equal(calls[0].searchParams.has('until'),false);assert.equal(calls[1].searchParams.get('until'),'12345');
  for(const call of calls){assert.equal(call.origin,'https://api.vercel.com');assert.equal(call.pathname,'/v9/projects/prj_example/domains');assert.equal(call.searchParams.get('teamId'),'team_example');assert.equal(call.searchParams.get('limit'),'100');}
});

test('Vercel domain listing bounds pagination and rejects malformed domain lists',async()=>{
  let calls=0;
  const client=new Vercel('fixture-domain-access',async()=>{calls++;return new Response(JSON.stringify({domains:[],pagination:{next:calls}}),{headers:{'content-type':'application/json'}});});
  await assert.rejects(client.projectDomains(vercelService()),/超过 1000/);assert.equal(calls,10);
  const malformed=new Vercel('fixture-domain-access',async()=>new Response(JSON.stringify({domains:{name:'bad.example.com'}}),{headers:{'content-type':'application/json'}}));
  await assert.rejects(malformed.projectDomains(vercelService()),/域名列表无效/);
});

test('Vercel domain configuration retains provider DNS recommendations and targets the service team',async()=>{
  let requested:URL|undefined;
  const configuration={misconfigured:true,recommendedCNAME:[{rank:1,value:'project.vercel-dns.example'}],recommendedIPv4:[{rank:1,value:['192.0.2.10']}],configuredBy:null};
  const client=new Vercel('fixture-domain-access',async input=>{requested=new URL(String(input));return new Response(JSON.stringify(configuration),{headers:{'content-type':'application/json'}});});
  assert.deepEqual(await client.domainConfig(vercelService('team_example'),'app.example.com'),configuration);
  assert.equal(requested?.origin,'https://api.vercel.com');assert.equal(requested?.pathname,'/v6/domains/app.example.com/config');
  assert.equal(requested?.searchParams.get('projectIdOrName'),'prj_example');assert.equal(requested?.searchParams.get('teamId'),'team_example');
});

test('a team-scoped Vercel connection lists only its team and fills missing project account IDs',async()=>{
  const calls:URL[]=[];
  const client=new Vercel('fixture-team-access',async input=>{
    const url=new URL(String(input));calls.push(url);assert.equal(url.pathname,'/v9/projects');assert.equal(url.searchParams.get('teamId'),'team_allowed');
    const result=url.searchParams.has('until')?{projects:[{id:'prj_second',name:'Second',accountId:'team_allowed'}]}:{projects:[{id:'prj_first',name:'First'}],pagination:{next:123}};
    return new Response(JSON.stringify(result),{headers:{'content-type':'application/json'}});
  },'team_allowed');
  const projects=await client.projects();
  assert.deepEqual(projects.map(project=>[project.id,project.accountId]),[['prj_first','team_allowed'],['prj_second','team_allowed']]);
  assert.equal(calls.length,2);assert.equal(calls[0].searchParams.has('until'),false);assert.equal(calls[1].searchParams.get('until'),'123');
  assert.equal(calls.some(url=>url.pathname==='/v2/teams'||!url.searchParams.has('teamId')),false);
});

test('a personal Vercel Integration lists only personal projects without enumerating teams or adding a team parameter',async()=>{
  const calls:URL[]=[];
  const client=new Vercel('fixture-personal-integration-access',async input=>{
    const url=new URL(String(input));calls.push(url);assert.equal(url.origin,'https://api.vercel.com');assert.equal(url.pathname,'/v9/projects');assert.equal(url.searchParams.has('teamId'),false);
    return new Response(JSON.stringify({projects:[{id:'prj_personal',name:'Personal website'}]}),{headers:{'content-type':'application/json'}});
  },'user_example');
  const projects=await client.projects();
  assert.equal(calls.length,1);assert.equal(calls[0].searchParams.get('limit'),'100');
  assert.deepEqual(projects.map(project=>[project.id,project.accountId]),[['prj_personal','user_example']]);
});

test('a team-scoped Vercel connection supplies its scope to domain methods and status for legacy services',async()=>{
  const calls:Array<{url:URL;method:string}>=[];
  const client=new Vercel('fixture-team-access',async(input,init)=>{
    const url=new URL(String(input)),method=init?.method??'GET';calls.push({url,method});
    assert.equal(url.searchParams.get('teamId'),'team_allowed');assert.equal(url.origin,'https://api.vercel.com');
    if(method==='DELETE')return new Response(null,{status:204});
    let body:unknown={name:'app.example.com',verified:true};
    if(url.pathname.endsWith('/config'))body={misconfigured:false};
    else if(url.pathname==='/v6/deployments')body={deployments:[]};
    else if(method==='GET'&&url.pathname.endsWith('/domains'))body={domains:[{name:'app.example.com',verified:true}]};
    else if(url.pathname==='/v9/projects/prj_example')body={targets:{production:{id:'production',readyState:'READY'}}};
    return new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
  },'team_allowed');
  const service=vercelService();
  assert.equal((await client.projectDomains(service)).length,1);await client.addDomain(service,'app.example.com');await client.verifyDomain(service,'app.example.com');await client.removeDomain(service,'app.example.com');await client.domainConfig(service,'app.example.com');
  assert.equal((await client.status(service)).ready,true);assert.equal(calls.length,8);
});

test('a team-scoped Vercel connection rejects every cross-scope domain and status request before sending credentials',async()=>{
  let calls=0;
  const client=new Vercel('fixture-team-access',async()=>{calls++;throw new Error('A cross-scope request must never be sent');},'team_allowed');
  for(const scope of ['team_other','account_personal']){
    const service=vercelService(scope);
    for(const operation of [()=>client.projectDomains(service),()=>client.addDomain(service,'app.example.com'),()=>client.verifyDomain(service,'app.example.com'),()=>client.removeDomain(service,'app.example.com'),()=>client.domainConfig(service,'app.example.com'),()=>client.status(service)]){
      await assert.rejects(async()=>operation(),error=>{assert.ok(error instanceof IntegrationError);assert.equal(error.status,403);assert.match(error.message,/不属于当前授权/);return true;});
    }
  }
  assert.equal(calls,0);
});

test('unrestricted Vercel connections paginate teams and projects, skip inaccessible scopes and deduplicate projects',async()=>{
  const calls:URL[]=[];
  const client=new Vercel('fixture-catalog-access',async input=>{
    const url=new URL(String(input));calls.push(url);let body:unknown;
    if(url.pathname==='/v2/teams')body=url.searchParams.has('until')?{teams:[{id:'team_second',slug:'second'}]}:{teams:[{id:'team_first',slug:'first'}],pagination:{next:100}};
    else{
      assert.equal(url.pathname,'/v9/projects');const scope=url.searchParams.get('teamId');
      if(!scope)return new Response(JSON.stringify({error:'Personal scope is unavailable'}),{status:403});
      if(scope==='team_first')body=url.searchParams.has('until')?{projects:[{id:'prj_first',name:'First'}]}:{projects:[{id:'prj_shared',name:'Shared'}],pagination:{next:200}};
      else{assert.equal(scope,'team_second');body={projects:[{id:'prj_shared',name:'Shared again'},{id:'prj_second',name:'Second',accountId:'team_second'}]};}
    }
    return new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
  });
  const result=await client.projects();
  assert.deepEqual(result.map(project=>[project.id,project.accountId,project.scopeSlug]),[['prj_shared','team_first','first'],['prj_first','team_first','first'],['prj_second','team_second','second']]);
  const teamCalls=calls.filter(url=>url.pathname==='/v2/teams'),projectCalls=calls.filter(url=>url.pathname==='/v9/projects');
  assert.equal(teamCalls.length,2);assert.equal(teamCalls[0].searchParams.has('until'),false);assert.equal(teamCalls[1].searchParams.get('until'),'100');
  assert.deepEqual(projectCalls.map(url=>[url.searchParams.get('teamId'),url.searchParams.get('until')]),[[null,null],['team_first',null],['team_first','200'],['team_second',null]]);
});

test('Vercel catalog discovery requires at least one accessible scope, while an accessible empty account is valid',async()=>{
  let projectCalls=0;
  const denied=new Vercel('fixture-catalog-access',async input=>{
    const url=new URL(String(input));
    if(url.pathname==='/v2/teams')return new Response(JSON.stringify({teams:[{id:'team_denied',slug:'denied'}]}));
    projectCalls++;return new Response(JSON.stringify({error:'denied'}),{status:403});
  });
  await assert.rejects(denied.projects(),error=>{assert.ok(error instanceof IntegrationError);assert.equal(error.status,403);assert.match(error.message,/无法访问任何工作空间/);return true;});assert.equal(projectCalls,2);
  const empty=new Vercel('fixture-catalog-access',async input=>new Response(JSON.stringify(new URL(String(input)).pathname==='/v2/teams'?{teams:[]}:{projects:[]})));
  assert.deepEqual(await empty.projects(),[]);
});

test('Vercel catalog discovery never hides expired credentials, non-permission failures, network errors or malformed responses',async()=>{
  for(const failure of ['unauthorized','not_found','server_error','network','bad_json','bad_projects','bad_teams'] as const){
    let projectCalls=0;
    const client=new Vercel('fixture-catalog-access',async input=>{
      const url=new URL(String(input));
      if(url.pathname==='/v2/teams')return new Response(JSON.stringify(failure==='bad_teams'?{teams:[{id:'team_first'}]}:{teams:[{id:'team_first',slug:'first'}]}));
      projectCalls++;
      if(failure==='network')throw new Error('Fixture network interruption');
      if(failure==='bad_json')return new Response('{invalid JSON');
      if(failure==='bad_projects')return new Response(JSON.stringify({projects:[{id:'prj_missing_name'}]}));
      return new Response(JSON.stringify({error:'fixture provider failure'}),{status:failure==='unauthorized'?401:failure==='not_found'?404:500});
    });
    await assert.rejects(client.projects(),`The ${failure} failure must not be treated as an inaccessible scope`);
    assert.equal(projectCalls,failure==='bad_teams'?0:1,'a failed request must not fall through to another scope');
  }
});

function githubRepository(id:number) {return {id,full_name:`example/repository-${id}`,name:`repository-${id}`,default_branch:'main',private:true};}

test('GitHub App repository discovery reads only installed repositories, paginates installations and repositories, and deduplicates IDs',async()=>{
  const calls:URL[]=[];
  const client=new GitHub('fixture-github-app-access',async(input,init)=>{
    const url=new URL(String(input));calls.push(url);assert.equal(url.origin,'https://api.github.com');assert.equal(init?.method??'GET','GET');assert.equal(init?.redirect,'error');
    assert.equal(new Headers(init?.headers).get('authorization'),'Bearer fixture-github-app-access');assert.equal(url.searchParams.get('per_page'),'100');
    const page=Number(url.searchParams.get('page'));let result:unknown;
    if(url.pathname==='/user/installations')result={installations:page===1?Array.from({length:100},(_,index)=>({id:index+1})):[{id:101}]};
    else{
      const match=/^\/user\/installations\/(\d+)\/repositories$/.exec(url.pathname);assert.ok(match,'GitHub App access must never request the general user repository endpoint');
      const installation=Number(match[1]);
      const repositories=installation===1?(page===1?Array.from({length:100},(_,index)=>githubRepository(index+1)):[githubRepository(1),githubRepository(101)]):installation===101?[githubRepository(101),githubRepository(102)]:[];
      result={repositories};
    }
    return new Response(JSON.stringify(result),{headers:{'content-type':'application/json'}});
  },'github-app');
  const result=await client.repositories();
  assert.equal(result.length,102);assert.equal(new Set(result.map(row=>row.id)).size,102);
  assert.deepEqual(result[0],{id:1,fullName:'example/repository-1',name:'repository-1',defaultBranch:'main',private:true});assert.equal(result.at(-1)?.id,102);
  assert.deepEqual(calls.filter(url=>url.pathname==='/user/installations').map(url=>url.searchParams.get('page')),['1','2']);
  assert.deepEqual(calls.filter(url=>url.pathname==='/user/installations/1/repositories').map(url=>url.searchParams.get('page')),['1','2']);
  assert.equal(calls.some(url=>url.pathname==='/user/repos'),false);
});

test('GitHub App repository discovery with no installations returns an empty catalog without requesting other repositories',async()=>{
  const calls:string[]=[];
  const client=new GitHub('fixture-github-app-access',async input=>{calls.push(String(input));return new Response(JSON.stringify({installations:[]}));},'github-app');
  assert.deepEqual(await client.repositories(),[]);assert.deepEqual(calls,['https://api.github.com/user/installations?per_page=100&page=1']);
});

test('GitHub App repository discovery rejects malformed installation and repository structures',async()=>{
  const malformedInstallations=[{}, {installations:{}}, {installations:[null]}, {installations:[{id:0}]}, {installations:[{id:-1}]}, {installations:[{id:'1'}]}, {installations:[{id:1.5}]}, {installations:[{id:Number.MAX_SAFE_INTEGER+1}]}];
  for(const result of malformedInstallations){
    let calls=0;const client=new GitHub('fixture-github-app-access',async()=>{calls++;return new Response(JSON.stringify(result));},'github-app');
    await assert.rejects(client.repositories(),/应用安装/);assert.equal(calls,1,'invalid installation IDs must not become request paths');
  }
  const invalidRows=[{}, {repositories:{}}, {repositories:[null]}, {repositories:[{id:1}]}, {repositories:[{...githubRepository(1),id:0}]}, {repositories:[{...githubRepository(1),id:'1'}]}, {repositories:[{...githubRepository(1),full_name:null}]}, {repositories:[{...githubRepository(1),name:42}]}, {repositories:[{...githubRepository(1),default_branch:null}]}, {repositories:[{...githubRepository(1),private:'true'}]}];
  for(const result of invalidRows){
    const client=new GitHub('fixture-github-app-access',async input=>new Response(JSON.stringify(new URL(String(input)).pathname==='/user/installations'?{installations:[{id:1}]}:result)),'github-app');
    await assert.rejects(client.repositories(),/仓库/);
  }
});

test('GitHub PAT repository discovery keeps its existing user repository path and pagination',async()=>{
  const calls:URL[]=[];
  const client=new GitHub('fixture-github-pat-access',async input=>{
    const url=new URL(String(input));calls.push(url);assert.equal(url.pathname,'/user/repos');assert.equal(url.searchParams.get('per_page'),'100');assert.equal(url.searchParams.get('sort'),'updated');assert.equal(url.searchParams.get('affiliation'),'owner,collaborator,organization_member');
    return new Response(JSON.stringify(url.searchParams.get('page')==='1'?Array.from({length:100},(_,index)=>githubRepository(index+1)):[githubRepository(101)]));
  });
  const repositories=await client.repositories();assert.equal(repositories.length,101);assert.equal(repositories[0].fullName,'example/repository-1');assert.equal(repositories[100].defaultBranch,'main');
  assert.deepEqual(calls.map(url=>url.searchParams.get('page')),['1','2']);assert.equal(calls.some(url=>url.pathname.startsWith('/user/installations')),false);
});
