import { createHmac, timingSafeEqual } from 'node:crypto';
import type { GitHubRepository, Service, ServiceStatus } from '../shared/types.js';

export class IntegrationError extends Error { constructor(message:string, public status=400) { super(message); } }
export function repositoryName(value:string):string {
  const match=/^(?:https:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(value);
  if(!match || match[1]==='.' || match[2]==='.' || match[1]==='..' || match[2]==='..') throw new IntegrationError('请填写有效的 GitHub 仓库地址。');
  return `${match[1]}/${match[2]}`;
}
export class GitHub {
  constructor(private token:string, private request:typeof fetch=fetch, private authorization?:'github-app') {}
  async api<T>(path:string, init:RequestInit={}):Promise<T> {
    if(!path.startsWith('/')||path.startsWith('//'))throw new IntegrationError('GitHub 请求地址无效。');
    const headers=new Headers(init.headers);headers.set('Accept','application/vnd.github+json');headers.set('Authorization',`Bearer ${this.token}`);headers.set('X-GitHub-Api-Version','2022-11-28');headers.set('User-Agent','void0');
    const response=await this.request(`https://api.github.com${path}`, { ...init,redirect:'error',signal:AbortSignal.timeout(20_000), headers});
    if(!response.ok) throw new IntegrationError(response.status===401 ? 'GitHub 登录已过期，请重新连接。' : response.status===403 ? 'GitHub 权限不足或请求过多，请检查授权。' : response.status===404 ? '未找到仓库或没有访问权限。' : 'GitHub 暂时无法完成请求。', response.status===401?401:400);
    if(response.status===204) return undefined as T;
    return await response.json() as T;
  }
  async user() { return this.api<{login:string}>('/user'); }
  async repositories():Promise<GitHubRepository[]> {
    if(this.authorization==='github-app')return this.installedRepositories();
    const output:GitHubRepository[]=[];
    for(let page=1;page<=5;page++) {
      const rows=await this.api<Array<{id:number;full_name:string;name:string;default_branch:string;private:boolean}>>(`/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member&page=${page}`);
      output.push(...rows.map(r=>({id:r.id,fullName:r.full_name,name:r.name,defaultBranch:r.default_branch,private:r.private})));
      if(rows.length<100) break;
    }
    return output;
  }
  private async installedRepositories():Promise<GitHubRepository[]> {
    const output:GitHubRepository[]=[];
    for(let page=1;page<=10;page++) {
      const result=await this.api<{installations:Array<{id:number}>}>(`/user/installations?per_page=100&page=${page}`);
      if(!Array.isArray(result.installations))throw new IntegrationError('GitHub 返回的应用安装列表无效。');
      for(const installation of result.installations) {
        if(!installation||!Number.isSafeInteger(installation.id)||installation.id<1)throw new IntegrationError('GitHub 应用安装标识无效。');
        for(let repositoryPage=1;repositoryPage<=10;repositoryPage++) {
          const rows=await this.api<{repositories:Array<{id:number;full_name:string;name:string;default_branch:string;private:boolean}>}>(`/user/installations/${installation.id}/repositories?per_page=100&page=${repositoryPage}`);
          if(!Array.isArray(rows.repositories))throw new IntegrationError('GitHub 返回的仓库列表无效。');
          for(const row of rows.repositories) {
            if(!row||!Number.isSafeInteger(row.id)||row.id<1||typeof row.full_name!=='string'||!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(row.full_name)||typeof row.name!=='string'||!row.name||row.name.length>100||typeof row.default_branch!=='string'||!row.default_branch||row.default_branch.length>255||typeof row.private!=='boolean')throw new IntegrationError('GitHub 返回的仓库资料无效。');
            if(!output.some(item=>item.id===row.id))output.push({id:row.id,fullName:row.full_name,name:row.name,defaultBranch:row.default_branch,private:row.private});
          }
          if(rows.repositories.length<100)break;
        }
      }
      if(result.installations.length<100)break;
    }
    return output;
  }
  async branches(repository:string):Promise<string[]> {
    const name=repositoryName(repository);
    const rows=await this.api<Array<{name:string}>>(`/repos/${name}/branches?per_page=100`);
    return rows.map(r=>r.name);
  }
  async commit(repository:string, branch:string):Promise<string> {
    const result=await this.api<{sha:string}>(`/repos/${repositoryName(repository)}/commits/${encodeURIComponent(branch)}`);
    if(!/^[0-9a-f]{40}$/.test(result.sha)) throw new IntegrationError('GitHub 未返回有效的代码版本。');
    return result.sha;
  }
  async dockerfile(repository:string,path:string,branch:string):Promise<void> {
    const result=await this.api<{type?:string;size?:number}>(`/repos/${repositoryName(repository)}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`);
    if(result.type!=='file') throw new IntegrationError('选定位置不是 Dockerfile 文件。');
  }
  async registerWebhook(repository:string,url:string,secret:string):Promise<void> {
    const path=`/repos/${repositoryName(repository)}/hooks`;
    const existing=await this.api<Array<{id:number;config:{url?:string}}>>(path+'?per_page=100');
    const mine=existing.find(hook=>hook.config.url===url);
    await this.api(path+(mine?`/${mine.id}`:''),{method:mine?'PATCH':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'web',active:true,events:['push'],config:{url,content_type:'json',secret,insecure_ssl:'0'}})});
  }
}
export function validWebhook(secret:string,signature:string|undefined,body:Buffer):boolean {
  if(!signature || !/^sha256=[0-9a-f]{64}$/.test(signature)) return false;
  const actual=Buffer.from(signature.slice(7),'hex');
  const expected=createHmac('sha256',secret).update(body).digest();
  return actual.length===expected.length && timingSafeEqual(actual,expected);
}
export class Vercel {
  constructor(private token:string,private request:typeof fetch=fetch,private defaultScopeId?:string) {}
  async api<T>(path:string,init:RequestInit={}):Promise<T> {
    if(!path.startsWith('/')||path.startsWith('//'))throw new IntegrationError('Vercel 请求地址无效。');
    const headers=new Headers(init.headers);if(init.body&&!headers.has('Content-Type'))headers.set('Content-Type','application/json');headers.set('Authorization',`Bearer ${this.token}`);
    const response=await this.request(`https://api.vercel.com${path}`,{...init,redirect:'error',signal:AbortSignal.timeout(20_000),headers});
    if(!response.ok) throw Object.assign(new IntegrationError(response.status===401?'Vercel 登录已过期，请重新连接。':response.status===409?'此域名已分配给其他 Vercel 项目，请在原项目解除绑定。':response.status===403?'Vercel 权限不足，请检查 Token 的工作空间和域名权限。':'Vercel 无法完成请求，请检查域名、登录和工作空间权限。',response.status===401?401:response.status===403?403:400),{outcomeKnown:response.status>=400&&response.status<500});
    if(response.status===204)return undefined as T;
    return await response.json() as T;
  }
  private projectPath(service:Service,path='',query:Record<string,string>={}):string {
    const id=service.target.vercelProjectId;if(!id)throw new IntegrationError('Vercel 项目标识不存在。');
    const scope=this.scope(service);if(scope?.startsWith('team_'))query.teamId=scope;
    const suffix=new URLSearchParams(query).toString();return `/v9/projects/${encodeURIComponent(id)}${path}${suffix?'?'+suffix:''}`;
  }
  private scope(service:Service):string|undefined {
    if(this.defaultScopeId&&service.target.vercelScopeId&&service.target.vercelScopeId!==this.defaultScopeId)throw new IntegrationError('此 Vercel 服务不属于当前授权的工作空间，请重新连接对应工作空间。',403);
    return service.target.vercelScopeId??this.defaultScopeId;
  }
  async projectDomains(service:Service):Promise<VercelDomain[]> {
    const all:VercelDomain[]=[];let until:string|undefined;
    for(let page=0;page<10;page++) {
      const value=await this.api<{domains:VercelDomain[];pagination?:{next?:number}}>(this.projectPath(service,'/domains',{limit:'100',...(until?{until}:{})}));
      if(!Array.isArray(value.domains)||value.domains.some(row=>!row||typeof row.name!=='string'||row.name.length>253||typeof row.verified!=='boolean'))throw new IntegrationError('Vercel 返回的域名列表无效。');
      all.push(...value.domains);if(!value.pagination?.next)break;until=String(value.pagination.next);
      if(page===9)throw new IntegrationError('Vercel 项目域名超过 1000 个，请在 Vercel 管理此项目。');
    }
    return all;
  }
  addDomain(service:Service,name:string):Promise<VercelDomain> {
    return this.api(this.projectPath(service,'/domains').replace('/v9/','/v10/'),{method:'POST',body:JSON.stringify({name})});
  }
  verifyDomain(service:Service,name:string):Promise<VercelDomain> {
    return this.api(this.projectPath(service,`/domains/${encodeURIComponent(name)}/verify`),{method:'POST'});
  }
  async removeDomain(service:Service,name:string):Promise<void> {
    await this.api(this.projectPath(service,`/domains/${encodeURIComponent(name)}`),{method:'DELETE'});
  }
  domainConfig(service:Service,name:string):Promise<VercelDomainConfiguration> {
    const query=new URLSearchParams({projectIdOrName:service.target.vercelProjectId??''});
    const scope=this.scope(service);if(scope?.startsWith('team_'))query.set('teamId',scope);
    return this.api(`/v6/domains/${encodeURIComponent(name)}/config?${query}`);
  }
  async projects() {
    const teams:{id:string;slug:string}[]=[];let teamUntil:string|undefined;
    for(let page=0;!this.defaultScopeId&&page<10;page++) {
      const query=new URLSearchParams({limit:'100',...(teamUntil?{until:teamUntil}:{})});
      const result=await this.api<{teams:Array<{id:string;slug:string}>;pagination?:{next?:number}}>(`/v2/teams?${query}`);
      if(!Array.isArray(result.teams)||result.teams.some(team=>!team||typeof team.id!=='string'||typeof team.slug!=='string'))throw new IntegrationError('Vercel 返回的工作空间列表无效。');
      teams.push(...result.teams);if(!result.pagination?.next)break;teamUntil=String(result.pagination.next);
      if(page===9)throw new IntegrationError('Vercel 工作空间超过 1000 个，请使用仅授权所需工作空间的 Token。');
    }
    const all:Array<{id:string;name:string;accountId?:string;scopeSlug?:string;framework?:string}>=[];
    let accessible=0;
    for(const team of this.defaultScopeId?[{id:this.defaultScopeId,slug:''}]:[{id:'',slug:''},...teams]) {
      let until:string|undefined;
      try {for(let page=0;page<10;page++) {
        const query=new URLSearchParams({limit:'100'}); if(team.id.startsWith('team_')) query.set('teamId',team.id); if(until) query.set('until',until);
        const result=await this.api<{projects:Array<{id:string;name:string;accountId?:string;framework?:string}>;pagination?:{next?:number}}>(`/v9/projects?${query}`);
        if(!Array.isArray(result.projects)||result.projects.some(project=>!project||typeof project.id!=='string'||typeof project.name!=='string'))throw new IntegrationError('Vercel 返回的项目列表无效。');
        accessible++;
        for(const p of result.projects) if(!all.some(x=>x.id===p.id)) all.push({...p,accountId:p.accountId??(team.id||undefined),scopeSlug:team.slug||undefined});
        if(!result.pagination?.next) break; until=String(result.pagination.next);
        if(page===9)throw new IntegrationError('此 Vercel 工作空间的项目超过 1000 个，请缩小 Token 授权范围。');
      }}catch(error){if(!(error instanceof IntegrationError&&error.status===403))throw error;}
    }
    if(!accessible)throw new IntegrationError('Vercel Token 无法访问任何工作空间，请检查授权范围。',403);
    return all;
  }
  async status(service:Service):Promise<ServiceStatus> {
    const id=service.target.vercelProjectId; if(!id) throw new IntegrationError('Vercel 项目标识不存在。');
    const query=new URLSearchParams({projectId:id,limit:'10'}); const scope=this.scope(service);
    if(scope?.startsWith('team_')) query.set('teamId',scope);
    const scopeQuery=scope?.startsWith('team_')?`?teamId=${encodeURIComponent(scope)}`:'';
    const [project,result,domains]=await Promise.all([
      this.api<{targets?:{production?:{id:string;readyState:string;url?:string;createdAt?:number}}}>(`/v9/projects/${encodeURIComponent(id)}${scopeQuery}`),
      this.api<{deployments:Array<{uid:string;state:string;url?:string;created?:number}>}>(`/v6/deployments?${query}`),
      this.api<{domains:Array<{name:string}>}>(`/v9/projects/${encodeURIComponent(id)}/domains${scopeQuery}`)
    ]);
    const production=project.targets?.production;
    return {serviceId:service.id,state:production?.readyState==='READY'?'running':'unknown',ready:production?.readyState==='READY',message:production?.readyState==='READY'?'正式版本已就绪':'尚未确认正式版本',checkedAt:new Date().toISOString(),image:undefined,url:domains.domains[0]?`https://${domains.domains[0].name}`:production?.url?`https://${production.url}`:undefined,domains:domains.domains.map(d=>d.name),deployments:result.deployments.map(d=>({id:d.uid,state:d.state,url:d.url?`https://${d.url}`:undefined,createdAt:d.created?new Date(d.created).toISOString():undefined}))};
  }
}
export interface VercelDomain { name:string;verified:boolean;verification?:Array<{type:string;domain:string;value:string}>;redirect?:string;gitBranch?:string }
export interface VercelDomainConfiguration { misconfigured:boolean;recommendedCNAME?:Array<{rank:number;value:string}>;recommendedIPv4?:Array<{rank:number;value:string[]}>;configuredBy?:string|null }
