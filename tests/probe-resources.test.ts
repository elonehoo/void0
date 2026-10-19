import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { PROBE_SCRIPT } from '../server/remote-scripts.js';

const GiB=1024**3;
type Files=Record<string,string|string[]>;
const procStat=(busy:number,idle:number)=>`cpu ${busy} 0 0 ${idle} 0 0 0 0\n`+Array.from({length:8},(_,i)=>`cpu${i} 0 0 0 0\n`).join('');
const mount=(root='/',point='/sys/fs/cgroup',kind='cgroup2',controllers='rw')=>`32 20 0:28 ${root} ${point} rw,nosuid,nodev,noexec,relatime - ${kind} cgroup ${controllers}`;

async function probe(extra:Files={},membership='0::/system.slice/serverdesk-agent.service',mountinfo=mount()) {
 const files:Files={
  '/proc/meminfo':`MemTotal: ${16*GiB/1024} kB\nMemAvailable: ${12*GiB/1024} kB\n`,
  '/proc/stat':[procStat(100,900),procStat(180,1620)],
  '/proc/self/cgroup':membership,
  '/proc/self/mountinfo':mountinfo,
  ...extra,
 };
 // Execute the unmodified remote program with deterministic read-only Linux files.
 // No test paths or environment switches are added to the production program.
 const harness=String.raw`import sys,json,io,builtins,os,shutil,time
from collections import namedtuple
request=json.load(sys.stdin);files=request['files'];phase=0
def fixture_open(path,*args,**kwargs):
 value=files.get(str(path))
 if value is None:raise FileNotFoundError(str(path))
 return io.StringIO(value[min(phase,len(value)-1)] if isinstance(value,list) else value)
def fixture_sleep(_):
 global phase
 phase+=1
builtins.open=fixture_open
shutil.which=lambda _:None
shutil.disk_usage=lambda _:namedtuple('usage','total used free')(1000,300,700)
os.getloadavg=lambda:(1.5,1,1)
os.cpu_count=lambda:8
time.sleep=fixture_sleep
time.monotonic=lambda:phase*.15
exec(compile(request['script'],'probe.py','exec'))`;
 const result=await new Promise<{code:number;stdout:string;stderr:string}>((resolve,reject)=>{
  const child=spawn('python3',['-c',harness],{stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
  child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  child.on('error',reject);child.on('close',code=>resolve({code:code??-1,stdout,stderr}));
  child.stdin.end(JSON.stringify({script:PROBE_SCRIPT,files}));
 });
 assert.equal(result.code,0,result.stderr);assert.equal(result.stderr,'');
 return JSON.parse(result.stdout) as {memoryTotal:number;memoryAvailable:number;cpuPercent:number;diskTotal:number;diskAvailable:number};
}

test('probe uses the VM parent limits and its whole workload rather than an unlimited Agent unit',async()=>{
 const root='/sys/fs/cgroup',unit=root+'/system.slice/serverdesk-agent.service';
 const out=await probe({
  [root+'/memory.max']:String(4*GiB),[root+'/memory.current']:String(GiB),
  [root+'/cpu.max']:'200000 100000',[root+'/cpu.stat']:['usage_usec 1000000','usage_usec 1150000'],
  [unit+'/memory.max']:'max',[unit+'/memory.current']:String(10*1024**2),
  [unit+'/cpu.max']:'max 100000',[unit+'/cpu.stat']:['usage_usec 1000','usage_usec 2000'],
 });
 assert.equal(out.memoryTotal,4*GiB);assert.equal(out.memoryAvailable,3*GiB);assert.equal(out.cpuPercent,50);
 assert.equal(out.diskTotal,1000);assert.equal(out.diskAvailable,700);
});

test('probe includes parent memory pressure even when the child has a smaller limit',async()=>{
 const root='/sys/fs/cgroup',unit=root+'/system.slice/serverdesk-agent.service';
 const out=await probe({
  [root+'/memory.max']:String(8*GiB),[root+'/memory.current']:String(7.5*GiB),
  [unit+'/memory.max']:String(4*GiB),[unit+'/memory.current']:String(GiB),
 });
 assert.equal(out.memoryTotal,4*GiB);assert.equal(out.memoryAvailable,.5*GiB);
});

test('probe uses the tightest CPU quota and clamps an exhausted memory budget to zero',async()=>{
 const root='/sys/fs/cgroup',unit=root+'/system.slice/serverdesk-agent.service';
 const out=await probe({
  [root+'/memory.max']:String(4*GiB),[root+'/memory.current']:String(4*GiB+1),
  [root+'/cpu.max']:'200000 100000',[root+'/cpu.stat']:['usage_usec 1000000','usage_usec 1150000'],
  [unit+'/cpu.max']:'50000 100000',[unit+'/cpu.stat']:['usage_usec 1000','usage_usec 19750'],
 });
 assert.equal(out.memoryAvailable,0);assert.equal(out.cpuPercent,25);
});

test('probe follows a restricted cpuset to its widest equal parent accounting scope',async()=>{
 const root='/sys/fs/cgroup',unit=root+'/system.slice/serverdesk-agent.service';
 const out=await probe({
  [root+'/cpuset.cpus.effective']:'0-1,4-5',[root+'/cpu.stat']:['usage_usec 1000000','usage_usec 1300000'],
  [unit+'/cpuset.cpus.effective']:'0-1,4-5',[unit+'/cpu.stat']:['usage_usec 1000','usage_usec 2000'],
 });
 assert.equal(out.cpuPercent,50);
});

test('unlimited host and systemd groups retain physical host memory and CPU values',async()=>{
 const root='/sys/fs/cgroup',unit=root+'/system.slice/serverdesk-agent.service';
 const out=await probe({
  [root+'/memory.max']:'max',[root+'/cpu.max']:'max 100000',[root+'/cpuset.cpus.effective']:'0-7',
  [unit+'/memory.max']:'max',[unit+'/cpu.max']:'max 100000',[unit+'/cpuset.cpus.effective']:'0-7',
  [unit+'/cpu.stat']:['usage_usec 1000','usage_usec 2000'],
 });
 assert.equal(out.memoryTotal,16*GiB);assert.equal(out.memoryAvailable,12*GiB);assert.equal(out.cpuPercent,10);
});

test('cgroup mount subtree roots and escaped mount paths are resolved without reading outside the mount',async()=>{
 const root='/run/cgroup space',unit=root+'/system.slice/serverdesk-agent.service';
 const out=await probe({
  [root+'/memory.max']:String(4*GiB),[root+'/memory.current']:String(GiB),
  [root+'/cpu.max']:'200000 100000',[root+'/cpu.stat']:['usage_usec 1000000','usage_usec 1150000'],
  [unit+'/memory.max']:'max',
  '/run/memory.max':'1','/run/cpu.max':'1 100000',
 },'0::/containers/lab/system.slice/serverdesk-agent.service',mount('/containers/lab','/run/cgroup\\040space'));
 assert.equal(out.memoryTotal,4*GiB);assert.equal(out.cpuPercent,50);
});

test('v1 memory and separate CPU accounting mounts honor ancestor limits and unlimited sentinels',async()=>{
 const root='/sys/fs/cgroup',leaf='/system.slice/serverdesk-agent.service';
 const files:Files={
  [root+'/memory/memory.limit_in_bytes']:String(4*GiB),[root+'/memory/memory.usage_in_bytes']:String(GiB),
  [root+'/memory'+leaf+'/memory.limit_in_bytes']:'9223372036854771712',
  [root+'/cpu/cpu.cfs_quota_us']:'200000',[root+'/cpu/cpu.cfs_period_us']:'100000',
  [root+'/cpu'+leaf+'/cpu.cfs_quota_us']:'-1',[root+'/cpu'+leaf+'/cpu.cfs_period_us']:'100000',
  [root+'/cpuacct/cpuacct.usage']:['1000000000','1150000000'],
 };
 const out=await probe(files,`3:memory:${leaf}\n2:cpu:${leaf}\n1:cpuacct:${leaf}`,['memory','cpu','cpuacct'].map(c=>mount('/',root+'/'+c,'cgroup','rw,'+c)).join('\n'));
 assert.equal(out.memoryTotal,4*GiB);assert.equal(out.memoryAvailable,3*GiB);assert.equal(out.cpuPercent,50);
});

test('missing or malformed cgroups and unavailable counters fall back without failing the probe',async()=>{
 const fixtures:Files[]=[{},{'/sys/fs/cgroup/memory.max':'broken','/sys/fs/cgroup/cpu.max':'broken'},
  {'/sys/fs/cgroup/cpu.max':'200000 100000','/sys/fs/cgroup/cpu.stat':'nr_periods 42'},
  {'/sys/fs/cgroup/cpu.max':'200000 100000','/sys/fs/cgroup/cpu.stat':['usage_usec 1000000','usage_usec 1']}];
 for(const files of fixtures) {
  const out=await probe(files);assert.equal(out.memoryTotal,16*GiB);assert.equal(out.memoryAvailable,12*GiB);assert.equal(out.cpuPercent,10);
 }
});
