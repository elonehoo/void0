import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Store } from './store.js';

export type AgentOperation = 'probe' | 'bootstrap' | 'submit' | 'status' | 'kubernetes-action';
export interface AgentCommand { id:string; operation:AgentOperation; payload:unknown }
export interface AgentDeploymentProtection { mode:'compatibility'|'strict';policyVersion?:number }
export interface AgentInfo { configured:boolean; online:boolean; lastSeen?:string; hostname?:string; version?:string; pending:number; pairingPending?:boolean;deploymentProtection:AgentDeploymentProtection }
export interface AgentResult { ok:boolean; value?:unknown; error?:string; outcomeKnown?:boolean }
export class AgentCommandError extends Error {
  constructor(message:string,readonly outcomeKnown:boolean) { super(message);this.name='AgentCommandError'; }
}

type CommandState = 'queued' | 'claimed' | 'acknowledged' | 'succeeded' | 'failed' | 'unknown' | 'cancelled';
interface CommandRecord {
  id:string; serverId:string; generation:string; operation:AgentOperation; state:CommandState;
  createdAt:number; expiresAt:number; claimedAt?:number; acknowledgedAt?:number; finishedAt?:number;
  outcomeKnown?:boolean;
}
interface AgentRecord {
  deploymentProtection?:AgentDeploymentProtection;
  tokenHash?:string; generation?:string; pairingHash?:string; lastSeen?:number; hostname?:string; version?:string;
}
interface PairingRecord { serverId:string; expiresAt:number; consumed:boolean }
interface TokenRecord { serverId:string; generation:string }
interface AuditRecord { id:string; operation:AgentOperation; state:CommandState; time:string }
interface ControllerOptions { now?:()=>number; waitIntervalMs?:number }

const operations = new Set<AgentOperation>(['probe','bootstrap','submit','status','kubernetes-action']);
const pendingStates = new Set<CommandState>(['queued','claimed','acknowledged']);
const onlineWindowMs=45_000;
const pairingWindowMs=15*60_000;
const maximumMessageBytes=30*1024*1024;
const retainedCommands=64;
const maximumPendingCommands=32;
const stateKey=(serverId:string)=>`agent:server:${serverId}`;
const indexKey=(serverId:string)=>`agent:commands:${serverId}`;
const commandKey=(id:string)=>`agent:command:${id}`;
const payloadKey=(id:string)=>`agent:payload:${id}`;
const resultKey=(id:string)=>`agent:result:${id}`;
function hash(value:string):string { return createHash('sha256').update(value).digest('hex'); }
function equalHash(a:string|undefined,b:string):boolean { return !!a && a.length===b.length && timingSafeEqual(Buffer.from(a),Buffer.from(b)); }
function printable(value:unknown,maximum:number):value is string { return typeof value==='string' && value.length>0 && value.length<=maximum && !/[\u0000-\u001f\u007f]/.test(value); }
function jsonCopy<T>(value:T):T {
  let encoded:string|undefined;
  try { encoded=JSON.stringify(value); } catch { throw new AgentCommandError('服务器指令内容无效',true); }
  if (encoded===undefined || Buffer.byteLength(encoded)>maximumMessageBytes) throw new AgentCommandError('服务器指令内容无效或过大',true);
  return JSON.parse(encoded) as T;
}

/** Durable, single-delivery command handoff. Only encrypted Vault entries contain command data. */
export class AgentController {
  private readonly now:()=>number;
  private readonly waitIntervalMs:number;
  private closed=false;
  private readonly initialization:Promise<void>;
  private readonly closedOutcomes=new Map<string,boolean>();
  private readonly waitingCommands=new Set<string>();

  constructor(private readonly store:Store,options:ControllerOptions={}) {
    this.now=options.now??Date.now;
    this.waitIntervalMs=options.waitIntervalMs??50;
    this.initialization=this.recover();
  }

  ready():Promise<void> { return this.initialization; }
  private async recover():Promise<void> {
    await this.store.ready();
    // A previous controller may have died before or after the agent received a response.
    // Neither case permits replay: an accepted command must be reviewed, never resent.
    (await this.store.transaction(async ()=>{
      for (const server of (await this.store.allServers())) {
        for (const record of (await this.records(server.id))) if (pendingStates.has(record.state)) {
          (await this.finish(record,record.state==='queued'?'cancelled':'unknown',record.state==='queued'));
        }
      }
    }));
  }

  async createPairing(serverId:string):Promise<{pairingToken:string;expiresAt:string}> {
    await this.ready();this.assertOpen();(await this.server(serverId));(await this.allowConnectionChange(serverId));
    const pairingToken=`sd_pair_${randomBytes(32).toString('base64url')}`;
    const pairingHash=hash(pairingToken),expiresAt=this.now()+pairingWindowMs;
    (await this.store.transaction(async ()=>{
      this.assertOpen();await this.allowConnectionChange(serverId);
      const agent=(await this.agent(serverId));
      if (agent.pairingHash) (await this.store.setSetting(`agent:pairing:${agent.pairingHash}`,null));
      (await this.store.setSetting<PairingRecord>(`agent:pairing:${pairingHash}`,{serverId,expiresAt,consumed:false}));
      (await this.store.setSetting<AgentRecord>(stateKey(serverId),{...agent,pairingHash}));
    }));
    return {pairingToken,expiresAt:new Date(expiresAt).toISOString()};
  }

  async register(input:{pairingToken:string;hostname:string;version:string}):Promise<{serverId:string;token:string;pollIntervalSeconds:2}> {
    await this.ready();this.assertOpen();this.metadata(input);
    if (!printable(input.pairingToken,128)) throw new AgentCommandError('服务器绑定码无效或已过期',true);
    const pairingHash=hash(input.pairingToken),token=`sd_agent_${randomBytes(32).toString('base64url')}`;
    return (await this.store.transaction(async ()=>{
      this.assertOpen();
      const pairing=(await this.store.getSetting<PairingRecord|null>(`agent:pairing:${pairingHash}`));
      if (!pairing || pairing.consumed || pairing.expiresAt<=this.now() || !(await this.store.getServer(pairing.serverId))) throw new AgentCommandError('服务器绑定码无效或已过期',true);
      (await this.allowConnectionChange(pairing.serverId));
      const agent=(await this.agent(pairing.serverId));
      if (!equalHash(agent.pairingHash,pairingHash)) throw new AgentCommandError('服务器绑定码无效或已过期',true);
      (await this.invalidateCommands(pairing.serverId));
      if (agent.tokenHash) (await this.store.setSetting(`agent:token:${agent.tokenHash}`,null));
      const generation=randomUUID(),tokenHash=hash(token);
      (await this.store.setSetting<PairingRecord>(`agent:pairing:${pairingHash}`,{...pairing,consumed:true}));
      (await this.store.setSetting<AgentRecord>(stateKey(pairing.serverId),{tokenHash,generation,lastSeen:this.now(),hostname:input.hostname,version:input.version}));
      (await this.store.setSetting<TokenRecord>(`agent:token:${tokenHash}`,{serverId:pairing.serverId,generation}));
      return {serverId:pairing.serverId,token,pollIntervalSeconds:2};
    }));
  }

  async authenticate(token:string):Promise<string> {
    await this.ready();this.assertOpen();
    if (!printable(token,128)) throw new AgentCommandError('服务器身份验证失败',true);
    const tokenHash=hash(token),identity=(await this.store.getSetting<TokenRecord|null>(`agent:token:${tokenHash}`));
    if (!identity || !(await this.store.getServer(identity.serverId))) throw new AgentCommandError('服务器身份验证失败',true);
    const agent=(await this.agent(identity.serverId));
    if (!equalHash(agent.tokenHash,tokenHash) || identity.generation!==agent.generation) throw new AgentCommandError('服务器身份验证失败',true);
    return identity.serverId;
  }

  async poll(serverId:string,metadata:{hostname:string;version:string;busy?:boolean;deploymentProtection?:AgentDeploymentProtection}):Promise<{command:AgentCommand|null}> {
    await this.ready();this.assertOpen();this.metadata(metadata);
    if (metadata.busy!==undefined && typeof metadata.busy!=='boolean') throw new AgentCommandError('服务器资料无效',true);
    return (await this.store.transaction(async ()=>{
      this.assertOpen();
      const agent=(await this.connectedAgent(serverId));
      (await this.store.setSetting<AgentRecord>(stateKey(serverId),{...agent,hostname:metadata.hostname,version:metadata.version,lastSeen:this.now(),deploymentProtection:metadata.deploymentProtection??{mode:'compatibility'}}));
      if (metadata.busy) return {command:null};
      const records=(await this.records(serverId));
      for (const record of records) if (pendingStates.has(record.state) && record.expiresAt<=this.now()) (await this.expire(record));
      // The agent executes one operation at a time. Claimed work is never returned a second time.
      if (records.some(record=>(record.state==='claimed' || record.state==='acknowledged') && record.expiresAt>this.now())) return {command:null};
      const record=records.find(item=>item.state==='queued' && item.expiresAt>this.now() && item.generation===agent.generation);
      if (!record) return {command:null};
      const payload=(await this.store.vault.get<unknown>(payloadKey(record.id)));
      if (payload===undefined) { (await this.finish(record,'cancelled',true));return {command:null}; }
      record.state='claimed';record.claimedAt=this.now();(await this.write(record));
      return {command:{id:record.id,operation:record.operation,payload}};
    }));
  }

  async acknowledge(serverId:string,commandId:string):Promise<void> {
    await this.ready();this.assertOpen();
    (await this.store.transaction(async ()=>{
      this.assertOpen();
      const record=(await this.ownedCommand(serverId,commandId));
      if (record.expiresAt<=this.now() && pendingStates.has(record.state)) (await this.expire(record));
      if (record.state==='acknowledged' || (record.acknowledgedAt!==undefined && !pendingStates.has(record.state))) return;
      if (record.state!=='claimed') throw new AgentCommandError('服务器指令不可确认',true);
      record.state='acknowledged';record.acknowledgedAt=this.now();(await this.write(record));(await this.seen(serverId));
    }));
  }

  async result(serverId:string,commandId:string,input:AgentResult):Promise<void> {
    await this.ready();this.assertOpen();
    if (!input || typeof input.ok!=='boolean' || (input.error!==undefined && typeof input.error!=='string') || (input.outcomeKnown!==undefined && typeof input.outcomeKnown!=='boolean')) throw new AgentCommandError('服务器返回格式无效',true);
    const value=jsonCopy(input);
    (await this.store.transaction(async ()=>{
      this.assertOpen();
      const record=(await this.ownedCommand(serverId,commandId));
      if (record.expiresAt<=this.now() && pendingStates.has(record.state)) (await this.expire(record));
      if (!pendingStates.has(record.state)) {
        const previous=(await this.store.vault.get<AgentResult>(resultKey(record.id)));
        if (previous && isDeepStrictEqual(previous,value)) { (await this.seen(serverId));return; }
      }
      if (record.state!=='acknowledged') throw new AgentCommandError('服务器指令结果不可重复提交',true);
      (await this.store.vault.set(resultKey(record.id),value));
      (await this.finish(record,value.ok?'succeeded':(value.outcomeKnown===true?'failed':'unknown'),value.ok||value.outcomeKnown===true));
      (await this.seen(serverId));
    }));
  }

  async command<T=unknown>(serverId:string,operation:AgentOperation,payload:unknown,timeoutMs=120_000):Promise<T> {
    await this.ready();this.assertOpen();(await this.server(serverId));
    if (!operations.has(operation) || !Number.isSafeInteger(timeoutMs) || timeoutMs<1 || timeoutMs>3_600_000) throw new AgentCommandError('服务器指令配置无效',true);
    const body=jsonCopy(payload),agent=(await this.connectedAgent(serverId));
    if (!this.isOnline(agent)) throw new AgentCommandError('服务器上的 void0 OS 尚未连接',true);
    const id=randomUUID(),createdAt=this.now();
    const record:CommandRecord={id,serverId,generation:agent.generation!,operation,state:'queued',createdAt,expiresAt:createdAt+timeoutMs};
    (await this.store.transaction(async ()=>{
      this.assertOpen();
      const currentAgent=await this.connectedAgent(serverId);
      if(currentAgent.generation!==record.generation || !this.isOnline(currentAgent))throw new AgentCommandError('服务器上的 void0 OS 连接已变化',true);
      const ids=(await this.store.getSetting<string[]>(indexKey(serverId)))??[];
      if ((await this.records(serverId)).filter(item=>pendingStates.has(item.state)).length>=maximumPendingCommands) throw new AgentCommandError('服务器等待指令过多',true);
      (await this.store.vault.set(payloadKey(id),body));(await this.write(record));(await this.store.setSetting(indexKey(serverId),[...ids,id]));(await this.prune(serverId));
    }));
    this.waitingCommands.add(id);
    try {
      while (true) {
        if (this.closed) throw new AgentCommandError('void0 已停止，服务器指令未重新派发',this.closedOutcomes.get(id)??false);
        const current=(await this.store.getSetting<CommandRecord|null>(commandKey(id)));
        if (!current) throw new AgentCommandError('服务器指令记录不可用',false);
        if (pendingStates.has(current.state) && current.expiresAt<=this.now()) {
          await this.store.transaction(async ()=>{
            const fresh=await this.store.getSetting<CommandRecord|null>(commandKey(id));
            if(fresh && pendingStates.has(fresh.state) && fresh.expiresAt<=this.now())await this.expire(fresh);
          });
          continue;
        }
        if (current.state==='succeeded') return (await this.store.vault.get<AgentResult>(resultKey(id)))?.value as T;
        if (current.state==='failed') throw new AgentCommandError('服务器指令执行失败',true);
        if (current.state==='unknown') throw new AgentCommandError('服务器指令结果未知，未自动重发',false);
        if (current.state==='cancelled') throw new AgentCommandError('服务器指令尚未执行，已取消',true);
        await new Promise<void>(resolve=>setTimeout(resolve,this.waitIntervalMs));
      }
    } finally { this.waitingCommands.delete(id);this.closedOutcomes.delete(id); }
  }

  async info(serverId:string):Promise<AgentInfo> {
    await this.ready();this.assertOpen();(await this.server(serverId));
    const agent=(await this.agent(serverId));
    const pairing=agent.pairingHash?(await this.store.getSetting<PairingRecord|null>(`agent:pairing:${agent.pairingHash}`)):undefined;
    return {
      configured:!!agent.tokenHash,online:this.isOnline(agent),deploymentProtection:agent.deploymentProtection??{mode:'compatibility'},
      ...(agent.lastSeen===undefined?{}:{lastSeen:new Date(agent.lastSeen).toISOString()}),
      ...(agent.hostname?{hostname:agent.hostname}:{}),...(agent.version?{version:agent.version}:{}),
      pending:(await this.records(serverId)).filter(record=>pendingStates.has(record.state)).length,
      pairingPending:!!pairing && !pairing.consumed && pairing.expiresAt>this.now(),
    };
  }

  async revoke(serverId:string):Promise<void> {
    await this.ready();this.assertOpen();(await this.server(serverId));(await this.allowConnectionChange(serverId));
    (await this.store.transaction(async ()=>{
      this.assertOpen();await this.allowConnectionChange(serverId);
      const agent=(await this.agent(serverId));
      if (agent.tokenHash) (await this.store.setSetting(`agent:token:${agent.tokenHash}`,null));
      if (agent.pairingHash) (await this.store.setSetting(`agent:pairing:${agent.pairingHash}`,null));
      (await this.invalidateCommands(serverId));
      (await this.store.setSetting<AgentRecord>(stateKey(serverId),{}));
    }));
  }

  async close():Promise<void> {
    await this.ready();
    if (this.closed) return;
    (await this.store.transaction(async ()=>{
      for (const server of (await this.store.allServers())) for (const record of (await this.records(server.id))) if (pendingStates.has(record.state)) {
        this.closedOutcomes.set(record.id,record.state==='queued');
        (await this.finish(record,record.state==='queued'?'cancelled':'unknown',record.state==='queued'));
      }
      this.closed=true;
    }));
  }
  private assertOpen():void { if (this.closed) throw new AgentCommandError('void0 已停止',true); }
  private async server(serverId:string):Promise<void> { if (!(await this.store.getServer(serverId))) throw new AgentCommandError('服务器不存在',true); }
  private async allowConnectionChange(serverId:string):Promise<void> { if ((await this.store.allJobs()).some(job=>job.serverId===serverId && ['queued','running','unknown'].includes(job.state))) throw new AgentCommandError('服务器还有未结束的任务，不能更换 void0 OS 连接',true); }
  private async agent(serverId:string):Promise<AgentRecord> { return (await this.store.getSetting<AgentRecord>(stateKey(serverId)))??{}; }
  private async connectedAgent(serverId:string):Promise<AgentRecord> {
    (await this.server(serverId));const agent=(await this.agent(serverId));
    if (!agent.tokenHash || !agent.generation) throw new AgentCommandError('服务器上的 void0 OS 尚未绑定',true);
    return agent;
  }
  private metadata(value:{hostname:string;version:string;deploymentProtection?:AgentDeploymentProtection}):void {
    if(!value || !printable(value.hostname,253) || !printable(value.version,80))throw new AgentCommandError('服务器资料无效',true);
    const protection=value.deploymentProtection;
    if(protection!==undefined && (!protection || typeof protection!=='object' || Array.isArray(protection) || !['compatibility','strict'].includes(protection.mode) || (protection.policyVersion!==undefined && (!Number.isSafeInteger(protection.policyVersion) || protection.policyVersion<1)) || Object.keys(protection).some(key=>!['mode','policyVersion'].includes(key))))throw new AgentCommandError('服务器发布保护资料无效',true);
  }
  private isOnline(agent:AgentRecord):boolean { return !!agent.tokenHash && agent.lastSeen!==undefined && this.now()-agent.lastSeen<=onlineWindowMs && this.now()>=agent.lastSeen; }
  private async records(serverId:string):Promise<CommandRecord[]> {
    const ids=await this.store.getSetting<string[]>(indexKey(serverId))??[];
    const records=await Promise.all(ids.map(id=>this.store.getSetting<CommandRecord|null>(commandKey(id))));
    return records.filter((record):record is CommandRecord=>!!record);
  }
  private async ownedCommand(serverId:string,commandId:string):Promise<CommandRecord> {
    const agent=(await this.connectedAgent(serverId));
    if (typeof commandId!=='string' || !/^[0-9a-f-]{36}$/.test(commandId)) throw new AgentCommandError('服务器指令不存在',true);
    const record=(await this.store.getSetting<CommandRecord|null>(commandKey(commandId)));
    if (!record || record.serverId!==serverId || record.generation!==agent.generation) throw new AgentCommandError('服务器指令不存在',true);
    return record;
  }
  private async seen(serverId:string):Promise<void> { (await this.store.setSetting<AgentRecord>(stateKey(serverId),{...(await this.agent(serverId)),lastSeen:this.now()})); }
  private async write(record:CommandRecord):Promise<void> {
    (await this.store.setSetting(commandKey(record.id),record));
    const key=`agent:audit:${record.serverId}`,audit=(await this.store.getSetting<AuditRecord[]>(key))??[];
    (await this.store.setSetting(key,[...audit,{id:record.id,operation:record.operation,state:record.state,time:new Date(this.now()).toISOString()}].slice(-200)));
  }
  private async finish(record:CommandRecord,state:'succeeded'|'failed'|'unknown'|'cancelled',outcomeKnown:boolean):Promise<void> {
    record.state=state;record.finishedAt=this.now();record.outcomeKnown=outcomeKnown;
    (await this.write(record));(await this.store.vault.delete(payloadKey(record.id)));
  }
  private async expire(record:CommandRecord):Promise<void> { (await this.finish(record,record.state==='queued'?'cancelled':'unknown',record.state==='queued')); }
  private async invalidateCommands(serverId:string):Promise<void> { for (const record of (await this.records(serverId))) if (pendingStates.has(record.state)) (await this.finish(record,record.state==='queued'?'cancelled':'unknown',record.state==='queued')); }
  private async prune(serverId:string):Promise<void> {
    const records=(await this.records(serverId)),terminal=records.filter(record=>!pendingStates.has(record.state));
    const removed=new Set(terminal.slice(0,Math.max(0,terminal.length-retainedCommands)).filter(record=>!this.waitingCommands.has(record.id)).map(record=>record.id));
    for (const id of removed) { (await this.store.setSetting(commandKey(id),null));(await this.store.vault.delete(payloadKey(id)));(await this.store.vault.delete(resultKey(id))); }
    (await this.store.setSetting(indexKey(serverId),records.filter(record=>!removed.has(record.id)).map(record=>record.id)));
  }
}
