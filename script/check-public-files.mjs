import {execFileSync} from 'node:child_process';

// Read the Git index, rather than local ignored files or machine credentials.
const files=execFileSync('git',['ls-files','--cached','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
const blockedPath=/(^|\/)(?:\.codex|\.void0[^/]*|\.serverdesk[^/]*|verification|legacy|backups?|node_modules|build|dist|__pycache__)(?:\/|$)|(?:^|\/)(?:\.env(?:\..*)?|master\.key|setup-token|api-token|github-token|id_rsa|id_ed25519)$|\.(?:sqlite(?:-wal|-shm)?|db|dump|pem|key|p12|pfx|pyc|log|tar|tgz|zip)(?:\.gz)?$/i;
const checks=[
  ['private key',/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/=\r\n]{80,}/g],
  ['GitHub credential',/\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g],
  ['cloud access key',/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['personal absolute path',/\/(?:Users|home)\/(?!node\b|root\b|user\b)[A-Za-z0-9_.-]+\/(?:Documents|Desktop|Downloads|\.ssh|\.codex)\b/g],
];
function allowedIp(value){
  const [a,b,c]=value.split('.').map(Number);
  return a===0||a===10||a===127||(a===172&&b>=16&&b<=31)||(a===192&&b===168)||(a===169&&b===254)||(a===192&&b===0&&c===2)||(a===198&&b===51&&c===100)||(a===203&&b===0&&c===113);
}
const findings=[];
for(const path of files){
  if(path!=='.env.example'&&blockedPath.test(path)){findings.push({path,kind:'private or generated file'});continue;}
  const bytes=execFileSync('git',['show',':'+path],{maxBuffer:8*1024*1024});
  if(bytes.includes(0)){findings.push({path,kind:'unreviewed binary file'});continue;}
  const content=bytes.toString('utf8');
  for(const [kind,pattern] of checks){for(const match of content.matchAll(pattern))findings.push({path,line:content.slice(0,match.index).split('\n').length,kind});}
  for(const match of content.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)){
    if(match[0].split('.').some(v=>Number(v)>255)||allowedIp(match[0]))continue;
    // Package versions and integrity metadata are not server addresses.
    if(path==='package-lock.json'||path==='package.json')continue;
    findings.push({path,line:content.slice(0,match.index).split('\n').length,kind:'non-example public IPv4 address'});
  }
}
if(findings.length){
  for(const item of findings)console.error(`${item.path}${item.line?':'+item.line:''}: ${item.kind}`);
  console.error('Public-file check failed; values are intentionally redacted.');process.exitCode=1;
}else console.log(`Public-file check passed (${files.length} staged files); no blocked paths or credential patterns found.`);
