import { createHmac, timingSafeEqual } from 'node:crypto';
import type { GitHubRepository, Service, ServiceStatus } from '../shared/types.js';

export class IntegrationError extends Error { constructor(message:string, public status=400) { super(message); } }
export function repositoryName(value:string):string {
  const match=/^(?:https:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(value);
  if(!match || match[1]==='.' || match[2]==='.' || match[1]==='..' || match[2]==='..') throw new IntegrationError('请填写有效的 GitHub 仓库地址。');
  return `${match[1]}/${match[2]}`;
}
export class GitHub {
  constructor(private token:string, private request:typeof fetch=fetch) {}
  async api<T>(path:string, init:RequestInit={}):Promise<T> {
    const response=await this.request(`https://api.github.com${path}`, { ...init,redirect:'error',signal:AbortSignal.timeout(20_000), headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${this.token}`,'X-GitHub-Api-Version':'2022-11-28','User-Agent':'void0',...(init.headers??{})}});
    if(!response.ok) throw new IntegrationError(response.status===401 ? 'GitHub 登录已过期，请重新连接。' : response.status===403 ? 'GitHub 权限不足或请求过多，请检查授权。' : response.status===404 ? '未找到仓库或没有访问权限。' : 'GitHub 暂时无法完成请求。', response.status===401?401:400);
    if(response.status===204) return undefined as T;
    return await response.json() as T;
  }
  async user() { return this.api<{login:string}>('/user'); }
  async repositories():Promise<GitHubRepository[]> {
    const output:GitHubRepository[]=[];
    for(let page=1;page<=5;page++) {
      const rows=await this.api<Array<{id:number;full_name:string;name:string;default_branch:string;private:boolean}>>(`/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member&page=${page}`);
      output.push(...rows.map(r=>({id:r.id,fullName:r.full_name,name:r.name,defaultBranch:r.default_branch,private:r.private})));
      if(rows.length<100) break;
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
  constructor(private token:string,private request:typeof fetch=fetch) {}
  async api<T>(path:string):Promise<T> {
    const response=await this.request(`https://api.vercel.com${path}`,{redirect:'error',signal:AbortSignal.timeout(20_000),headers:{Authorization:`Bearer ${this.token}`}});
    if(!response.ok) throw new IntegrationError(response.status===401?'Vercel 登录已过期，请重新连接。':'Vercel 无法完成请求，请检查登录和工作空间权限。');
    return await response.json() as T;
  }
  async projects() {
    const teams=await this.api<{teams:Array<{id:string;slug:string}>}>('/v2/teams?limit=100');
    const all:Array<{id:string;name:string;accountId?:string;scopeSlug?:string;framework?:string}>=[];
    for(const team of [{id:'',slug:''},...teams.teams]) {
      let until:string|undefined;
      for(let page=0;page<10;page++) {
        const query=new URLSearchParams({limit:'100'}); if(team.id) query.set('teamId',team.id); if(until) query.set('until',until);
        const result=await this.api<{projects:Array<{id:string;name:string;accountId?:string;framework?:string}>;pagination?:{next?:number}}>(`/v9/projects?${query}`);
        for(const p of result.projects) if(!all.some(x=>x.id===p.id)) all.push({...p,scopeSlug:team.slug||undefined});
        if(!result.pagination?.next) break; until=String(result.pagination.next);
      }
    }
    return all;
  }
  async status(service:Service):Promise<ServiceStatus> {
    const id=service.target.vercelProjectId; if(!id) throw new IntegrationError('Vercel 项目标识不存在。');
    const query=new URLSearchParams({projectId:id,limit:'10'}); const scope=service.target.vercelScopeId;
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
