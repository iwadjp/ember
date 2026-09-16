#!/usr/bin/env node
'use strict';
// Ember: recover source text retained by a live V8 isolate, without evaluating code.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { fileURLToPath } = require('node:url');
const { execFileSync } = require('node:child_process');
const http = require('node:http');
const HASH = value => crypto.createHash('sha256').update(value).digest('hex');
const MAX_SOURCE = 8 * 1024 * 1024;
const ALLOWED_METHODS = new Set(['Debugger.enable','Debugger.getScriptSource','Debugger.disable']);

function git(root, args, options = {}) {
  return execFileSync('git',['--no-optional-locks','-C',root,...args],{windowsHide:true,timeout:10000,maxBuffer:32*1024*1024,stdio:['pipe','pipe','pipe'],...options});
}
function repoRoot(cwd) { return git(cwd,['rev-parse','--show-toplevel']).toString('utf8').trim(); }
function inside(root, target) {
  const rel = path.relative(root,target);
  return rel !== '' && rel !== '..' && !rel.startsWith('..'+path.sep) && !path.isAbsolute(rel);
}
function fileForScript(root, url) {
  if(!url.startsWith('file:')) return null;
  let target;
  try { target=fileURLToPath(url); } catch { return null; }
  if(!inside(root,target)) return null;
  const rel=path.relative(root,target).replaceAll('\\','/');
  if(rel.split('/').some(part=>part==='.git'||part==='node_modules')) return null;
  // A V8 scriptParsed event, not a filename suffix, establishes that this is a
  // loaded script. Node CLI entrypoints and required files may be extensionless.
  // Do not follow a file or ancestor junction outside this repository.
  let ancestor=target;
  while(!fs.existsSync(ancestor)) {
    const parent=path.dirname(ancestor); if(parent===ancestor) return null; ancestor=parent;
  }
  try { const real=fs.realpathSync(ancestor); if(real!==root&&!inside(root,real)) return null; } catch { return null; }
  return { target, relative:rel };
}

function discover(selectedPids) {
  if(process.platform!=='win32') throw new Error('Automatic process discovery currently requires Windows.');
  // Command lines are only used in memory; never exported to a report.
  const selection=selectedPids===undefined
    ? "$_.CommandLine -match '--inspect(?:-brk|-wait)?(?:[=\\s]|$)'"
    : '@('+selectedPids.map(validatePid).join(',')+') -contains [int]$_.ProcessId';
  const ps = "$ErrorActionPreference='Stop'; $nodes=@(Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object { "+selection+" }); $ports=@(Get-NetTCPConnection -State Listen | Where-Object { $_.LocalAddress -eq '127.0.0.1' -or $_.LocalAddress -eq '::1' }); @($nodes | ForEach-Object { $n=$_; $ports | Where-Object OwningProcess -eq $n.ProcessId | ForEach-Object { [pscustomobject]@{pid=[int]$n.ProcessId; port=[int]$_.LocalPort; host=$_.LocalAddress} } }) | ConvertTo-Json -Compress";
  const output=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',ps],{windowsHide:true,timeout:15000,encoding:'utf8',maxBuffer:1024*1024}).trim();
  if(!output) return [];
  const parsed=JSON.parse(output), rows=Array.isArray(parsed)?parsed:[parsed];
  return rows.filter(r=>r.pid!==process.pid).slice(0,64);
}
function jsonList(endpoint) {
  return new Promise((resolve,reject)=>{
    const req=http.get({host:endpoint.host,port:endpoint.port,path:'/json/list',timeout:800,agent:false},res=>{
      let bytes=0, chunks=[];
      res.on('data',c=>{bytes+=c.length;if(bytes>256*1024) req.destroy(new Error('Inspector discovery response too large'));else chunks.push(c);});
      res.on('end',()=>{try{ if(res.statusCode!==200) throw new Error('Not an inspector'); const data=JSON.parse(Buffer.concat(chunks)); resolve(Array.isArray(data)?data:[]); }catch(e){reject(e)}});
      res.on('error',reject);
    });
    req.on('timeout',()=>req.destroy(new Error('Inspector discovery timeout'))); req.on('error',reject);
  });
}
async function targets(selectedPids) {
  const endpoints=discover(selectedPids), found=[];
  const results=await Promise.allSettled(endpoints.map(async endpoint=>{
    const entries=await jsonList(endpoint);
    return entries.filter(e=>e.type==='node'&&e.webSocketDebuggerUrl).map(e=>{
      const url=new URL(e.webSocketDebuggerUrl);
      if(url.protocol!=='ws:' || !['127.0.0.1','[::1]','localhost'].includes(url.hostname) || Number(url.port)!==endpoint.port) return null;
      // Pin to the observed loopback endpoint rather than trusting a returned hostname.
      url.hostname=endpoint.host==='::1'?'[::1]':endpoint.host;
      return {...endpoint,websocket:url.href};
    }).filter(Boolean);
  }));
  for(const result of results) if(result.status==='fulfilled') found.push(...result.value);
  return {endpoints:endpoints.length, found:[...new Map(found.map(f=>[f.websocket,f])).values()]};
}

// ---- Opt-in post-hoc Inspector activation (--activate-inspector only) ----
// Inspector activation is a real mutation of the target process (it opens a loopback listener
// and turns on debugger functionality), unlike the rest of Ember which only reads. It is never
// attempted unless the caller explicitly requests it AND selects the exact PID(s).
// Command-line substrings cannot establish repository ownership: an unrelated script may
// receive a repository path as an argument. Explicit PID selection is the authorization
// boundary; it does not claim to infer process cwd or script ownership.
function validatePid(pid) { if(!Number.isInteger(pid)||pid<=0||pid>0x7fffffff) throw new Error('Invalid PID: '+pid); return pid; }

function discoverPlainPids(root, excludePids=[], selectedPids=[]) {
  if(process.platform!=='win32') return [];
  const exclude=new Set([process.pid,...excludePids]);
  const pids=[...new Set(selectedPids.map(validatePid))];
  if(pids.length>16) throw new Error('Select at most 16 PIDs per operation');
  return pids.filter(pid=>!exclude.has(pid));
}
// Re-checked immediately before activating, to shrink the race window since the candidate list was built.
function verifyPlainNodeTarget(pid) {
  validatePid(pid);
  if(pid===process.pid) return 'SELF';
  if(process.platform!=='win32') return 'UNSUPPORTED_PLATFORM';
  const ps="$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter 'ProcessId = "+pid+"'; "+
    "if(-not $p){'MISSING'} elseif($p.Name -ne 'node.exe'){'NOT_NODE'} elseif(-not $p.CommandLine){'UNVERIFIED'} else {'OK'}";
  try { return execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',ps],{windowsHide:true,timeout:10000,encoding:'utf8',maxBuffer:16384}).trim()||'MISSING'; }
  catch { return 'QUERY_FAILED'; }
}
// Node's own documented Windows analog of POSIX SIGUSR1 (see process._debugProcess in the current
// Node Permission Model docs). The PID is passed as a separate argv entry to a fixed -e script, never
// interpolated into a shell string, so an attacker-controlled PID value cannot alter what code runs.
function activateInspectorSignal(pid) {
  validatePid(pid);
  if(pid===process.pid) return {ok:false,error:'SELF'};
  try {
    execFileSync(process.execPath,['-e','process._debugProcess(Number(process.argv[1]))',String(pid)],{windowsHide:true,timeout:5000,stdio:['ignore','ignore','ignore']});
    return {ok:true};
  } catch(e) { return {ok:false,error:e.message}; }
}
// Returns ALL loopback listeners currently owned by pid -- a plain Node target commonly already has
// its own loopback listeners (e.g. an HTTP server) before activation, so "any listener appeared" is
// not sufficient; only a port that is NEW relative to a pre-activation snapshot can be the debug port.
function queryListenersForPid(pid) {
  validatePid(pid);
  const ps="Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -eq "+pid+" -and ($_.LocalAddress -eq '127.0.0.1' -or $_.LocalAddress -eq '::1') } | Select-Object LocalAddress,LocalPort | ConvertTo-Json -Compress";
  const output=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',ps],{windowsHide:true,timeout:10000,encoding:'utf8',maxBuffer:65536}).trim();
  if(!output) return [];
  const parsed=JSON.parse(output), rows=Array.isArray(parsed)?parsed:[parsed];
  return rows.map(row=>({host:row.LocalAddress,port:row.LocalPort}));
}
// Bounded poll only; never waits indefinitely. The shared default Inspector port (9229) means only
// one plain-target activation can succeed at a time on this machine — a losing process reports here
// as ACTIVATION_FAILED (port busy) rather than a false success.
async function pollNewListener(pid,beforePorts,timeoutMs=5000,intervalMs=300) {
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline) {
    const fresh=queryListenersForPid(pid).find(l=>!beforePorts.has(l.port));
    if(fresh) return fresh;
    await new Promise(r=>setTimeout(r,intervalMs));
  }
  return null;
}
async function activatePlainTargets(root,excludePids,selectedPids=[],onActivate=()=>{}) {
  const pids=discoverPlainPids(root,excludePids,selectedPids), activated=[], failures=[];
  for(const pid of pids) {
    const status=verifyPlainNodeTarget(pid);
    if(status!=='OK') { failures.push({pid,reason:'ACTIVATION_SKIPPED_'+status}); continue; }
    const beforePorts=new Set(queryListenersForPid(pid).map(l=>l.port));
    const recheck=verifyPlainNodeTarget(pid);
    if(recheck!=='OK') { failures.push({pid,reason:'ACTIVATION_SKIPPED_'+recheck}); continue; }
    onActivate(pid);
    const signal=activateInspectorSignal(pid);
    if(!signal.ok) { failures.push({pid,reason:'ACTIVATION_FAILED: '+signal.error}); continue; }
    const listener=await pollNewListener(pid,beforePorts);
    if(!listener) { failures.push({pid,reason:'ACTIVATION_FAILED: inspector endpoint did not appear (port may be busy)'}); continue; }
    let entries;
    try { entries=await jsonList(listener); } catch(e) { failures.push({pid,reason:'ACTIVATION_FAILED: '+e.message}); continue; }
    const entry=entries.find(e=>e.type==='node'&&e.webSocketDebuggerUrl);
    if(!entry) { failures.push({pid,reason:'ACTIVATION_FAILED: endpoint is not a node inspector'}); continue; }
    const url=new URL(entry.webSocketDebuggerUrl);
    if(url.protocol!=='ws:'||!['127.0.0.1','[::1]','localhost'].includes(url.hostname)||Number(url.port)!==listener.port) { failures.push({pid,reason:'ACTIVATION_FAILED: endpoint validation failed'}); continue; }
    url.hostname=listener.host==='::1'?'[::1]':listener.host;
    activated.push({pid,port:listener.port,host:listener.host,websocket:url.href});
  }
  return {activated,failures};
}

class Inspector {
  constructor(url) { this.socket=new WebSocket(url);this.nextId=0;this.pending=new Map();this.scripts=new Map();this.methods=[];
    this.socket.addEventListener('message',event=>{
      let row;try{row=JSON.parse(event.data)}catch{return}
      if(row.method==='Debugger.scriptParsed') this.scripts.set(row.params.scriptId,row.params);
      if(row.id&&this.pending.has(row.id)) { const p=this.pending.get(row.id);clearTimeout(p.timer);this.pending.delete(row.id);row.error?p.reject(new Error(row.error.message)):p.resolve(row.result); }
    });
    this.socket.addEventListener('close',()=>{for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('Inspector disconnected'));}this.pending.clear();});
    this.socket.addEventListener('error',()=>{});
  }
  async open() {
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Inspector connection timeout')),3000);
      this.socket.addEventListener('open',()=>{clearTimeout(timer);resolve()},{once:true});
      this.socket.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('Inspector connection failed'))},{once:true});
    });
  }
  request(method,params={}) {
    if(!ALLOWED_METHODS.has(method)) throw new Error('Unsupported inspector operation');
    this.methods.push(method);
    return new Promise((resolve,reject)=>{
      const id=++this.nextId,timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(method+' timed out'))},4000);
      this.pending.set(id,{resolve,reject,timer});this.socket.send(JSON.stringify({id,method,params}));
    });
  }
  async close() {
    if(this.socket.readyState===WebSocket.OPEN) {try{await this.request('Debugger.disable')}catch{} this.socket.close();}
    else this.socket.close();
  }
}

function gitView(root) {
  return {
    head:new Set(git(root,['ls-tree','-r','-z','--name-only','HEAD']).toString('utf8').split('\0').filter(Boolean)),
    index:new Set(git(root,['ls-files','-z']).toString('utf8').split('\0').filter(Boolean)),
  };
}
function gitVersion(root,relative,ref,knownPaths) {
  if(!knownPaths.has(relative)) return {state:'ABSENT',text:null};
  try { return {state:'AVAILABLE',text:git(root,['show',ref+':'+relative]).toString('utf8')}; }
  catch(e) { return {state:'ERROR',text:null}; }
}
function classify(source,disk,head,index) {
  if(disk.state==='ERROR') return 'DISK_UNREADABLE';
  if(source===disk.text) return 'IN_SYNC';
  if(source===head.text) return 'HEAD_SURVIVES';
  if(source===index.text) return 'INDEX_SURVIVES';
  if(head.state==='ERROR'||index.state==='ERROR') return 'DIFFERS_FROM_DISK_GIT_UNKNOWN';
  return disk.state==='MISSING'?'MISSING_ON_DISK':'MEMORY_ONLY_VS_DISK_HEAD_INDEX';
}
async function inspectTarget(root,target,view=gitView(root)) {
  const client=new Inspector(target.websocket),rows=[],errors=[];
  try {
    await client.open();
    await client.request('Debugger.enable',{maxScriptsCacheSize:32*1024*1024});
    // Existing scriptParsed events precede the enable response in CDP. Later loads
    // are outside this bounded snapshot; this is not an atomic process snapshot.
    const scripts=[...client.scripts.values()];
    for(const script of scripts) {
      const file=fileForScript(root,script.url); if(!file) continue;
      if(script.length>MAX_SOURCE){errors.push({path:file.relative,reason:'SOURCE_TOO_LARGE'});continue;}
      try {
        const {scriptSource:source}=await client.request('Debugger.getScriptSource',{scriptId:script.scriptId});
        if(typeof source!=='string'||Buffer.byteLength(source)>MAX_SOURCE) throw new Error('SOURCE_UNAVAILABLE_OR_TOO_LARGE');
        let disk;
        try{disk={state:'AVAILABLE',text:fs.readFileSync(file.target,'utf8')}}catch(e){disk={state:e.code==='ENOENT'?'MISSING':'ERROR',text:null};}
        const head=gitVersion(root,file.relative,'HEAD',view.head),index=gitVersion(root,file.relative,'',view.index);
        const status=classify(source,disk,head,index);
        rows.push({pid:target.pid,scriptId:script.scriptId,path:file.relative,status,sourceSha256:HASH(source),diskSha256:disk.text===null?null:HASH(disk.text),headSha256:head.text===null?null:HASH(head.text),indexSha256:index.text===null?null:HASH(index.text),diskState:disk.state,headState:head.state,indexState:index.state,characters:source.length,source});
      }catch(e){errors.push({path:file.relative,reason:e.message});}
    }
  } finally { await client.close(); }
  return {pid:target.pid,rows,errors,methods:[...new Set(client.methods)]};
}
function recoveryBase(root,outputDir=os.tmpdir()) {
  const base=fs.realpathSync(outputDir);
  if(!fs.statSync(base).isDirectory()) throw new Error('--output must name an existing directory');
  for(const protectedRoot of [root,fs.realpathSync(__dirname)]) {
    if(path.relative(protectedRoot,base)===''||inside(protectedRoot,base)) throw new Error('Recovery output must be outside the target repository and tool directory');
  }
  return base;
}
function saveRecovery(report,withSource,outputDir) {
  const base=recoveryBase(report.root,outputDir);
  // Owned fresh directory, opaque filenames, exclusive writes. Never reconstruct
  // original paths or overwrite a working-tree file from a debugger URL.
  const output=fs.mkdtempSync(path.join(base,'ember-'));
  const saved=[];
  for(const row of withSource) {
    if(row.status==='IN_SYNC'||row.status==='DISK_UNREADABLE') continue;
    const filename=crypto.randomUUID()+'.js';
    fs.writeFileSync(path.join(output,filename),row.source,{encoding:'utf8',flag:'wx'});
    if(HASH(fs.readFileSync(path.join(output,filename)))!==row.sourceSha256) throw new Error('Recovery verification failed');
    saved.push({pid:row.pid,scriptId:row.scriptId,path:row.path,filename,sha256:row.sourceSha256,status:row.status});
  }
  fs.writeFileSync(path.join(output,'manifest.json'),JSON.stringify({...report,saved},null,2),{flag:'wx'});
  return {output,saved};
}
async function run({cwd=process.cwd(),rescue=false,discovered,activateInspector=false,selectedPids,onActivate,outputDir}={}) {
  if(selectedPids!==undefined) {
    selectedPids=[...new Set(selectedPids.map(validatePid))];
    if(!selectedPids.length||selectedPids.length>16||selectedPids.includes(process.pid)) throw new Error('Select 1 to 16 non-self PIDs');
  }
  if(activateInspector&&!selectedPids?.length) throw new Error('--activate-inspector requires explicit --pid PID selection');
  const root=fs.realpathSync(repoRoot(cwd)),startedAt=new Date().toISOString();
  if(rescue) recoveryBase(root,outputDir); // Reject unsafe destinations before discovery/activation.
  const discoveredTargets=discovered??await targets(selectedPids);
  const discovery={...discoveredTargets,found:discoveredTargets.found.filter(f=>f.pid!==process.pid&&(!selectedPids||selectedPids.includes(f.pid)))};
  let activation={requested:activateInspector,selectedPids:selectedPids??[],activatedPids:[],failed:[]};
  if(activateInspector) {
    const already=new Set(discovery.found.map(f=>f.pid));
    const result=await activatePlainTargets(root,already,selectedPids,onActivate);
    activation={requested:true,selectedPids,activatedPids:result.activated.map(a=>a.pid),failed:result.failures};
    const known=new Set(discovery.found.map(f=>f.pid));
    for(const a of result.activated) if(!known.has(a.pid)) { discovery.found.push(a); known.add(a.pid); }
  }
  const inspections=[],failures=[...activation.failed],view=gitView(root);
  for(const target of discovery.found) {
    try{inspections.push(await inspectTarget(root,target,view));}catch(e){failures.push({pid:target.pid,reason:e.message});}
  }
  const sources=inspections.flatMap(i=>i.rows),rows=sources.map(({source,...row})=>row);
  const report={name:'Ember',startedAt,finishedAt:new Date().toISOString(),root,head:git(root,['rev-parse','HEAD']).toString().trim(),endpointsProbed:discovery.endpoints,inspectors:discovery.found.length,activation,processes:inspections.map(({rows,...rest})=>rest),failures,rows,summary:{loaded:rows.length,inSync:rows.filter(r=>r.status==='IN_SYNC').length,rescueCandidates:rows.filter(r=>!['IN_SYNC','DISK_UNREADABLE'].includes(r.status)).length},limits:['V8 source text; not original byte encoding or a complete runnable project','Automatic discovery uses --inspect command lines; explicit PID selection also finds already-enabled inspectors without that flag','No source maps, data files, native code, workers, unloaded scripts, or full-history absence proof','Debugger enable/disable may add overhead; no pause, evaluation, reload, or source edits','Non-atomic observation; source URL is supplied by V8 and is not authenticated provenance','Activation inherits target Inspector settings and leaves its listener enabled; Ember connects only to observed loopback endpoints; default port 9229 may conflict']};
  if(rescue) report.recovery=saveRecovery(report,sources,outputDir);
  return report;
}
function textReport(report) {
  const lines=['EMBER — source still alive',`${report.inspectors} inspector(s); ${report.summary.loaded} repository scripts; ${report.summary.inSync} match disk; ${report.summary.rescueCandidates} rescue candidate(s).`];
  for(const row of report.rows.filter(r=>r.status!=='IN_SYNC')) lines.push(`  ${row.status}  PID ${row.pid}  ${row.path}`);
  if(report.activation&&report.activation.requested&&report.activation.activatedPids.length) lines.push(`ACTIVATES_INSPECTOR_ON_TARGET: opened the V8 Inspector on ${report.activation.activatedPids.length} process(es) that were not started with --inspect (PID ${report.activation.activatedPids.join(', ')}).`);
  if(report.activation) for(const f of report.activation.failed) lines.push(`  ACTIVATION_FAILED  PID ${f.pid}  ${f.reason}`);
  if(!report.inspectors) lines.push(report.activation&&report.activation.requested?'No enabled inspector found or activated.':'No enabled inspector found. Start your Node app with: node --inspect=127.0.0.1:0 app.js, or select its PID with --pid PID --activate-inspector.');
  if(report.inspectors&&!report.summary.loaded) lines.push('No supported scripts found inside the current Git repository.');
  if(report.recovery) lines.push(`Recovered ${report.recovery.saved.length} source(s): ${report.recovery.output}`);
  else if(report.summary.rescueCandidates) lines.push('Rescue without overwriting: node path/to/ember.cjs rescue --pid PID');
  if(report.failures.length||report.processes.some(p=>p.errors.length)) lines.push('PARTIAL: one or more sources/inspectors could not be read. Use --json for details.');
  lines.push('Memory-only means different from disk, HEAD and index; older history may still contain it.');
  return lines.join('\n');
}
async function main() {
  const args=process.argv.slice(2);
  if(args.includes('--help')) {console.log('Ember: recover overwritten JavaScript from a live Node process.\n\nnode ember.cjs [scan|rescue] [--json] [--pid PID] [--activate-inspector] [--output DIR]\n\nRun inside the target Git repository. Requires Windows, Git, Node 22+.\n--pid may be repeated and restricts discovery before endpoint probing.\n--activate-inspector REQUIRES --pid: it mutates exactly the selected Node\nprocess(es). PID selection is user authorization, not proof of repo ownership.\nRelative script paths work with explicit PID selection.\nrescue writes a fresh ember-* directory under the OS temp directory.\n--output selects an existing parent outside the target repository and tool directory.\nKeep rescued files in a durable private location; OS temp may be cleaned.');return;}
  const flags=[],selectedPids=[];
  let outputDir;
  for(let i=0;i<args.length;i++) {
    if(args[i]==='--pid') {
      if(!/^\d+$/.test(args[++i]??'')) throw new Error('--pid requires a positive integer');
      selectedPids.push(validatePid(Number(args[i])));
    } else if(args[i]==='--output') {
      if(outputDir!==undefined||!args[i+1]||args[i+1].startsWith('--')) throw new Error('--output requires one directory');
      outputDir=args[++i];
    } else flags.push(args[i]);
  }
  if(flags.some(a=>!['scan','rescue','--json','--activate-inspector'].includes(a))||flags.filter(a=>['scan','rescue'].includes(a)).length>1||(outputDir!==undefined&&!flags.includes('rescue'))) throw new Error('Usage: node ember.cjs [scan|rescue] [--json] [--pid PID] [--activate-inspector] [--output DIR (rescue only)]');
  const report=await run({rescue:flags.includes('rescue'),activateInspector:flags.includes('--activate-inspector'),selectedPids:selectedPids.length?selectedPids:undefined,outputDir,onActivate:pid=>console.error('ACTIVATING_INSPECTOR PID '+pid+' (node.exe; explicitly selected)')});
  console.log(flags.includes('--json')?JSON.stringify(report,null,2):textReport(report));
  if(report.failures.length||report.processes.some(p=>p.errors.length)) process.exitCode=2;
}
module.exports={run,targets,inspectTarget,classify,fileForScript,inside,HASH,Inspector,textReport,verifyPlainNodeTarget,activateInspectorSignal,pollNewListener,queryListenersForPid,discoverPlainPids,activatePlainTargets,saveRecovery,recoveryBase};
if(require.main===module) main().catch(e=>{console.error('Ember: '+e.message);process.exitCode=1});
