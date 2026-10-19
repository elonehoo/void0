import {createHash, createPrivateKey, createPublicKey, sign, verify} from 'node:crypto';
import type {ReleaseManifest, Service, SignedRelease} from '../shared/types.js';

/** The wire format is deliberately smaller than arbitrary JSON (also implemented in Python). */
export function canonicalJson(value:unknown):string {
  if(value===null || typeof value==='boolean')return JSON.stringify(value);
  if(typeof value==='number') {if(!Number.isSafeInteger(value))throw new Error('发布内容只允许安全整数');return String(value);}
  if(typeof value==='string') {
    for(let i=0;i<value.length;i++) {
      const unit=value.charCodeAt(i);
      if(unit>=0xd800 && unit<=0xdbff) {const next=value.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))throw new Error('发布内容包含无效字符');}
      else if(unit>=0xdc00&&unit<=0xdfff)throw new Error('发布内容包含无效字符');
    }
    return JSON.stringify(value);
  }
  if(Array.isArray(value))return '['+value.map(canonicalJson).join(',')+']';
  if(value && typeof value==='object' && Object.getPrototypeOf(value)===Object.prototype) {
    return '{'+Object.keys(value).sort().map(key=>{
      if(!/^[\x20-\x7e]+$/.test(key))throw new Error('发布字段名称必须为 ASCII');
      return JSON.stringify(key)+':'+canonicalJson((value as Record<string,unknown>)[key]);
    }).join(',')+'}';
  }
  throw new Error('发布内容不是受支持的 JSON');
}
export const contentSha256=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
export function servicePolicyHash(service:Service):string {
  const {image:_image,lastCommit:_commit,...configuration}=service;
  return contentSha256(configuration);
}
export function signRelease(payload:SignedRelease['payload'],manifest:Omit<ReleaseManifest,'payloadSha256'>,privateKeyPem:string):SignedRelease {
  const key=createPrivateKey(privateKeyPem);
  if(key.asymmetricKeyType!=='ed25519')throw new Error('发布密钥必须为 Ed25519');
  const bytes=Buffer.from(canonicalJson({...manifest,payloadSha256:contentSha256(payload)}));
  return {payload,authorization:{manifest:bytes.toString('base64'),signature:sign(null,bytes,key).toString('base64')}};
}
export function verifyRelease(release:SignedRelease,publicKeyPem:string,now=Math.floor(Date.now()/1000)):ReleaseManifest {
  const bytes=Buffer.from(release.authorization.manifest,'base64');
  const key=createPublicKey(publicKeyPem);
  if(key.asymmetricKeyType!=='ed25519'||!verify(null,bytes,key,Buffer.from(release.authorization.signature,'base64')))throw new Error('发布签名无效');
  const manifest=JSON.parse(bytes.toString('utf8')) as ReleaseManifest;
  if(canonicalJson(manifest)!==bytes.toString('utf8')||manifest.version!==1||manifest.payloadSha256!==contentSha256(release.payload))throw new Error('发布内容已被修改');
  if(!Number.isSafeInteger(manifest.sequence)||manifest.sequence<1||!Number.isSafeInteger(manifest.issuedAt)||!Number.isSafeInteger(manifest.expiresAt)||manifest.issuedAt>now+30||manifest.expiresAt<=now||manifest.expiresAt<=manifest.issuedAt||manifest.expiresAt-manifest.issuedAt>900)throw new Error('发布授权已过期或时间无效');
  const {service,server,job}=release.payload.plan;
  if(manifest.serverId!==server.id||manifest.serviceId!==service.id||job.serverId!==server.id||job.serviceId!==service.id||job.type!=='deploy')throw new Error('发布目标不匹配');
  return manifest;
}
