import type { JobState, RemoteJobStatus } from '../shared/types.js';

const states = new Set<JobState>(['queued','running','succeeded','failed','unknown','rolled_back','rollback_failed','cancelled']);
const maximumLogLength = 4 * 1024 * 1024;
const retainedLogLength = 128 * 1024;

/** Remote receipts carry worker metadata too; none of it may become a local Job patch. */
export function remoteJobStatus(value:unknown):RemoteJobStatus {
  if(!value || typeof value!=='object' || Array.isArray(value))throw new Error('Invalid remote job receipt');
  const record=value as Record<string,unknown>;
  if(typeof record.state!=='string' || !states.has(record.state as JobState) ||
    typeof record.stage!=='string' || record.stage.length<1 || record.stage.length>512 ||
    (record.log!=null && (typeof record.log!=='string' || record.log.length>maximumLogLength)) ||
    (record.revision!=null && (typeof record.revision!=='string' || record.revision.length>256)) ||
    (record.message!=null && (typeof record.message!=='string' || record.message.length>16*1024))) {
    throw new Error('Invalid remote job receipt');
  }
  return {
    state:record.state as JobState,
    stage:record.stage,
    log:typeof record.log==='string'?record.log.slice(-retainedLogLength):'',
    ...(typeof record.revision==='string'?{revision:record.revision}:{}),
    ...(typeof record.message==='string'?{message:record.message}:{}),
  };
}
