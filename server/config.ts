import {existsSync} from 'node:fs';
import {resolve} from 'node:path';

type Environment=Record<string,string|undefined>;

/** Legacy environment names remain valid when upgrading an existing installation. */
export function env(name:string,source:Environment=process.env):string|undefined {
  return source[`VOID0_${name}`]??source[`SERVERDESK_${name}`];
}

/** Keep an existing installation's state unless a new directory was selected. */
export function dataDirectory(kind:'control'|'publisher'='control',source:Environment=process.env,cwd=process.cwd()):string {
  const publisher=kind==='publisher';
  const configured=env(publisher?'PUBLISHER_DATA_DIR':'DATA_DIR',source);
  if(configured!==undefined)return resolve(cwd,configured);
  const current=resolve(cwd,publisher?'.void0-publisher':'.void0');
  const legacy=resolve(cwd,publisher?'.serverdesk-publisher':'.serverdesk');
  return !existsSync(current)&&existsSync(legacy)?legacy:current;
}
