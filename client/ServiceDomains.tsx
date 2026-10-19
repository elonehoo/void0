import { useCallback, useEffect, useState } from 'react';
import { Globe2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { DomainBinding, Service } from '../shared/types';
import { api, errorText, send } from './api';
import { BusyLabel, ErrorNotice, ExternalLink, Field, Loading, Notice } from './ui';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { Badge } from './components/ui/badge';
import IntegrationConnection from './IntegrationConnection';

interface DomainList { serviceId:string; supported:boolean; reason?:string; domains:DomainBinding[] }
const labels:Record<DomainBinding['status'],string> = {
  pending_dns:'等待解析', pending_https:'等待证书', ready:'可访问', error:'需要处理',
};

export default function ServiceDomains({ service, onChanged, vercelConnected=true }: {service:Service;onChanged:()=>Promise<unknown>;vercelConnected?:boolean}) {
  const [value,setValue]=useState<DomainList>();
  const [name,setName]=useState('');
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState('');
  const [error,setError]=useState('');
  const [remove,setRemove]=useState<string>();
  const [connecting,setConnecting]=useState(false);
  const load=useCallback(async()=>{
    const result=await api<DomainList>(`/services/${service.id}/domains`);
    setValue(result);
  },[service.id]);
  useEffect(()=>{
    if(service.kind==='vercel'&&!vercelConnected){setLoading(false);return;}
    let active=true;
    setLoading(true);setError('');setValue(undefined);
    api<DomainList>(`/services/${service.id}/domains`)
      .then(result=>{if(active)setValue(result);})
      .catch(error=>{if(active)setError(errorText(error));})
      .finally(()=>{if(active)setLoading(false);});
    return ()=>{active=false;};
  },[service.id,service.kind,vercelConnected]);
  async function act(key:string,operation:()=>Promise<unknown>) {
    setBusy(key);setError('');
    try {await operation();await load();await onChanged();}
    catch(error){setError(errorText(error));}
    finally{setBusy('');}
  }
  if(loading)return <Loading label="正在读取域名配置…"/>;
  if(service.kind==='vercel'&&!vercelConnected)return <section className="service-domains">
    <Notice>连接 Vercel 后即可管理此项目的自定义域名。</Notice>
    <Button variant="outline" size="sm" onClick={()=>setConnecting(true)}>连接 Vercel</Button>
    {connecting&&<IntegrationConnection provider="vercel" onClose={()=>setConnecting(false)} onConnected={onChanged}/>}
  </section>;
  return <section className="service-domains" aria-label="服务域名">
    <div className="domain-section-heading">
      <div><h3>访问域名</h3><p>将自己的域名连接到此服务，并查看解析与 HTTPS 状态。</p></div>
      <Button variant="ghost" size="icon" aria-label="刷新域名" disabled={!!busy} onClick={()=>act('refresh',async()=>{})}>
        <RefreshCw size={15} className={busy==='refresh'?'spin':''}/>
      </Button>
    </div>
    <ErrorNotice message={error}/>
    {value?.reason&&<Notice>{value.reason}</Notice>}
    {value?.supported&&<form className="domain-add-form" onSubmit={event=>{
      event.preventDefault();
      void act('add',async()=>{await send(`/services/${service.id}/domains`,'POST',{name:name.trim()});setName('');});
    }}>
      <Field label="域名" required hint="只填写域名，例如 app.example.com。">
        <Input required autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={253} value={name} onChange={event=>setName(event.target.value)} placeholder="app.example.com" disabled={!!busy}/>
      </Field>
      <Button type="submit" size="sm" disabled={!!busy||!name.trim()}><BusyLabel busy={busy==='add'}><Plus size={14}/>绑定域名</BusyLabel></Button>
    </form>}
    {value&&!value.domains.length&&<div className="small-empty"><Globe2 size={18}/><span>尚未绑定域名</span></div>}
    <div className="domain-list">
      {value?.domains.map(domain=><article className="domain-card" key={domain.name}>
        <div className="domain-card-heading">
          <strong>{domain.status==='ready'?<ExternalLink href={`https://${domain.name}`}>{domain.name}</ExternalLink>:domain.name}</strong>
          <Badge variant={domain.status==='ready'?'secondary':domain.status==='error'?'destructive':'outline'}>{labels[domain.status]}</Badge>
        </div>
        <p className="field-hint" role="status">{domain.message}</p>
        {!!domain.records.length&&<div className="domain-dns-records">
          <p>在域名服务商添加以下 DNS 记录，然后检查解析。</p>
          <table><thead><tr><th>类型</th><th>名称</th><th>值</th></tr></thead><tbody>
            {domain.records.map((record,index)=><tr key={`${record.type}-${index}`}><td>{record.type}</td><td><code>{record.name}</code></td><td><code>{record.value}</code></td></tr>)}
          </tbody></table>
        </div>}
        <div className="domain-actions">
          <Button type="button" variant="outline" size="sm" disabled={!!busy} onClick={()=>act(domain.name,()=>send(`/services/${service.id}/domains/${encodeURIComponent(domain.name)}/verify`,'POST'))}>
            <BusyLabel busy={busy===domain.name}><RefreshCw size={13}/>检查解析与证书</BusyLabel>
          </Button>
          {remove===domain.name?<>
            <span className="field-hint">移除此服务的域名绑定？</span>
            <Button type="button" variant="destructive" size="sm" disabled={!!busy} onClick={()=>act(`remove:${domain.name}`,async()=>{await send(`/services/${service.id}/domains/${encodeURIComponent(domain.name)}`,'DELETE');setRemove(undefined);})}><BusyLabel busy={busy===`remove:${domain.name}`}>确认移除</BusyLabel></Button>
            <Button type="button" variant="ghost" size="sm" disabled={!!busy} onClick={()=>setRemove(undefined)}>取消</Button>
          </>:<Button type="button" variant="ghost" size="sm" disabled={!!busy} onClick={()=>setRemove(domain.name)}><Trash2 size={13}/>移除</Button>}
        </div>
      </article>)}
    </div>
    {value?.supported&&<p className="field-hint">绑定会配置服务访问；域名的 DNS 记录需要在你的域名服务商处设置。移除绑定不会删除域名或 DNS 记录。</p>}
  </section>;
}
