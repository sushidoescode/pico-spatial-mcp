import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {canonicalIdentity,canonicalJson,collectGradleInputIdentity,collectGuardedGradleInputIdentity} from "./runreceiptidentity.js";
import {runPicoCliCommand,type PicoCliCommandResult} from "./picocli.js";
import {gradleEnv} from "./toolchain.js";
import type {IterationSnapshot} from "./interactionsession.js";

const policyPath=fileURLToPath(new URL("../data/iteration-fixture/build-policy.json",import.meta.url));
const digest=(bytes:Buffer|string)=>crypto.createHash("sha256").update(bytes).digest("hex");
function fileGeneration(file:string):string {
  const stat=fs.lstatSync(file,{bigint:true});
  if(stat.isSymbolicLink())throw new Error(`symbolic build input is unsupported: ${file}`);
  return [stat.dev,stat.ino,stat.mode,stat.nlink,stat.size,stat.mtimeNs,stat.ctimeNs,stat.birthtimeNs].join(":");
}
export function hashBuildFile(file:string,check:()=>void=()=>{}):string {
  check();
  const stat=fs.statSync(file),generation=fileGeneration(file);
  if(!stat.isFile()||stat.size>1024*1024*1024)throw new Error("build input must be a bounded regular file");
  const fd=fs.openSync(file,"r"),hash=crypto.createHash("sha256"),buffer=Buffer.alloc(Math.max(1,Math.min(stat.size,1024*1024)));
  try {let n;while((n=fs.readSync(fd,buffer,0,buffer.length,null))>0){check();hash.update(buffer.subarray(0,n));}}
  finally {fs.closeSync(fd);}
  if(generation!==fileGeneration(file))throw new Error("build input changed during hashing");
  return hash.digest("hex");
}

/** Intentionally restricted to the reviewed single-module fixture. This does not expand V1 receipts. */
export function collectFixtureInputs(projectDir:string,check:()=>void=()=>{}):IterationSnapshot {
  check();
  const root=fs.realpathSync(projectDir);
  const policy=JSON.parse(fs.readFileSync(policyPath,"utf8")) as {schemaVersion:number;files:Record<string,string>};
  if(policy.schemaVersion!==1)throw new Error("fixture build policy unavailable");
  for(const [relative,expected] of Object.entries(policy.files)) {
    const file=path.join(root,relative);
    if(fs.lstatSync(file).isSymbolicLink()||hashBuildFile(file,check)!==expected)throw new Error(`unsupported fixture build script/input: ${relative}; external modules require Stage 2 provenance`);
  }
  for(const forbidden of ["buildSrc","settings.gradle","build.gradle","app/build.gradle","init.gradle","init.gradle.kts",".gradle-user-home/gradle.properties",".gradle-user-home/init.gradle",".gradle-user-home/init.gradle.kts",".gradle-user-home/init.d"])
    if(fs.existsSync(path.join(root,forbidden)))throw new Error(`unsupported input closure: ${forbidden}`);
  const cache=path.join(root,".gradle-user-home");
  if(fs.existsSync(cache)&&fs.realpathSync(cache)!==cache)throw new Error("Gradle user home must remain inside this fixture");
  const inputs=collectGradleInputIdentity(root);
  for(const entry of inputs.entries) {
    if(!entry.path.startsWith("app/src/")&&!Object.hasOwn(policy.files,entry.path))throw new Error(`unsupported build input outside sealed fixture policy: ${entry.path}`);
  }
  const local=path.join(root,"local.properties");
  const localProperties=fs.existsSync(local)?{path:local,sha256:hashBuildFile(local,check)}:null;
  const identity={scope:"dedicated-fixture-authored-inputs",policySha256:digest(fs.readFileSync(policyPath)),inputs,localProperties};
  return {...identity,sha256:canonicalIdentity(identity).sha256,complete:true};
}

type InputRecord={path:string;sha256:string};
type DirectoryIdentity={generation:string;members:string[]};
const maxResolvedReportBytes=16*1024*1024;
function prepareFreshResolvedReport(file:string,retainedPath:string,check:()=>void):string|null {
  check();
  if(fs.realpathSync(path.dirname(file))!==path.dirname(file))throw new Error("resolved report parent must remain inside the canonical fixture build directory");
  let stat:fs.Stats;
  try {stat=fs.lstatSync(file);}catch(e:any){if(e.code==="ENOENT")return null;throw e;}
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>maxResolvedReportBytes)throw new Error("previous resolved input report must be a bounded regular file");
  const generation=fileGeneration(file),sha256=hashBuildFile(file,check);
  fs.copyFileSync(file,retainedPath,fs.constants.COPYFILE_EXCL);
  if(hashBuildFile(retainedPath,check)!==sha256||fileGeneration(file)!==generation)throw new Error("resolved report changed while retaining previous output");
  check();
  // Preserve the old bytes, then require this invocation to create its output. Filesystem
  // timestamps can trail Date.now() even for a new write; freshness is causal, not a clock test.
  fs.unlinkSync(file);
  return generation;
}
function directoryIdentity(directory:string):DirectoryIdentity {
  const generation=fileGeneration(directory);
  if(!fs.lstatSync(directory).isDirectory())throw new Error(`build input parent is not a directory: ${directory}`);
  const members=fs.readdirSync(directory).sort();
  if(generation!==fileGeneration(directory))throw new Error(`build input parent changed during collection: ${directory}`);
  return {generation,members};
}
function scanDirectory(root:string,check:()=>void):Map<string,DirectoryIdentity> {
  const directories=new Map<string,DirectoryIdentity>(),pending=[root];let entries=0;
  while(pending.length) {
    check();
    const directory=pending.pop()!;
    if(directories.size>20_000)throw new Error("resolved directory closure exceeds bound");
    if(fs.realpathSync(directory)!==directory)throw new Error(`symbolic resolved directory is unsupported: ${directory}`);
    const identity=directoryIdentity(directory);directories.set(directory,identity);
    for(const name of identity.members) {
      check();if(++entries>20_000)throw new Error("resolved directory entry closure exceeds bound");
      const child=path.join(directory,name),stat=fs.lstatSync(child);
      if(stat.isSymbolicLink()||(!stat.isFile()&&!stat.isDirectory()))throw new Error(`unsupported resolved input entry: ${child}`);
      if(stat.isDirectory())pending.push(child);
    }
    if(fileGeneration(directory)!==identity.generation)throw new Error(`resolved directory changed while collecting: ${directory}`);
  }
  return directories;
}
async function validateResolvedInputs(file:string,projectDir:string,check:()=>void) {
  check();
  if(fs.statSync(file).size>maxResolvedReportBytes)throw new Error("resolved input report exceeds size limit");
  const reportGeneration=fileGeneration(file);
  const bytes=fs.readFileSync(file),report=JSON.parse(bytes.toString("utf8"));
  if(reportGeneration!==fileGeneration(file))throw new Error("resolved report changed while reading");
  if(report.schemaVersion!==1||report.variant!=="debug"||report.packageName!=="com.example.picofixture.iteration.debug")throw new Error("wrong fixture resolved-input report");
  const arrays=["dependencies","androidBootClasspath","buildClasspath","compilerClasspath"];
  const records:InputRecord[]=[];
  const directories=new Map<string,DirectoryIdentity>();
  for(const key of arrays) {
    if(!Array.isArray(report[key])||report[key].length===0)throw new Error(`resolved input closure incomplete: ${key}`);
    records.push(...report[key]);
  }
  for(const key of ["gradleInstallation","androidBuildTools","javaInstallation","androidPlatform"]) {
    if(!report[key]?.root||!Array.isArray(report[key].files)||report[key].files.length===0)throw new Error(`resolved input closure incomplete: ${key}`);
    const root=report[key].root;
    if(typeof root!=="string"||!path.isAbsolute(root))throw new Error(`invalid resolved input directory: ${key}`);
    const scanned=scanDirectory(root,check);
    const actual:string[]=[];
    for(const [directory,identity] of scanned) {
      directories.set(directory,identity);
      for(const name of identity.members) {
        const child=path.join(directory,name);
        if(fs.lstatSync(child).isFile())actual.push(child);
      }
    }
    if(canonicalJson(actual.sort())!==canonicalJson(report[key].files.map((entry:InputRecord)=>entry.path).sort()))throw new Error(`resolved directory file set differs: ${key}`);
    records.push(...report[key].files);
  }
  for(const key of ["javaExecutable","javaModules"]) {
    if(!report.toolchain?.[key])throw new Error(`missing toolchain identity: ${key}`);
    records.push(report.toolchain[key]);
  }
  if(!report.debugSigningKey)throw new Error("debug signing input identity absent");
  records.push(report.debugSigningKey);
  if(records.length>20_000)throw new Error("resolved input closure exceeds bound");
  const unique=new Map<string,string>();
  for(const entry of records) {
    if(typeof entry.path!=="string"||!path.isAbsolute(entry.path)||!/^[a-f0-9]{64}$/.test(entry.sha256))throw new Error("invalid resolved input identity");
    if(unique.has(entry.path)&&unique.get(entry.path)!==entry.sha256)throw new Error("conflicting resolved input hashes");
    unique.set(entry.path,entry.sha256);
  }
  const generations=new Map<string,string>();let index=0;
  for(const [file,sha] of unique) {
    check();
    if(fs.realpathSync(file)!==file)throw new Error(`non-canonical resolved input: ${file}`);
    const parent=path.dirname(file);
    if(!directories.has(parent))directories.set(parent,directoryIdentity(parent));
    const generation=fileGeneration(file);
    if(hashBuildFile(file,check)!==sha||fileGeneration(file)!==generation)throw new Error(`resolved build input changed: ${file}`);
    generations.set(file,generation);
    if(++index%64===0)await new Promise<void>(resolve=>setImmediate(resolve));
  }
  const expectedApk=path.join(fs.realpathSync(projectDir),"app/build/outputs/apk/debug/app-debug.apk");
  if(report.apkPath!==expectedApk)throw new Error("APK output path differs from the bounded fixture");
  for(const [directory,identity] of directories)if(canonicalJson(directoryIdentity(directory))!==canonicalJson(identity))throw new Error(`resolved input parent moved during collection: ${directory}`);
  return {report,bytes,reportSha256:digest(bytes),resolvedInputCount:unique.size,unique,generations,directories};
}

type ResolvedInputs=Awaited<ReturnType<typeof validateResolvedInputs>>;
async function assertResolvedContinuity(resolved:ResolvedInputs,check:()=>void):Promise<void> {
  let index=0;
  for(const [file,expected] of resolved.generations) {
    check();
    if(fileGeneration(file)!==expected||hashBuildFile(file,check)!==resolved.unique.get(file))throw new Error(`resolved build input generation changed: ${file}`);
    if(++index%64===0)await new Promise<void>(resolve=>setImmediate(resolve));
  }
  for(const [directory,expected] of resolved.directories) {
    check();
    if(canonicalJson(directoryIdentity(directory))!==canonicalJson(expected))throw new Error(`resolved build input parent generation/membership changed: ${directory}`);
  }
}

function fixtureBuildEnvironment(projectDir:string):NodeJS.ProcessEnv {
  for(const key of Object.keys(process.env))if(/^(?:JAVA_OPTS|GRADLE_OPTS|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|ORG_GRADLE_PROJECT_.*)$/i.test(key))throw new Error(`uncontrolled Gradle/JVM environment input: ${key}`);
  const selected:NodeJS.ProcessEnv={};
  for(const key of ["HOME","USERPROFILE","SystemRoot","WINDIR","ComSpec","PATHEXT","TEMP","TMP","TMPDIR","LANG","LC_ALL"])
    if(process.env[key]!==undefined)selected[key]=process.env[key];
  const javaHome=gradleEnv().JAVA_HOME;
  if(javaHome)selected.JAVA_HOME=javaHome;
  // No ambient PATH wrappers, preload libraries, Android overrides or model/host variables reach Gradle.
  const systemPaths=process.platform==="win32"
    ? [path.join(process.env.SystemRoot??"C:\\Windows","System32"),process.env.SystemRoot??"C:\\Windows"]
    : ["/usr/bin","/bin","/usr/sbin","/sbin"];
  selected.PATH=[...(javaHome?[path.join(javaHome,"bin")]:[]),...systemPaths].join(path.delimiter);
  selected.GRADLE_USER_HOME=path.join(projectDir,".gradle-user-home");
  return selected;
}

// This project scope complements the target/session fence. It excludes concurrent calls to this
// adapter, including standalone builds; legacy/manual writers remain detectable, not fenced.
// Like interactionfence/runlocks, exclusive ownership never transfers by expiry or process death.
function acquireProjectBuildOwner(projectDir:string,attempt:string) {
  const recordPath=path.join(projectDir,".gradle-user-home","pico-iteration-build.owner.json");
  const owner={schemaVersion:1,projectDir,token:crypto.randomUUID(),pid:process.pid,
    processIdentity:`node:${process.pid}:${performance.timeOrigin}`,scope:"interaction-fixture-build-only",createdAt:new Date().toISOString()};
  const bytes=canonicalJson(owner);
  let fd:number;
  try {fd=fs.openSync(recordPath,"wx",0o600);}
  catch(e:any){if(e.code==="EEXIST")throw new Error("fixture project is owned/busy; elapsed time or a dead process never transfers build ownership");throw e;}
  try {fs.writeSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  const generation=fileGeneration(recordPath);
  fs.writeFileSync(path.join(attempt,"project-owner.json"),bytes,{flag:"wx",mode:0o600});
  let released=false;
  const assertOwned=()=>{
    if(released||fileGeneration(recordPath)!==generation||fs.readFileSync(recordPath,"utf8")!==bytes)throw new Error("fixture project build ownership changed");
  };
  return {recordPath,token:owner.token,assertOwned,get released(){return released;},release(){
    assertOwned();
    const stopped=fs.openSync(path.join(attempt,"project-owner-release.json"),"wx",0o600);
    try{fs.writeSync(stopped,canonicalJson({...owner,state:"stopped/drained",releasedAt:new Date().toISOString()}));fs.fsyncSync(stopped);}finally{fs.closeSync(stopped);}
    assertOwned();fs.unlinkSync(recordPath);released=true;
  }};
}

export interface FixtureBuildOptions {
  projectDir:string;evidenceRoot:string;gradleExecutable?:string;timeoutMs?:number;signal?:AbortSignal;
  runBuild?:typeof runPicoCliCommand;
}
export async function buildIterationFixture(options:FixtureBuildOptions) {
  const attempt=path.join(options.evidenceRoot,`build-${crypto.randomUUID()}`);
  fs.mkdirSync(attempt,{recursive:true,mode:0o700});
  const recordPath=path.join(attempt,"build.json");
  const phases:Array<{name:string;argv:string[];startedAt:number;finishedAt:number}>=[];
  let processResult:PicoCliCommandResult|null=null;
  let owner:ReturnType<typeof acquireProjectBuildOwner>|undefined;
  let processUncertain=false;
  const ownership=()=>owner?{path:owner.recordPath,token:owner.token,state:owner.released?"released":"held",scope:"interaction-fixture-build-only"}:null;
  const failure=(reason:string)=>{
    const result={status:"failed" as const,reason,recordPath,processResult,phases,ownership:ownership()};
    fs.writeFileSync(recordPath,`${canonicalJson(result)}\n`,{flag:"wx",mode:0o600});return result;
  };
  let guard:ReturnType<typeof collectGuardedGradleInputIdentity>["guard"]|undefined;
  let configWatcher:fs.FSWatcher|undefined;
  let localConfigWatcher:fs.FSWatcher|undefined;
  try {
    const timeoutMs=options.timeoutMs??10*60_000;
    if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>15*60_000)throw new Error("build bound must be 1..900 seconds");
    const deadline=performance.now()+timeoutMs;
    const check=()=>{
      if(options.signal?.aborted)throw new Error("build cancelled; no deployment allowed");
      if(performance.now()>=deadline)throw new Error("overall build deadline elapsed; no deployment allowed");
    };
    check();
    const root=fs.realpathSync(options.projectDir);
    const gradle=options.gradleExecutable;
    if(!gradle||!path.isAbsolute(gradle))throw new Error("an explicit existing absolute Gradle executable is required; wrapper bootstrap is not allowed");
    if(!fs.statSync(gradle).isFile())throw new Error("Gradle executable must be an existing regular file");
    if(process.platform!=="win32")fs.accessSync(gradle,fs.constants.X_OK);
    const executableGeneration=fileGeneration(gradle),executableSha256=hashBuildFile(gradle,check);
    const sealedPolicy=JSON.parse(fs.readFileSync(policyPath,"utf8")) as {files:Record<string,string>};
    if([sealedPolicy.files.gradlew,sealedPolicy.files["gradlew.bat"]].includes(executableSha256))throw new Error("Gradle wrapper executable is not allowed, including renamed copies");
    const distributionRoot=path.dirname(path.dirname(gradle));
    if(path.basename(gradle)!==(process.platform==="win32"?"gradle.bat":"gradle")||path.basename(path.dirname(gradle))!=="bin"||fs.realpathSync(gradle)!==gradle)throw new Error("an existing Gradle distribution bin/gradle launcher is required; wrappers are not allowed");
    const distributionLib=path.join(distributionRoot,"lib");
    const launchers=fs.readdirSync(distributionLib).filter(name=>/^gradle-launcher-[0-9][a-zA-Z0-9.+-]*\.jar$/.test(name));
    if(launchers.length!==1)throw new Error("Gradle distribution must have exactly one existing launcher JAR");
    const launcher=path.join(distributionLib,launchers[0]);
    const launcherGeneration=fileGeneration(launcher),launcherSha256=hashBuildFile(launcher,check);
    const gradleParent=directoryIdentity(path.dirname(gradle));
    const baseEnv=fixtureBuildEnvironment(root);
    const snapshot=collectFixtureInputs(root,check);
    fs.mkdirSync(baseEnv.GRADLE_USER_HOME!,{recursive:true});
    owner=acquireProjectBuildOwner(root,attempt);
    // Create only known generated directories before source parent watches start. A newly-created
    // output directory otherwise makes parent-generation continuity honestly inconclusive.
    for(const relative of ["app/build","build",".gradle",".kotlin"])fs.mkdirSync(path.join(root,relative),{recursive:true});
    const cacheGeneration=directoryIdentity(baseEnv.GRADLE_USER_HOME!);
    const configEvents:string[]=[];
    configWatcher=fs.watch(baseEnv.GRADLE_USER_HOME!,{persistent:false},(_event,name)=>{
      const file=name?.toString();
      if(!file||/^(?:gradle\.properties|init\.gradle(?:\.kts)?|init\.d)$/.test(file))configEvents.push(file??"unknown configuration event");
    });
    configWatcher.on("error",()=>configEvents.push("configuration watcher failed"));
    const assertConfiguration=async()=>{
      check();
      await new Promise<void>(resolve=>setTimeout(resolve,10));
      owner!.assertOwned();
      if(configEvents.length)throw new Error(`Gradle user configuration changed: ${configEvents[0]}`);
      if(canonicalJson(directoryIdentity(baseEnv.GRADLE_USER_HOME!))!==canonicalJson(cacheGeneration))throw new Error("Gradle user configuration changed: user-home parent generation/membership moved");
      if(collectFixtureInputs(root,check).sha256!==snapshot.sha256)throw new Error("authored input closure changed during build");
    };
    const guarded=collectGuardedGradleInputIdentity(root);guard=guarded.guard;
    if(canonicalJson(guarded.identity)!==canonicalJson(snapshot.inputs))throw new Error("input generation moved before build");
    const localProperties=path.join(root,"local.properties");
    const localGeneration=fs.existsSync(localProperties)?fileGeneration(localProperties):null;
    const localWatcher=fs.watch(root,{persistent:false},(_event,name)=>{if(!name||name.toString()==="local.properties")configEvents.push("local.properties");});
    localWatcher.on("error",()=>configEvents.push("local properties watcher failed"));
    localConfigWatcher=localWatcher;
    const reportFile=path.join(root,"app/build/iteration-inputs.json");
    const common=["--offline","--no-daemon","--console=plain","-Dorg.gradle.java.installations.auto-download=false","-Pandroid.builder.sdkDownload=false","-Pkotlin.compiler.execution.strategy=in-process"];
    const execute=async(name:string,task:string)=>{
      await assertConfiguration();
      const argv=[task,...common];
      const previousReportGeneration=task===":app:writeIterationInputs"
        ?prepareFreshResolvedReport(reportFile,path.join(attempt,`${name}-previous-report.json`),()=>{check();owner!.assertOwned();}):null;
      const startedAt=Date.now();
      processUncertain=true;
      const command=await (options.runBuild??runPicoCliCommand)(gradle,argv,{cwd:root,timeoutMs:Math.max(1,Math.floor(deadline-performance.now())),signal:options.signal,
        baseEnv,env:{},maxOutputBytes:1024*1024});
      processResult=command;
      processUncertain=!!(command.timedOut||command.cancelled||command.spawnError||command.code===null||command.signal!==null);
      phases.push({name,argv,startedAt,finishedAt:Date.now()});
      fs.writeFileSync(path.join(attempt,`${name}-stdout.txt`),command.stdout,{flag:"wx"});
      fs.writeFileSync(path.join(attempt,`${name}-stderr.txt`),command.stderr,{flag:"wx"});
      if(command.code!==0||command.timedOut||command.cancelled||command.spawnError||command.outputTruncated)throw new Error(`${name} failed/cancelled/incomplete; previous APK is never reused`);
      check();
      if(task===":app:writeIterationInputs"&&(!fs.existsSync(reportFile)||!fs.lstatSync(reportFile).isFile()||fileGeneration(reportFile)===previousReportGeneration))throw new Error("fresh resolved input report absent or not a new regular file");
    };
    await execute("pre-inputs",":app:writeIterationInputs");
    const before=await validateResolvedInputs(reportFile,root,check);
    if(before.report.gradleInstallation.root!==distributionRoot||before.unique.get(gradle)!==executableSha256||before.unique.get(launcher)!==launcherSha256||fileGeneration(launcher)!==launcherGeneration)throw new Error("resolved Gradle installation differs from the admitted distribution launcher");
    const beforePath=path.join(attempt,"resolved-inputs-before.json");
    fs.writeFileSync(beforePath,before.bytes,{flag:"wx",mode:0o600});
    await assertResolvedContinuity(before,check);
    await execute("assemble",":app:assembleDebug");
    // Retain immediately, before long post-report work. Both input guards remain live; nothing
    // returns a usable artifact until every later continuity check succeeds.
    const apkPath=path.join(attempt,"app-debug.apk");
    const original=before.report.apkPath;
    const apkGeneration=fileGeneration(original),apkSha256=hashBuildFile(original,check);
    fs.copyFileSync(original,apkPath,fs.constants.COPYFILE_EXCL);
    if(hashBuildFile(apkPath,check)!==apkSha256||fileGeneration(original)!==apkGeneration)throw new Error("APK changed while retaining immutable build artifact");
    const retainedGeneration=fileGeneration(apkPath);
    await assertResolvedContinuity(before,check);
    await execute("post-inputs",":app:writeIterationInputs");
    const after=await validateResolvedInputs(reportFile,root,check);
    if(canonicalJson(before.report)!==canonicalJson(after.report))throw new Error("resolved input set or identity changed across build");
    await assertResolvedContinuity(before,check);
    await assertConfiguration();
    if(fileGeneration(gradle)!==executableGeneration||hashBuildFile(gradle,check)!==executableSha256)throw new Error("Gradle executable generation changed during build");
    if(canonicalJson(directoryIdentity(path.dirname(gradle)))!==canonicalJson(gradleParent))throw new Error("Gradle executable parent generation changed during build");
    if((fs.existsSync(localProperties)?fileGeneration(localProperties):null)!==localGeneration)throw new Error("local properties generation changed during build");
    if(fileGeneration(apkPath)!==retainedGeneration||hashBuildFile(apkPath,check)!==apkSha256)throw new Error("retained APK generation changed before binding");
    const resolvedPath=path.join(attempt,"resolved-inputs.json");fs.writeFileSync(resolvedPath,after.bytes,{flag:"wx",mode:0o600});
    // assertUnchanged seals authored watchers; call it last, after retention and post-validation.
    await guard.assertUnchanged();
    check();
    owner.assertOwned();owner.release();
    const result={status:"built" as const,apkPath,apkSha256,inputSha256:snapshot.sha256,inputs:snapshot,
      bindingScope:"dedicated-fixture-source-and-reported-resolved-inputs",resolvedInputCount:before.resolvedInputCount,
      resolvedInputPath:resolvedPath,resolvedInputSha256:after.reportSha256,preResolvedInputPath:beforePath,preResolvedInputSha256:before.reportSha256,
      continuity:"pre-build-hash-and-stat-generation-through-artifact-retention",gradle:{path:gradle,sha256:executableSha256,phases},recordPath,
      packageName:before.report.packageName,hermeticBuildClaim:false,ownership:ownership()};
    fs.writeFileSync(recordPath,`${canonicalJson(result)}\n`,{flag:"wx",mode:0o600});return result;
  } catch(e:any) {
    let reason=e.message??String(e);
    if(owner&&!owner.released&&!processUncertain)try{owner.release();}catch(releaseError:any){reason+=`; owner retained: ${releaseError.message??String(releaseError)}`;}
    if(processUncertain)reason+="; project ownership retained because process drain is uncertain";
    return failure(reason);
  } finally {guard?.close();configWatcher?.close();localConfigWatcher?.close();}
}
