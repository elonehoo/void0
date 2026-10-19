import {useEffect,useState} from 'react';
import type {Project,Server,Service,WorkspaceSnapshot} from '../shared/types';
import {api,errorText,send} from './api';
import {BusyLabel,ErrorNotice,Field,Loading,Modal,Notice} from './ui';
import {Button} from './components/ui/button';
import {Input} from './components/ui/input';
import {Checkbox} from './components/ui/checkbox';
import {Switch} from './components/ui/switch';

export interface ServiceEditorProps {service?:Service;project:Project;snapshot:WorkspaceSnapshot;onClose:()=>void;onSaved:()=>Promise<void>;onConnectionsChanged?:()=>Promise<unknown>}
export default function PublisherServiceEditor({service,project,snapshot,onClose,onSaved}:ServiceEditorProps) {
  const [catalog,setCatalog]=useState<Array<{service:Service;server:Server}>>([]),[selected,setSelected]=useState<string[]>([]);
  const [name,setName]=useState(service?.name??''),[automatic,setAutomatic]=useState(service?.autoDeploy??false);
  const [loading,setLoading]=useState(!service),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{
    if(service)return;
    let active=true;
    api<{services:Array<{service:Service;server:Server}>}>('/publisher/services').then(result=>{if(active)setCatalog(result.services);}).catch(error=>{if(active)setError(errorText(error));}).finally(()=>{if(active)setLoading(false);});
    return ()=>{active=false;};
  },[service]);
  return <Modal title={service?'配置服务':'添加获准服务'} subtitle={project.name} onClose={onClose} wide>
    <form onSubmit={async event=>{
      event.preventDefault();setBusy(true);setError('');
      try{
        if(service)await send('/services/'+service.id,'PUT',{name,autoDeploy:automatic});
        else await send('/publisher/import','POST',{projectId:project.id,serviceIds:selected});
        await onSaved();
      }catch(error){setError(errorText(error));}finally{setBusy(false);}
    }}>
      <div className="modal-body">
        <Notice>源码、镜像仓库、端口和存储由独立发布器配置，并由服务器本地规则核对。这里可以管理项目归属、显示名称和自动发布开关。</Notice>
        {service?<>
          <Field label="显示名称" required><Input required maxLength={80} value={name} onChange={event=>setName(event.target.value)}/></Field>
          <dl className="agent-summary">
            <div><dt>代码仓库</dt><dd>{service.repository??'由发布器配置'}</dd></div>
            <div><dt>分支</dt><dd>{service.branch??'由发布器配置'}</dd></div>
            <div><dt>服务 ID</dt><dd>{service.id}</dd></div>
          </dl>
          <div className="switch-field"><div><strong>代码更新后自动发布</strong><p className="field-hint">无需保持浏览器开启；发布器获取新代码并构建，服务器校验后更新。</p></div><Switch aria-label="代码更新后自动发布" checked={automatic} onCheckedChange={setAutomatic}/></div>
        </>:loading?<Loading label="正在读取发布器允许管理的服务…"/>:catalog.length?<div className="resource-list">
          {catalog.map(item=>{
            const connected=snapshot.servers.some(server=>server.id===item.server.id&&server.connectionMode==='agent');
            return <label className="integration-card" key={item.service.id}>
              <Checkbox checked={selected.includes(item.service.id)} disabled={!connected||busy} onCheckedChange={checked=>setSelected(previous=>checked===true?[...previous,item.service.id]:previous.filter(id=>id!==item.service.id))}/>
              <div className="integration-info"><strong>{item.service.name}</strong><p>{item.service.repository} · {item.server.name}</p><p className="field-hint">{connected?'添加后可手动发布，自动发布默认关闭。':'对应服务器尚未接入，请核对服务器 ID 并安装 void0 OS。'}</p></div>
            </label>;
          })}
        </div>:<Notice>独立发布器尚未配置服务，请在发布器的配置文件或 GitHub 配置仓库中添加。</Notice>}
        <ErrorNotice message={error}/>
      </div>
      <div className="modal-footer"><span className="field-hint">密钥和服务器规则不在这里修改。</span><div><Button type="button" variant="outline" onClick={onClose}>取消</Button><Button disabled={busy||loading||(!service&&!selected.length)}><BusyLabel busy={busy}>{service?'保存设置':'添加到项目'}</BusyLabel></Button></div></div>
    </form>
  </Modal>;
}
