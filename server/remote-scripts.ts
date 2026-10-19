/** Auditable remote programs. Requests (including service environment) travel on stdin. */
export const PROBE_SCRIPT = String.raw`
import os,json,time,subprocess,shutil,re
def call(args):
 try:
  p=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=15)
  return p.stdout.decode() if p.returncode==0 else ''
 except Exception:return ''
sudo=[] if os.geteuid()==0 else ['sudo','-n']
docker=shutil.which('docker')
out={'checkedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'hostname':os.uname().nodename,'services':[]}
def read(path):
 try:
  with open(path) as source:return source.read().strip()
 except (OSError,ValueError):return ''
def number(path):
 try:return int(read(path))
 except ValueError:return None
def unescape(value):return re.sub(r'\\([0-7]{3})',lambda match:chr(int(match[1],8)),value)
def cgroup_paths():
 # Mount roots can be subtrees, and the Agent's systemd unit is often unlimited
 # while the enclosing VM/container has a finite limit. Inspect every visible parent.
 memberships={};paths={}
 for row in read('/proc/self/cgroup').splitlines():
  fields=row.split(':',2)
  if len(fields)!=3:continue
  for controller in fields[1].split(',') if fields[1] else ['v2']:memberships[controller]=fields[2]
 for row in read('/proc/self/mountinfo').splitlines():
  fields=row.split()
  try:
   separator=fields.index('-');kind=fields[separator+1]
   if kind not in ('cgroup','cgroup2'):continue
   root,mount=unescape(fields[3]),unescape(fields[4])
   controllers=['v2'] if kind=='cgroup2' else fields[separator+3].split(',')
   for controller in controllers:
    member=memberships.get(controller)
    if not member or not member.startswith('/') or '..' in member.split('/') or '..' in root.split('/'):continue
    root=os.path.normpath(root);mount=os.path.normpath(mount)
    if root=='/':relative=member.lstrip('/')
    elif member==root:relative=''
    elif member.startswith(root+'/'):relative=member[len(root)+1:]
    else:continue
    current=os.path.normpath(os.path.join(mount,relative));logical=os.path.normpath(member);chain=[]
    while True:
     chain.append((current,logical))
     if current==mount:break
     current=os.path.dirname(current);logical=os.path.dirname(logical)
    if len(chain)>len(paths.get(controller,[])):paths[controller]=chain
  except (ValueError,IndexError):continue
 return paths
groups=cgroup_paths()
mem={}
for row in open('/proc/meminfo'):
 k,v=row.split(':',1);mem[k]=int(v.strip().split()[0])*1024
memory_total=mem.get('MemTotal');memory_available=mem.get('MemAvailable')
for controller,limit_file,usage_file in [('v2','memory.max','memory.current'),('memory','memory.limit_in_bytes','memory.usage_in_bytes')]:
 for directory,_ in groups.get(controller,[]):
  limit=number(directory+'/'+limit_file)
  # v1's unlimited sentinel is larger than physical RAM; v2 uses the word max.
  if limit is None or limit<0 or memory_total is None or limit>=mem['MemTotal']:continue
  memory_total=min(memory_total,limit)
  usage=number(directory+'/'+usage_file)
  if usage is not None and usage>=0:
   # Conservative remaining budget: reclaimable cache is not guessed here.
   available=max(0,limit-usage)
   memory_available=available if memory_available is None else min(memory_available,available)
if memory_total is not None and memory_available is not None:memory_available=min(memory_total,max(0,memory_available))
out.update(memoryTotal=memory_total,memoryAvailable=memory_available,loadAverage=os.getloadavg()[0])
disk=shutil.disk_usage('/');out.update(diskTotal=disk.total,diskAvailable=disk.free)
def cpu():
 vals=list(map(int,read('/proc/stat').splitlines()[0].split()[1:]));return sum(vals),vals[3]+(vals[4] if len(vals)>4 else 0)
def cpus(value):
 try:
  total=0
  for part in value.split(','):
   pair=part.split('-');first=int(pair[0]);last=int(pair[-1])
   if len(pair)>2 or first<0 or last<first:return None
   total+=last-first+1
  return total or None
 except ValueError:return None
host_cpus=sum(1 for row in read('/proc/stat').splitlines() if re.match(r'^cpu[0-9]+\s',row)) or os.cpu_count() or 1
cpu_scope=None;cpu_capacity=host_cpus
for controller in ['v2','cpu','cpuset']:
 for directory,logical in groups.get(controller,[]):
  capacity=None
  if controller=='v2':
   quota=read(directory+'/cpu.max').split()
   if len(quota)==2 and quota[0]!='max':
    try:
     if int(quota[0])>0 and int(quota[1])>0:capacity=int(quota[0])/int(quota[1])
    except ValueError:pass
   allowed=cpus(read(directory+'/cpuset.cpus.effective'))
  elif controller=='cpu':
   quota=number(directory+'/cpu.cfs_quota_us');period=number(directory+'/cpu.cfs_period_us')
   if quota is not None and period is not None and quota>0 and period>0:capacity=quota/period
   allowed=None
  else:allowed=cpus(read(directory+'/cpuset.effective_cpus') or read(directory+'/cpuset.cpus'))
  # An unrestricted systemd unit/cpuset must retain the whole-host fallback.
  if allowed is not None and allowed<host_cpus:capacity=min(capacity,allowed) if capacity is not None else allowed
  if capacity is None or capacity>=host_cpus:continue
  if capacity<=cpu_capacity:
   usage_path=directory+'/cpu.stat';scale=1000000
   if controller!='v2':
    accounts=dict((logical_path,path) for path,logical_path in groups.get('cpuacct',[]))
    usage_path=accounts.get(logical,directory)+'/cpuacct.usage';scale=1000000000
   # On equal limits prefer a wider parent so sibling workloads are included.
   # Separate v1 cpu/cpuset mounts still identify the same logical accounting group.
   if cpu_scope is None or capacity<cpu_capacity or len(logical.split('/'))<=cpu_scope[3]:
    cpu_scope=(usage_path,scale,controller=='v2',len(logical.split('/')));cpu_capacity=capacity
def cgroup_cpu():
 if cpu_scope is None:return None
 value=read(cpu_scope[0])
 try:
  if cpu_scope[2]:value=dict(row.split() for row in value.splitlines())['usage_usec']
  value=int(value)
  return value/cpu_scope[1] if value>=0 else None
 except (ValueError,KeyError):return None
started=time.monotonic();group_a=cgroup_cpu();a=cpu();time.sleep(.15);b=cpu();group_b=cgroup_cpu();elapsed=time.monotonic()-started
percent=100*(1-(b[1]-a[1])/max(1,b[0]-a[0]))
if group_a is not None and group_b is not None and group_b>=group_a and elapsed>0:percent=100*(group_b-group_a)/(elapsed*cpu_capacity)
out['cpuPercent']=round(max(0,min(100,percent)),1)
out['dockerAvailable']=bool(docker and call(sudo+[docker,'info','--format','{{json .ServerVersion}}']))
out['composeAvailable']=bool(docker and call(sudo+[docker,'compose','version','--short']))
out['gitAvailable']=bool(shutil.which('git'))
if out['dockerAvailable']:
 fmt='{{json .Names}}\t{{json .State}}\t{{json .Status}}\t{{json .Image}}\t{{json (.Label "com.docker.compose.project")}}\t{{json (.Label "com.docker.compose.service")}}'
 for line in call(sudo+[docker,'ps','-a','--format',fmt]).splitlines():
  try:
   name,state,status,image,project,service=[json.loads(x) for x in line.split('\t')]
   out['services'].append({'name':name,'ready':state=='running' and '(unhealthy)' not in status and '(health: starting)' not in status,'state':state,'kind':'Docker','image':image,'composeProject':project or None,'composeService':service or None})
  except Exception:pass
k3s=shutil.which('k3s') or ('/usr/local/bin/k3s' if os.path.isfile('/usr/local/bin/k3s') else None)
out.update(k3sAvailable=bool(k3s),k3sReady=False,k3sNodeCount=0)
if k3s:
 version=call([k3s,'--version']).splitlines()
 if version:out['k3sVersion']=version[0][:160]
 nodes=call(sudo+[k3s,'kubectl','get','nodes','-o','jsonpath={range .items[*]}{.metadata.name}{"\\t"}{range .status.conditions[?(@.type=="Ready")]}{.status}{end}{"\\n"}{end}']).splitlines()
 out['k3sNodeCount']=len(nodes);out['k3sReady']=bool(nodes) and all(row.rsplit('\t',1)[-1]=='True' for row in nodes)
 query=r'{range .items[*]}{.metadata.namespace}{"\t"}{.metadata.name}{"\t"}{.spec.replicas}{"\t"}{.status.readyReplicas}{"\t"}{.spec.template.spec.containers[0].image}{"\n"}{end}'
 raw=call(sudo+[k3s,'kubectl','get','deployments','--all-namespaces','-o','jsonpath='+query])
 for line in raw.splitlines():
  try:
   namespace,name,desired,ready,image=line.split('\t');desired=int(desired or 1);ready=int(ready or 0)
   if namespace in ('kube-system','kube-public','kube-node-lease','local-path-storage'):continue
   out['services'].append({'name':name,'kind':'Kubernetes','namespace':namespace,'deployment':name,'state':'running' if desired>0 and ready>=desired else 'stopped','ready':desired>0 and ready>=desired,'image':image})
  except Exception:pass
print(json.dumps(out))
`;

// Verified against the official v1.36.4+k3s1 release. Upgrades are never implicit.
export const DEFAULT_K3S_VERSION = 'v1.36.4+k3s1';
export const K3S_INSTALLER_URL = 'https://raw.githubusercontent.com/k3s-io/k3s/4dedb15be78017a8ddd5b9e81acd44f3481078ed/install.sh';
export const K3S_INSTALLER_SHA256 = '46177d4c99440b4c0311b67233823a8e8a2fc09693f6c89af1a7161e152fbfad';

/** Dedicated host INPUT rules. iptables-restore --noflush changes only our chain and jump atomically. */
export const K3S_FIREWALL_SCRIPT = String.raw`import subprocess,shutil,shlex,sys
CHAIN='SERVERDESK_K3S_INPUT'
def run(args,input=None):
 p=subprocess.run(args,input=input,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30)
 if p.returncode:raise RuntimeError('K3s API firewall could not be installed; K3s was not started')
 return p.stdout.decode()
try:
 for binary,restore,ipv4 in [('iptables','iptables-restore',True),('ip6tables','ip6tables-restore',False)]:
  if not shutil.which(binary) or not shutil.which(restore):raise RuntimeError('iptables and ip6tables are required to protect the K3s API')
  existing=run([binary,'--wait','10','-S','INPUT']).splitlines()
  rules=['*filter',':'+CHAIN+' - [0:0]','-F '+CHAIN,'-A '+CHAIN+' -i lo -j ACCEPT','-A '+CHAIN+' -m addrtype --src-type LOCAL -j ACCEPT']
  if ipv4:rules.append('-A '+CHAIN+' -i cni0 -s 10.42.0.0/16 -j ACCEPT')
  rules.append('-A '+CHAIN+' -j DROP')
  for line in existing:
   args=shlex.split(line)
   if args[:2]==['-A','INPUT'] and '-j' in args and args[args.index('-j')+1]==CHAIN:rules.append(shlex.join(['-D']+args[1:]))
  rules.extend(['-I INPUT 1 -p tcp -m multiport --dports 6443,10250 -j '+CHAIN,'COMMIT',''])
  run([restore,'--wait','10','--noflush'],('\n'.join(rules)).encode())
  current=run([binary,'--wait','10','-S','INPUT']).splitlines()
  first=next((shlex.split(line) for line in current if line.startswith('-A ')),[])
  if not first or '-j' not in first or first[first.index('-j')+1]!=CHAIN:raise RuntimeError('K3s API firewall is not the first host INPUT rule')
 print('K3s API firewall is active: only loopback, local-host, and local Pod traffic are accepted on TCP 6443 and 10250.')
except Exception as error:
 print(str(error),file=sys.stderr);sys.exit(1)
`;

/** Runs as root after the shell installs Python. The test root is never sent by the SSH transport. */
export const K3S_INSTALL_SCRIPT = String.raw`
import os,sys,json,shutil,subprocess,tempfile,hashlib,re,socket,ipaddress
from pathlib import Path
os.umask(0o077)
TEST_ROOT=os.environ.get('SERVERDESK_TEST_K3S_ROOT')
def path(value):return Path(TEST_ROOT+value) if TEST_ROOT else Path(value)
def run(args,timeout=30,check=True,env=None):
 p=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=timeout,env=env)
 if check and p.returncode:raise RuntimeError('Command failed: '+args[0]+'; no server credentials were read')
 return p
def text(p):return p.stdout.decode('utf-8','replace').strip()
def loaded(unit):return text(run(['systemctl','show','--property=LoadState','--value',unit],check=False)) not in ('','not-found')
def present(p):return p.exists() or p.is_symlink()
version=os.environ.get('VOID0_K3S_VERSION') or os.environ.get('SERVERDESK_K3S_VERSION','v1.36.4+k3s1')
try:
 if not re.fullmatch(r'v1\.[0-9]{1,3}\.[0-9]{1,3}\+k3s[0-9]{1,3}',version):raise RuntimeError('A fixed stable K3s version is required')
 if not TEST_ROOT and os.geteuid()!=0:raise RuntimeError('K3s installation requires root or passwordless sudo')
 release=path('/etc/os-release').read_text()
 if not re.search(r'^ID=["\x27]?(ubuntu|debian)["\x27]?$',release,re.M):raise RuntimeError('Only Ubuntu and Debian K3s installation is supported')
 if not path('/run/systemd/system').is_dir():raise RuntimeError('A running systemd host is required')
 if loaded('k3s-agent.service') or present(path('/etc/systemd/system/k3s-agent.service')) or present(path('/etc/kubernetes/kubelet.conf')) or loaded('kubelet.service'):raise RuntimeError('Existing Kubernetes worker detected; no installation or reconfiguration was performed')
 binary=path('/usr/local/bin/k3s')
 k3s=str(binary) if binary.is_file() else shutil.which('k3s')
 server_config=present(path('/etc/rancher/k3s/k3s.yaml'))
 if k3s:
  if not server_config:raise RuntimeError('Existing K3s binary or agent detected without a local server configuration; no changes were made')
  current=text(run([k3s,'--version'])).splitlines()[0][:160]
  nodes=text(run([k3s,'kubectl','get','nodes','-o',r'jsonpath={range .items[*]}{.metadata.name}{"\t"}{range .status.conditions[?(@.type=="Ready")]}{.status}{end}{"\n"}{end}']))
  if not nodes or not all(row.rsplit('\t',1)[-1]=='True' for row in nodes.splitlines()):raise RuntimeError('Existing K3s is not ready; no upgrade, restart, or configuration change was performed')
  print('Existing '+current+' is ready. Configuration, version, and workloads were left unchanged.')
  sys.exit(0)
 if any(present(path(p)) for p in ['/etc/rancher/k3s','/var/lib/rancher/k3s','/etc/systemd/system/k3s.service','/etc/systemd/system/k3s.service.env','/usr/local/bin/k3s-uninstall.sh']) or loaded('k3s.service'):raise RuntimeError('Existing K3s state found without a usable server; inspect it manually before installing')
 memory={}
 for line in path('/proc/meminfo').read_text().splitlines():
  key,value=line.split(':',1);memory[key]=int(value.strip().split()[0])*1024
 cpu=int(os.environ['SERVERDESK_TEST_CPU']) if TEST_ROOT and 'SERVERDESK_TEST_CPU' in os.environ else (os.cpu_count() or 0)
 free=int(os.environ['SERVERDESK_TEST_DISK']) if TEST_ROOT and 'SERVERDESK_TEST_DISK' in os.environ else shutil.disk_usage(str(path('/'))).free
 if cpu<2 or memory.get('MemTotal',0)<2000000000:raise RuntimeError('K3s requires at least 2 CPUs and 2 GB of RAM, excluding application workloads')
 if memory.get('MemAvailable',0)<1073741824 or free<4294967296:raise RuntimeError('K3s installation requires at least 1 GiB available RAM and 4 GiB free disk')
 if not path('/sys/fs/cgroup').is_dir():raise RuntimeError('Linux cgroups are required')
 machine=text(run(['uname','-m']))
 if machine not in ('x86_64','aarch64','arm64'):raise RuntimeError('Only amd64 and arm64 hosts are supported')
 if not TEST_ROOT:
  for port in (6443,6444,10250):
   with socket.socket(socket.AF_INET,socket.SOCK_STREAM) as listener:
    try:listener.bind(('0.0.0.0',port))
    except OSError:raise RuntimeError('A required Kubernetes port is already in use: '+str(port))
  route_data=text(run(['ip','-j','route'],check=False))
  if not route_data:raise RuntimeError('Existing network routes could not be checked safely')
  for row in json.loads(route_data):
   destination=row.get('dst','default')
   if destination=='default':continue
   route=ipaddress.ip_network(destination,strict=False)
   if route.version==4 and any(route.overlaps(ipaddress.ip_network(cidr)) for cidr in ('10.42.0.0/16','10.43.0.0/16')):raise RuntimeError('Existing network overlaps the K3s pod or service address range; no network configuration was changed')
 firewall_script=path('/usr/local/lib/serverdesk/k3s-firewall.py')
 firewall_unit=path('/etc/systemd/system/serverdesk-k3s-firewall.service')
 dependency=path('/etc/systemd/system/k3s.service.d/10-serverdesk-firewall.conf')
 firewall_body=${JSON.stringify(K3S_FIREWALL_SCRIPT)}
 unit_body='[Unit]\nDescription=void0 K3s API firewall\nBefore=k3s.service\nAfter=network-pre.target\n\n[Service]\nType=oneshot\nExecStart=/usr/bin/python3 /usr/local/lib/serverdesk/k3s-firewall.py\nRemainAfterExit=yes\n\n[Install]\nWantedBy=multi-user.target\n'
 dependency_body='[Unit]\nRequires=serverdesk-k3s-firewall.service\nAfter=serverdesk-k3s-firewall.service\n\n[Service]\nExecStartPre=/usr/bin/python3 /usr/local/lib/serverdesk/k3s-firewall.py\nExecStartPost=/usr/bin/python3 /usr/local/lib/serverdesk/k3s-firewall.py\n'
 for target,content in [(firewall_script,firewall_body),(firewall_unit,unit_body),(dependency,dependency_body)]:
  for parent in target.parents:
   if parent.is_symlink():raise RuntimeError('Unsafe symlink in the firewall installation path')
   if not TEST_ROOT and parent.exists() and (parent.stat().st_uid!=0 or parent.stat().st_mode&0o022):raise RuntimeError('Firewall installation requires root-owned directories without write access for other users')
  if target.is_symlink() or (target.exists() and target.read_text()!=content):raise RuntimeError('Existing firewall installation files differ; no files were overwritten')
  if not TEST_ROOT and target.exists() and (target.stat().st_uid!=0 or target.stat().st_mode&0o022):raise RuntimeError('Existing firewall installation files are writable by other users')
 for binary_name in ('iptables','iptables-restore','ip6tables','ip6tables-restore'):
  if not shutil.which(binary_name):raise RuntimeError('iptables package is required before installing K3s')
 for binary_name in ('iptables','ip6tables'):
  previous=run([binary_name,'--wait','10','-S','SERVERDESK_K3S_INPUT'],check=False)
  if previous.returncode==0 and not firewall_script.exists():raise RuntimeError('The reserved K3s firewall chain already exists without a void0 owner; no rules were changed')
 for target,content in [(firewall_script,firewall_body),(firewall_unit,unit_body),(dependency,dependency_body)]:
  target.parent.mkdir(parents=True,exist_ok=True)
  with target.open('w') as output:output.write(content)
  target.chmod(0o700 if target==firewall_script else 0o644)
 run(['systemctl','daemon-reload'])
 run(['systemctl','enable','--now','serverdesk-k3s-firewall.service'],timeout=60)
 # Verify rules directly too, even if the oneshot unit was already active.
 run([sys.executable,str(firewall_script)],timeout=90)
 with tempfile.TemporaryDirectory(prefix='serverdesk-k3s-') as folder:
  script=Path(folder)/'install.sh'
  run(['curl','--fail','--silent','--show-error','--location','--proto','=https','--proto-redir','=https','--max-time','90','--output',str(script),'https://raw.githubusercontent.com/k3s-io/k3s/4dedb15be78017a8ddd5b9e81acd44f3481078ed/install.sh'],timeout=100)
  if hashlib.sha256(script.read_bytes()).hexdigest()!='46177d4c99440b4c0311b67233823a8e8a2fc09693f6c89af1a7161e152fbfad':raise RuntimeError('Official K3s installer checksum did not match; nothing was executed')
  env={'PATH':os.environ.get('PATH','/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'),'HOME':'/root','INSTALL_K3S_VERSION':version,'INSTALL_K3S_SKIP_START':'true','INSTALL_K3S_SKIP_ENABLE':'true','INSTALL_K3S_SYMLINK':'skip','INSTALL_K3S_EXEC':'server --bind-address=0.0.0.0 --https-listen-port=6443 --disable=traefik --disable=servicelb --flannel-backend=host-gw --write-kubeconfig-mode=600 --secrets-encryption --kubelet-arg=address=0.0.0.0'}
  # The pinned official installer validates the binary against the chosen release's SHA256 manifest.
  run(['sh',str(script)],timeout=360,env=env)
 run(['systemctl','enable','--now','k3s.service'],timeout=120)
 k3s=str(binary) if binary.is_file() else (shutil.which('k3s') or '/usr/local/bin/k3s')
 run([k3s,'kubectl','wait','--for=condition=Ready','nodes','--all','--timeout=180s'],timeout=190)
 print('Installed '+version+'. Single-node K3s is ready; the host firewall blocks external access to API and kubelet ports 6443/10250. Traefik and ServiceLB are disabled; SSH is used for management.')
except Exception as error:
 print(str(error),file=sys.stderr);sys.exit(1)
`;

export function k3sBootstrapScript(version=DEFAULT_K3S_VERSION):string {
 if(!/^v1\.[0-9]{1,3}\.[0-9]{1,3}\+k3s[0-9]{1,3}$/.test(version))throw new Error('A fixed stable K3s version is required');
 return String.raw`set -eu
export DEBIAN_FRONTEND=noninteractive
as_root() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo -n "$@"; fi; }
if [ ! -r /etc/os-release ]; then echo 'Only Ubuntu and Debian are supported' >&2; exit 1; fi
. /etc/os-release
case "$ID" in ubuntu|debian) ;; *) echo 'Only Ubuntu and Debian are supported' >&2; exit 1;; esac
as_root true
if ! command -v python3 >/dev/null || ! command -v curl >/dev/null || ! command -v git >/dev/null || ! command -v iptables >/dev/null || ! command -v ip6tables >/dev/null || ! command -v ip >/dev/null; then
 as_root apt-get update -qq
 as_root apt-get install -y --no-install-recommends ca-certificates curl git python3 iproute2 iptables
fi
as_root env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root SERVERDESK_K3S_VERSION='${version}' python3 - <<'SERVERDESK_K3S_PYTHON'
${K3S_INSTALL_SCRIPT}
SERVERDESK_K3S_PYTHON
`;
}
export const K3S_BOOTSTRAP_SCRIPT = k3sBootstrapScript();

/** Only a named Deployment is read or changed; no kubeconfig, Secret, or container environment is returned. */
export const KUBERNETES_ACTION_SCRIPT = String.raw`
import os,sys,json,re,subprocess,shutil
def clean(value):
 value=re.sub(r'(?i)Bearer\s+[A-Za-z0-9._~+/-]+=*','Bearer [redacted]',value)
 value=re.sub(r'(?i)(password|passwd|token|secret|authorization)(\s*[:=]\s*)([^\s,;]+)',r'\1\2[redacted]',value)
 return value[-32768:]
def call(args,timeout=40):
 p=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=timeout)
 if p.returncode:raise RuntimeError('Kubernetes command failed; confirm the Deployment state before retrying')
 return p.stdout.decode('utf-8','replace')
try:
 req=json.loads(sys.stdin.buffer.read(8192));target=req.get('target',{});action=req.get('action');options=req.get('options') or {}
 namespace=target.get('namespace');deployment=target.get('deployment')
 for value,maximum in ((namespace,63),(deployment,253)):
  if not isinstance(value,str) or len(value)>maximum or not re.fullmatch(r'[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?',value) or '..' in value:raise RuntimeError('Invalid Kubernetes target')
 if not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]*[a-z0-9])?',namespace):raise RuntimeError('Invalid Kubernetes namespace')
 if namespace in ('kube-system','kube-public','kube-node-lease','local-path-storage'):raise RuntimeError('System namespaces cannot be managed as application services')
 if action not in ('restart','stop','start','logs'):raise RuntimeError('Unsupported Kubernetes action')
 requested=options.get('replicas')
 if requested is not None and (type(requested) is not int or requested<1 or requested>100):raise RuntimeError('Replica count must be an integer from 1 to 100')
 k3s=shutil.which('k3s') or ('/usr/local/bin/k3s' if os.path.isfile('/usr/local/bin/k3s') else None)
 if not k3s:raise RuntimeError('K3s is not installed on this server')
 prefix=([] if os.geteuid()==0 else ['sudo','-n'])+[k3s,'kubectl','--request-timeout=30s','--namespace',namespace]
 query=r'{.spec.replicas}{"\t"}{.metadata.annotations.serverdesk\.io/previous-replicas}{"\n"}'
 fields=call(prefix+['get','deployment',deployment,'-o','jsonpath='+query]).strip('\n').split('\t')
 current=int(fields[0] or '1');previous=int(fields[1]) if len(fields)>1 and fields[1].isdigit() else None
 if action=='stop':
  if current>100:raise RuntimeError('Deployment exceeds the supported 100 replicas; no change was made')
  if current>0:call(prefix+['annotate','deployment',deployment,'serverdesk.io/previous-replicas='+str(current),'--overwrite'])
  if current:call(prefix+['scale','deployment',deployment,'--current-replicas='+str(current),'--replicas=0'])
  result={'replicas':current if current>0 else previous or 1,'log':'Deployment stopped at 0 replicas. Previous positive replica count is saved on the Deployment.'}
 elif action=='start':
  replicas=requested if requested is not None else (current if current>0 else previous if previous is not None else 1)
  if replicas<1 or replicas>100:raise RuntimeError('Saved replica count must be from 1 to 100; supply an explicit valid count')
  if current!=replicas:call(prefix+['scale','deployment',deployment,'--current-replicas='+str(current),'--replicas='+str(replicas)])
  call(prefix+['rollout','status','deployment/'+deployment,'--timeout=120s'],timeout=130)
  result={'replicas':replicas,'log':'Deployment is ready with '+str(replicas)+' replicas.'}
 elif action=='restart':
  if current==0:raise RuntimeError('Deployment is stopped; start it before requesting a restart')
  call(prefix+['rollout','restart','deployment/'+deployment])
  call(prefix+['rollout','status','deployment/'+deployment,'--timeout=120s'],timeout=130)
  result={'replicas':current,'log':'Selected Deployment restarted and is ready. Replica count remains '+str(current)+'.'}
 else:
  log=call(prefix+['logs','deployment/'+deployment,'--tail=100','--limit-bytes=32768','--timestamps=true','--all-containers=false','--pod-running-timeout=10s'])
  result={'log':clean(log)}
 print(json.dumps(result))
except Exception as error:
 print(json.dumps({'error':str(error),'outcomeKnown':not isinstance(error,subprocess.TimeoutExpired)}));sys.exit(1)
`;

export const BOOTSTRAP_SCRIPT = String.raw`
set -eu
export DEBIAN_FRONTEND=noninteractive
as_root() {
 if [ "$(id -u)" = 0 ]; then "$@"; else sudo -n "$@"; fi
}
if [ ! -r /etc/os-release ]; then echo 'Only Ubuntu and Debian bootstrap are supported' >&2; exit 1; fi
. /etc/os-release
case "$ID" in ubuntu|debian) ;; *) echo 'Only Ubuntu and Debian bootstrap are supported' >&2; exit 1;; esac
if ! command -v python3 >/dev/null || ! command -v git >/dev/null || ! command -v curl >/dev/null; then
 as_root apt-get update -qq
 as_root apt-get install -y --no-install-recommends ca-certificates curl git python3
fi
if ! command -v docker >/dev/null || ! as_root docker compose version >/dev/null 2>&1; then
 . /etc/os-release
 case "$ID" in ubuntu|debian) ;; *) echo 'Only Ubuntu and Debian bootstrap are supported' >&2; exit 1;; esac
 as_root install -m 0755 -d /etc/apt/keyrings
 curl --fail --silent --show-error --location "https://download.docker.com/linux/$ID/gpg" | as_root tee /etc/apt/keyrings/docker.asc >/dev/null
 as_root chmod a+r /etc/apt/keyrings/docker.asc
 printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' "$(dpkg --print-architecture)" "$ID" "$VERSION_CODENAME" | as_root tee /etc/apt/sources.list.d/serverdesk-docker.list >/dev/null
 as_root apt-get update -qq
 as_root apt-get install -y --no-install-recommends docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
as_root systemctl enable --now docker
as_root docker info --format '{{.ServerVersion}}'
as_root docker compose version --short
git --version
python3 --version
`;

const COMMON = String.raw`
import os,sys,json,time,uuid,subprocess,shutil,re,hashlib,fcntl,tarfile,base64,io,signal,stat,selectors
from pathlib import Path
os.umask(0o077)
ROOT=os.environ.get('SERVERDESK_TEST_ROOT') or os.path.expanduser('~/.local/share/serverdesk-web')
TEST=bool(os.environ.get('SERVERDESK_TEST_ROOT'))
ENV={'PATH':os.environ.get('SERVERDESK_TEST_PATH') or '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin','HOME':os.path.expanduser('~'),'LC_ALL':'C','COMPOSE_ANSI':'never','COMPOSE_PROGRESS':'plain'}
def safe_id(v):
 if not isinstance(v,str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}',v):raise ValueError('Invalid resource identifier')
 return v
def private_dir(path):
 path=os.path.abspath(path);cur='/'
 for part in Path(path).parts[1:]:
  cur=os.path.join(cur,part)
  try:os.mkdir(cur,0o700)
  except FileExistsError:pass
  s=os.lstat(cur)
  if not stat.S_ISDIR(s.st_mode) or stat.S_ISLNK(s.st_mode):raise ValueError('Unsafe server workspace path')
 if os.stat(path).st_uid!=os.getuid():raise ValueError('Server workspace has another owner')
 os.chmod(path,0o700);return path
def now():return time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
def atomic(path,value):
 if os.path.lexists(path) and (os.path.islink(path) or not os.path.isfile(path)):raise ValueError('Unsafe state file')
 temp=path+'.'+str(uuid.uuid4())
 fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'w') as f:json.dump(value,f);f.flush();os.fsync(f.fileno())
 os.replace(temp,path)
def load(path):
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
 with os.fdopen(fd) as f:return json.load(f)
def job_dir(jid):return private_dir(os.path.join(private_dir(ROOT),'jobs',safe_id(jid)))
def boot_id():
 try:return Path('/proc/sys/kernel/random/boot_id').read_text().strip()
 except Exception:return 'unknown'
def read_status(folder):
 s=load(os.path.join(folder,'status.json'))
 if s['state'] in ('queued','running'):
  alive=s.get('bootId')==boot_id()
  try:os.kill(s.get('pid',0),0)
  except OSError:alive=False
  if alive:
   try:
    if Path('/proc/'+str(s['pid'])+'/stat').read_text().split()[2]=='Z':alive=False
   except Exception:pass
  if not alive:
   s.update(state='unknown',stage='interrupted',message='Worker stopped; inspect the service before starting another deployment',updatedAt=now());atomic(os.path.join(folder,'status.json'),s)
 try:
  fd=os.open(os.path.join(folder,'job.log'),os.O_RDONLY|os.O_NOFOLLOW)
  with os.fdopen(fd,'rb') as f:f.seek(0,2);f.seek(max(0,f.tell()-131072));s['log']=f.read().decode('utf-8','replace')
 except FileNotFoundError:s['log']=''
 return {k:v for k,v in s.items() if k not in ('pid','bootId')}
`;

export const STATUS_SCRIPT = COMMON + String.raw`
try:
 req=json.loads(sys.stdin.buffer.read(4096));jid=safe_id(req['jobId']);folder=os.path.join(ROOT,'jobs',jid)
 if not os.path.isdir(folder):print(json.dumps({'state':'unknown','stage':'missing','message':'No remote job receipt; do not retry automatically','log':''}))
 else:print(json.dumps(read_status(job_dir(jid))))
except Exception:print(json.dumps({'state':'unknown','stage':'unavailable','message':'Cannot safely read remote job state','log':''}))
`;

export const SUBMIT_SCRIPT = COMMON + String.raw`
MAX_ARCHIVE=50*1024*1024
def worker(plan,folder):
 state=load(os.path.join(folder,'status.json'));state.update(pid=os.getpid(),bootId=boot_id(),state='running')
 secrets=[]
 for v in (plan['service'].get('environment') or {}).values():
  if isinstance(v,str) and v:
   secrets.append(v);secrets.extend(line for line in v.splitlines() if line)
 secrets=sorted(set(secrets),key=len,reverse=True)
 def redact(text):
  for value in secrets:text=text.replace(value,'[redacted]')
  text=re.sub(r'(?i)(authorization|password|token|secret)(\s*[:=]\s*)\S+',r'\1\2[redacted]',text)
  return text
 def log(text):
  path=os.path.join(folder,'job.log');fd=os.open(path,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
  with os.fdopen(fd,'r+b') as f:
   f.seek(0,2);f.write(redact(text).encode());f.flush()
   if f.tell()>262144:
    f.seek(-131072,2);tail=f.read();f.seek(0);f.truncate();f.write(tail);f.flush()
 def update(stage,**extra):
  state.update(stage=stage,updatedAt=now(),**extra);atomic(os.path.join(folder,'status.json'),state)
 def execute(args,timeout=120,cwd=None,label='Command'):
  log('$ '+label+'\n')
  # Raw command output is bounded in memory, never written to an unredacted log.
  p=subprocess.Popen(args,cwd=cwd,env=ENV,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,start_new_session=True)
  selector=selectors.DefaultSelector();selector.register(p.stdout,selectors.EVENT_READ);chunks=[];pending=b'';size=0;deadline=time.monotonic()+timeout
  try:
   while selector.get_map():
    if time.monotonic()>deadline:raise RuntimeError(label+' timed out')
    for key,_ in selector.select(min(1,max(.01,deadline-time.monotonic()))):
     raw=os.read(key.fileobj.fileno(),65536)
     if not raw:selector.unregister(key.fileobj);continue
     size+=len(raw)
     if size>4*1024*1024:raise RuntimeError(label+' output exceeded the 4 MiB safety limit')
     chunks.append(raw)
     pending+=raw
     while b'\n' in pending:
      line,pending=pending.split(b'\n',1);log(line.decode('utf-8','replace')+'\n')
   p.wait(timeout=max(.01,deadline-time.monotonic()))
  except BaseException:
   try:os.killpg(p.pid,signal.SIGKILL)
   except ProcessLookupError:pass
   p.wait();raise
  finally:selector.close();p.stdout.close()
  text=b''.join(chunks).decode('utf-8','replace')
  if pending:log(pending.decode('utf-8','replace')+'\n')
  if p.returncode:raise RuntimeError(label+' failed (exit '+str(p.returncode)+')')
  return text.strip()
 sudo=[] if TEST or os.geteuid()==0 else ['sudo','-n']
 def docker(args,timeout=120,cwd=None,label='Docker'):return execute(sudo+['docker']+args,timeout,cwd,label)
 def labels(service):
  target=service.get('target') or {};project=target.get('composeProject');name=target.get('composeService')
  if not isinstance(project,str) or not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,127}',project):raise ValueError('Invalid Compose project')
  if not isinstance(name,str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,252}',name):raise ValueError('Invalid Compose service')
  return project,name
 def container(project,name,optional=False):
  ids=docker(['ps','-aq','--filter','label=com.docker.compose.project='+project,'--filter','label=com.docker.compose.service='+name],label='Find selected service').splitlines()
  if not ids and optional:return None
  if len(ids)!=1 or not re.fullmatch(r'[a-fA-F0-9]{12,64}',ids[0]):raise ValueError('Expected exactly one container for the selected Compose service')
  fmt='{"imageID":{{json .Image}},"image":{{json .Config.Image}},"files":{{json (index .Config.Labels "com.docker.compose.project.config_files")}},"directory":{{json (index .Config.Labels "com.docker.compose.project.working_dir")}},"envFiles":{{json (index .Config.Labels "com.docker.compose.project.environment_file")}}}'
  result=json.loads(docker(['inspect','--format',fmt,ids[0]],label='Read selected container metadata'))
  if not re.fullmatch(r'sha256:[a-f0-9]{64}',result.get('imageID','')):raise ValueError('Container image identity is invalid')
  return result
 def safe_original(path):
  if not isinstance(path,str) or not os.path.isabs(path) or any(ord(x)<32 for x in path):raise ValueError('Compose path must be absolute')
  if os.path.realpath(path)!=os.path.normpath(path):raise ValueError('Compose paths must not use symlinks')
  st=os.stat(path)
  if not stat.S_ISREG(st.st_mode) or st.st_size>4*1024*1024:raise ValueError('Compose file is unavailable or too large')
  return hashlib.sha256(Path(path).read_bytes()).hexdigest()
 service=plan['service'];kind=service['kind'];sid=safe_id(service['id']);previous=None;changed=False;compose=None;rollback=None
 try:
  if kind not in ('compose','source','image'):raise ValueError('This deployment supports Docker Compose services only')
  project,name=labels(service) if kind=='compose' else ('sd-'+sid.replace('-','').lower(),'app')
  lockdir=private_dir(os.path.join(ROOT,'locks'));lockpath=os.path.join(lockdir,project+'.lock')
  lockfd=os.open(lockpath,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
  try:fcntl.flock(lockfd,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError:raise RuntimeError('Another deployment is using this Compose project')
  update('preparing')
  original=container(project,name,kind!='compose');previous=original.get('imageID') if original else None
  files=[];hashes={};env_files=[];env_stamps={};cwd=folder
  if kind=='compose':
   discovered=(original.get('files') or '').split(',');files=[]
   for path in discovered:
    # Compose records every -f argument in its labels. Remove only our own prior
    # image-only override, otherwise each release would grow the config chain.
    relative=os.path.relpath(path,os.path.join(ROOT,'jobs')) if os.path.isabs(path) else ''
    parts=Path(relative).parts
    if len(parts)==2 and parts[0] not in ('.','..') and parts[1]=='image-override.json':
     safe_id(parts[0]);safe_original(path);prior=load(path)
     spec=(prior.get('services') or {}).get(name)
     if set(prior)!={'services'} or set(prior['services'])!={name} or not isinstance(spec,dict) or set(spec)!={'image'} or not re.fullmatch(r'sha256:[a-f0-9]{64}',spec.get('image','')):raise ValueError('Prior image override has unexpected configuration')
    else:files.append(path)
   if not files or len(files)>8 or any(not x for x in files):raise ValueError('Original Compose file paths are unavailable')
   hashes={path:safe_original(path) for path in files};cwd=original.get('directory')
   if not isinstance(cwd,str) or not os.path.isabs(cwd) or os.path.realpath(cwd)!=os.path.normpath(cwd) or not os.path.isdir(cwd):raise ValueError('Original Compose working directory is unavailable')
   declared_env=original.get('envFiles') or ''
   if not isinstance(declared_env,str):raise ValueError('Original Compose environment file metadata is invalid')
   env_files=declared_env.split(',') if declared_env else []
   if len(env_files)>8 or any(not path for path in env_files):raise ValueError('Original Compose environment file metadata is invalid')
   for path in env_files:env_stamps[path]=safe_original(path)
   default_env=os.path.join(cwd,'.env')
   if default_env not in env_stamps:env_stamps[default_env]=safe_original(default_env) if os.path.lexists(default_env) else None
  else:
   owned=private_dir(os.path.join(ROOT,'services',sid));basefile=os.path.join(owned,'compose.json');files=[basefile]
   spec={'image':'scratch','restart':'unless-stopped'}
   env=service.get('environment') or {}
   if not isinstance(env,dict) or any(not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*',k) or not isinstance(v,str) or '\x00' in v for k,v in env.items()):raise ValueError('Invalid environment variables')
   if env:spec['environment']={k:v.replace('$','$$') for k,v in env.items()}
   port=service.get('containerPort');host=service.get('hostPort')
   if port is not None:
    if not isinstance(port,int) or isinstance(port,bool) or not 1<=port<=65535:raise ValueError('Container port is invalid')
    if host is None:spec['expose']=[str(port)]
    else:
     if not isinstance(host,int) or isinstance(host,bool) or not 1<=host<=65535:raise ValueError('Host port is invalid')
     spec['ports']=[str(host)+':'+str(port)]
   elif host is not None:raise ValueError('Host port requires a container port')
   volumes={};mounts=[]
   for v in service.get('volumes') or []:
    vn=v.get('name');mount=v.get('mountPath')
    if not isinstance(vn,str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,100}',vn) or not isinstance(mount,str) or not mount.startswith('/') or '..' in mount.split('/') or ':' in mount or any(ord(c)<32 for c in mount):raise ValueError('Invalid Docker volume')
    volumes[vn]={};mounts.append(vn+':'+mount)
   if mounts:spec['volumes']=mounts
   atomic(basefile,{'services':{name:spec},'volumes':volumes});cwd=owned
  repository=plan.get('repository')
  if repository:
   revision=repository.get('commit','')
   if not re.fullmatch(r'[a-fA-F0-9]{40,64}',revision):raise ValueError('A pinned Git commit is required')
   update('extracting',revision=revision)
   source=private_dir(os.path.join(folder,'source'));archive=os.path.join(folder,'source.tar.gz')
   size=0;count=0
   with tarfile.open(archive,'r:gz') as tar:
    for member in tar:
     count+=1;parts=Path(member.name).parts
     if not parts or parts[0] in ('.','..','/') or any(p=='..' for p in parts) or member.issym() or member.islnk() or not(member.isdir() or member.isfile()):raise ValueError('Source archive contains an unsafe path or file type')
     relative=Path(*parts[1:]);target=os.path.join(source,str(relative))
     if os.path.commonpath([source,os.path.abspath(target)])!=source:raise ValueError('Source archive escaped workspace')
     size+=member.size
     if size>256*1024*1024 or count>50000:raise ValueError('Source archive exceeds extraction limits')
     if member.isdir():os.makedirs(target,mode=0o700,exist_ok=True)
     elif len(parts)>1:
      os.makedirs(os.path.dirname(target),mode=0o700,exist_ok=True)
      with tar.extractfile(member) as src,open(target,'xb') as dst:shutil.copyfileobj(src,dst)
      os.chmod(target,0o700 if member.mode&0o111 else 0o600)
   os.unlink(archive)
   def relative_path(value,allow_dot=False):
    if not isinstance(value,str) or os.path.isabs(value) or '..' in Path(value).parts or any(ord(x)<32 for x in value):raise ValueError('Build path must remain inside the repository')
    if not value or (value=='.' and not allow_dot):raise ValueError('Build path is required')
    return os.path.join(source,value)
   dockerfile=relative_path(service.get('dockerfile') or 'Dockerfile');context=relative_path(service.get('context') or '.',True)
   if not os.path.isfile(dockerfile) or not os.path.isdir(context):raise ValueError('Dockerfile or build context does not exist')
   tag='serverdesk/'+sid.lower()+':'+revision.lower();update('building')
   docker(['build','--label','org.opencontainers.image.revision='+revision,'-f',dockerfile,'-t',tag,context],timeout=1800,label='Build Docker image from pinned source')
  else:
   tag=service.get('image') or ''
   if not isinstance(tag,str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/@:-]{0,511}',tag):raise ValueError('A valid Docker image is required')
   update('pulling');docker(['pull',tag],timeout=600,label='Pull Docker image')
  image=docker(['image','inspect','--format','{{.Id}}',tag],label='Resolve immutable image')
  if not re.fullmatch(r'sha256:[a-f0-9]{64}',image):raise ValueError('Cannot resolve immutable image identity')
  if previous==image:update('complete',state='succeeded',message='Selected service already uses this image');return
  for path,digest in hashes.items():
   if safe_original(path)!=digest:raise RuntimeError('Compose configuration changed during build; deployment was stopped')
  for path,digest in env_stamps.items():
   current=safe_original(path) if os.path.lexists(path) else None
   if current!=digest:raise RuntimeError('Compose environment file changed during build; deployment was stopped')
  # Re-check container identity immediately before changing it.
  latest=container(project,name,kind!='compose')
  if (latest.get('imageID') if latest else None)!=previous:raise RuntimeError('Selected service changed during build; deployment was stopped')
  override=os.path.join(folder,'image-override.json');atomic(override,{'services':{name:{'image':image}}})
  compose=['compose','--project-name',project,'--project-directory',cwd]
  for path in env_files:compose+=['--env-file',path]
  for path in files:compose+=['-f',path]
  compose+=['-f',override]
  update('deploying');changed=True
  docker(compose+['up','-d','--no-deps','--no-build','--pull','never','--wait','--wait-timeout','120',name],timeout=180,cwd=cwd,label='Update selected Compose service and wait for readiness')
  actual=container(project,name)
  if actual['imageID']!=image:raise RuntimeError('Selected container does not use the expected immutable image')
  update('complete',state='succeeded',message='Selected service was updated successfully')
 except Exception as error:
  message=redact(str(error));log(message+'\n')
  if changed and previous and compose:
   try:
    update('rolling_back');atomic(override,{'services':{name:{'image':previous}}})
    docker(compose+['up','-d','--no-deps','--no-build','--pull','never','--wait','--wait-timeout','120',name],timeout=180,cwd=cwd,label='Restore previous container image')
    if container(project,name)['imageID']!=previous:raise RuntimeError('Restored image could not be confirmed')
    update('rolled_back',state='rolled_back',message=message+'; previous container image restored. Database and volume changes cannot be rolled back.')
   except Exception as rollback_error:update('rollback_failed',state='rollback_failed',message=message+'; restoring the previous image failed: '+redact(str(rollback_error)))
  else:update('failed',state='failed',message=message)
 finally:
  shutil.rmtree(os.path.join(folder,'source'),ignore_errors=True)
  for name in ('source.tar.gz','command.output'):
   try:os.unlink(os.path.join(folder,name))
   except FileNotFoundError:pass
  state['finishedAt']=now();atomic(os.path.join(folder,'status.json'),state)
try:
 raw=sys.stdin.buffer.read(72*1024*1024+1)
 if len(raw)>72*1024*1024:raise ValueError('Deployment request is too large')
 req=json.loads(raw);plan=req['plan'];jid=safe_id(plan['job']['id']);safe_id(plan['service']['id'])
 # A leaked backend credential must never become part of a durable job request.
 if 'token' in (plan.get('repository') or {}):raise ValueError('Source credentials are not accepted by the remote worker')
 folder=job_dir(jid)
 submitfd=os.open(os.path.join(folder,'submit.lock'),os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600);fcntl.flock(submitfd,fcntl.LOCK_EX)
 receipt=os.path.join(folder,'status.json')
 if os.path.exists(receipt):print(json.dumps(read_status(folder)));sys.exit(0)
 archive=req.get('archive')
 if plan.get('repository'):
  if not isinstance(archive,str):raise ValueError('Pinned repository archive is required')
  data=base64.b64decode(archive,validate=True)
  if len(data)>MAX_ARCHIVE:raise ValueError('Source archive is too large')
  fd=os.open(os.path.join(folder,'source.tar.gz'),os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
  with os.fdopen(fd,'wb') as f:f.write(data)
 state={'state':'queued','stage':'queued','revision':(plan.get('repository') or {}).get('commit') or plan['job'].get('revision'),'createdAt':now(),'updatedAt':now(),'log':'','bootId':boot_id(),'pid':os.getpid()}
 atomic(receipt,state)
 if TEST and os.environ.get('SERVERDESK_TEST_SYNC')=='1':worker(plan,folder);print(json.dumps(read_status(folder)))
 else:
  reader,writer=os.pipe()
  pid=os.fork()
  if pid:
   # Child has no dependency on the SSH connection or its input pipe.
   os.close(reader);state.update(pid=pid);atomic(receipt,state);os.write(writer,b'1');os.close(writer);os.close(submitfd);print(json.dumps({k:v for k,v in state.items() if k not in ('pid','bootId')}),flush=True)
  else:
   os.close(writer);os.read(reader,1);os.close(reader);os.close(submitfd)
   os.setsid();null=os.open(os.devnull,os.O_RDWR)
   for fd in (0,1,2):os.dup2(null,fd)
   if null>2:os.close(null)
   worker(plan,folder);os._exit(0)
except Exception as error:
 print(json.dumps({'state':'failed','stage':'submission_failed','message':str(error),'log':''}));sys.exit(1)
`;
