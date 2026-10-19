import type {Service} from './types.js';

/** Must match the fixed Docker worker: owned image/source services use their immutable service ID. */
export function managedComposeTarget(service:Service):{project:string;service:string}|undefined {
  if(service.kind==='image'||service.kind==='source')return {project:'sd-'+service.id.replaceAll('-','').toLowerCase(),service:'app'};
  if(service.kind==='compose'&&service.target.composeProject&&service.target.composeService)return {project:service.target.composeProject,service:service.target.composeService};
  return undefined;
}
