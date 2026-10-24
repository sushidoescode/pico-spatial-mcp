import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import * as build from '../dist/fixturebuild.js';

const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const original=fileURLToPath(new URL('../examples/agent-iteration-fixture/',import.meta.url));
const copiedPath=p=>!p.split(path.sep).some(s=>['build','.gradle','.gradle-user-home','evidence','.git'].includes(s));
const succeeded={code:0,signal:null,timedOut:false,outputTruncated:false,stdout:'fixture Gradle completed',stderr:''};
function setup(t) {
  const temporary=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'pico-fixture-binding-')));
  t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const root=path.join(temporary,'project');fs.cpSync(original,root,{recursive:true,filter:copiedPath});
  const external=path.join(temporary,'external');
  const write=(relative,bytes)=>{const file=path.join(external,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);return file;};
  const dependency=write('dependencies/library.jar','library-v1');
  const compiler=write('compiler/compiler.jar','compiler-v1');
  const signing=write('signing/debug.keystore','fixture-only-signing-identity');
  const gradle=write(`gradle/bin/${process.platform==='win32'?'gradle.bat':'gradle'}`,'fixture-executable');
  fs.chmodSync(gradle,0o755);
  write('gradle/lib/gradle-launcher-8.13.jar','fixture-launcher-code');
  const java=write('java/bin/java','java-executable');
  const modules=write('java/lib/modules','java-modules');
  const android=write('platform/android.jar','android-classes');
  write('platform/framework.aidl','android-framework');
  write('build-tools/aapt2','android-packager');
  const record=file=>({path:file,sha256:sha(fs.readFileSync(file))});
  const directory=relative=>{const root=path.join(external,relative),files=[];const scan=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())scan(file);else files.push(record(file));}};scan(root);return {root,files:files.sort((a,b)=>a.path.localeCompare(b.path))};};
  const apk=path.join(root,'app/build/outputs/apk/debug/app-debug.apk');
  const report=()=>({schemaVersion:1,variant:'debug',packageName:'com.example.picofixture.iteration.debug',
    dependencies:[{...record(dependency),coordinate:'fixture:library:1',configuration:'debugRuntimeClasspath'}],
    androidBootClasspath:[record(android)],buildClasspath:[record(gradle)],compilerClasspath:[record(compiler)],
    gradleInstallation:directory('gradle'),javaInstallation:directory('java'),androidPlatform:directory('platform'),androidBuildTools:directory('build-tools'),
    debugSigningKey:record(signing),toolchain:{javaVersion:'21-fixture',gradleVersion:'8.13',javaHome:path.dirname(path.dirname(java)),javaExecutable:record(java),javaModules:record(modules)},apkPath:apk});
  const calls=[];
  const runner=(hook=async()=>{})=>async(command,argv,options)=>{
    calls.push({command,argv,options});
    if(argv[0]===':app:writeIterationInputs') {fs.mkdirSync(path.join(root,'app/build'),{recursive:true});fs.writeFileSync(path.join(root,'app/build/iteration-inputs.json'),JSON.stringify(report()));}
    if(argv[0]===':app:assembleDebug') {fs.mkdirSync(path.dirname(apk),{recursive:true});fs.writeFileSync(apk,'new compiled APK');}
    await hook({command,argv,options,phase:calls.length});return {...succeeded};
  };
  return {temporary,root,external,dependency,compiler,gradle,apk,report,calls,runner,options:{projectDir:root,evidenceRoot:path.join(temporary,'evidence'),gradleExecutable:gradle}};
}
function assertUnusable(outcome,reason) {
  assert.equal(outcome.status,'failed',JSON.stringify(outcome));assert.equal(outcome.apkPath,undefined);assert.match(outcome.reason,reason);
  assert.equal(JSON.parse(fs.readFileSync(outcome.recordPath)).status,'failed');
}

test('source changes invalidate fixture identity while generated outputs do not; extra modules refuse',t=>{
  const {root}=setup(t),first=build.collectFixtureInputs(root);assert.equal(first.complete,true);
  fs.mkdirSync(path.join(root,'app/build'),{recursive:true});fs.writeFileSync(path.join(root,'app/build/generated.txt'),'ignored');
  assert.equal(build.collectFixtureInputs(root).sha256,first.sha256);
  fs.writeFileSync(path.join(root,'app/src/main/java/com/example/picofixture/iteration/IterationLabel.kt'),'package com.example.picofixture.iteration\nconst val iterationLabel="second build"\n');
  assert.notEqual(build.collectFixtureInputs(root).sha256,first.sha256);
  fs.appendFileSync(path.join(root,'settings.gradle.kts'),'\ninclude(":outside")\n');
  assert.throws(()=>build.collectFixtureInputs(root),/unsupported|policy|script|closure/);
});
test('failed fixture build retains failure and never returns stale APK bytes',async t=>{
  const f=setup(t);fs.mkdirSync(path.dirname(f.apk),{recursive:true});fs.writeFileSync(f.apk,'old apk');
  const outcome=await build.buildIterationFixture({...f.options,runBuild:async()=>({...succeeded,code:1,stderr:'compile failed'})});
  assertUnusable(outcome,/failed/);
});
test('omitted or non-executable Gradle paths refuse without wrapper bootstrap',async t=>{
  const f=setup(t);let calls=0;
  const runBuild=async()=>{calls++;return succeeded;};
  const omitted=await build.buildIterationFixture({...f.options,gradleExecutable:undefined,runBuild});
  assertUnusable(omitted,/explicit existing absolute Gradle executable/);
  if(process.platform!=='win32'){
    fs.chmodSync(f.gradle,0o644);
    const notExecutable=await build.buildIterationFixture({...f.options,runBuild});assertUnusable(notExecutable,/EACCES|permission/);
  }
  assert.equal(calls,0);
});
test('project wrappers and renamed wrapper copies refuse before any spawn',async t=>{
  const f=setup(t);let calls=0;const runBuild=async()=>{calls++;return succeeded;};
  const wrapper=path.join(f.root,process.platform==='win32'?'gradlew.bat':'gradlew');
  const named=await build.buildIterationFixture({...f.options,gradleExecutable:wrapper,runBuild});assertUnusable(named,/wrapper executable is not allowed/);
  fs.copyFileSync(wrapper,f.gradle);fs.chmodSync(f.gradle,0o755);
  const renamed=await build.buildIterationFixture({...f.options,runBuild});assertUnusable(renamed,/wrapper executable is not allowed/);
  assert.equal(calls,0);
});
test('build pins resolved inputs before compilation and retains APK before post-report work',async t=>{
  const f=setup(t),key='PICO_FIXTURE_UNCONTROLLED_ENV',previous=process.env[key];process.env[key]='must not reach Gradle';
  try {
    const outcome=await build.buildIterationFixture({...f.options,runBuild:f.runner(async({phase,options})=>{
      assert.equal(options.baseEnv[key],undefined);assert.equal(options.env[key],undefined);
      assert.equal(options.baseEnv.GRADLE_USER_HOME,path.join(f.root,'.gradle-user-home'));
      assert.equal(options.baseEnv.PICO_ADB,undefined);
      if(phase===3){const attempt=fs.readdirSync(f.options.evidenceRoot)[0];assert.equal(fs.readFileSync(path.join(f.options.evidenceRoot,attempt,'app-debug.apk'),'utf8'),'new compiled APK');}
    })});
    assert.equal(outcome.status,'built',JSON.stringify(outcome));assert.equal(outcome.hermeticBuildClaim,false);
    assert.deepEqual(f.calls.map(c=>c.argv[0]),[':app:writeIterationInputs',':app:assembleDebug',':app:writeIterationInputs']);
    assert.ok(f.calls.every(c=>c.argv.includes('--offline')&&c.argv.includes('--no-daemon')));
    assert.equal(outcome.preResolvedInputSha256,outcome.resolvedInputSha256);
    fs.writeFileSync(f.apk,'later build output');assert.equal(fs.readFileSync(outcome.apkPath,'utf8'),'new compiled APK');
  } finally {if(previous===undefined)delete process.env[key];else process.env[key]=previous;}
});
test('new reports remain fresh when filesystem timestamps trail the phase clock; previous bytes are retained',async t=>{
  const f=setup(t),file=path.join(f.root,'app/build/iteration-inputs.json'),previous=Buffer.from('previous generated report bytes');
  fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,previous);
  const observed=[];
  const outcome=await build.buildIterationFixture({...f.options,runBuild:f.runner(async({argv})=>{
    if(argv[0]!==':app:writeIterationInputs')return;
    const older=new Date(Date.now()-1000);fs.utimesSync(file,older,older);
    observed.push({mtimeMs:fs.statSync(file).mtimeMs,bytes:fs.readFileSync(file)});
  })});
  assert.equal(outcome.status,'built',JSON.stringify(outcome));
  const reportPhases=outcome.gradle.phases.filter(phase=>phase.argv[0]===':app:writeIterationInputs');
  assert.equal(observed.length,2);
  for(let index=0;index<observed.length;index++)assert.ok(observed[index].mtimeMs<reportPhases[index].startedAt);
  const attempt=path.dirname(outcome.recordPath);
  assert.deepEqual(fs.readFileSync(path.join(attempt,'pre-inputs-previous-report.json')),previous);
  assert.deepEqual(fs.readFileSync(path.join(attempt,'post-inputs-previous-report.json')),observed[0].bytes);
});
for(const [name,mutate] of [
  ['changed and restored dependency bytes',file=>{const bytes=fs.readFileSync(file),stat=fs.statSync(file);fs.writeFileSync(file,'different compiler input');fs.writeFileSync(file,bytes);fs.utimesSync(file,stat.atime,stat.mtime);}],
  ['same-byte dependency replacement',file=>{const bytes=fs.readFileSync(file);fs.unlinkSync(file);fs.writeFileSync(file,bytes);}],
  ['rename-away and restore of original dependency',file=>{const saved=file+'.saved';fs.renameSync(file,saved);fs.writeFileSync(file,'substituted during compile');fs.unlinkSync(file);fs.renameSync(saved,file);}],
  ['temporary dependency-directory member',file=>{const temporary=path.join(path.dirname(file),'extra-input.jar');fs.writeFileSync(temporary,'temporary');fs.unlinkSync(temporary);}],
])test(`${name} refuses an otherwise successful APK`,async t=>{
  const f=setup(t),outcome=await build.buildIterationFixture({...f.options,runBuild:f.runner(async({argv})=>{if(argv[0]===':app:assembleDebug')mutate(f.dependency);})});
  assertUnusable(outcome,/resolved build input.*(?:generation|membership)/);
  assert.equal(f.calls.length,2,'refuse before post-report can relabel changed inputs');
});
test('post-build resolved set drift refuses the retained APK',async t=>{
  const f=setup(t),outcome=await build.buildIterationFixture({...f.options,runBuild:f.runner(async({phase})=>{
    if(phase===3){const file=path.join(f.root,'app/build/iteration-inputs.json'),report=JSON.parse(fs.readFileSync(file));report.dependencies[0].coordinate='fixture:library:2';fs.writeFileSync(file,JSON.stringify(report));}
  })});
  assertUnusable(outcome,/resolved input set or identity changed/);
});
test('an unchanged future-dated report cannot stand in for a fresh pre-build report',async t=>{
  const f=setup(t),file=path.join(f.root,'app/build/iteration-inputs.json');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(f.report()));
  const previous=fs.readFileSync(file);
  const future=new Date(Date.now()+60_000);fs.utimesSync(file,future,future);
  const outcome=await build.buildIterationFixture({...f.options,runBuild:async()=>succeeded});
  assertUnusable(outcome,/fresh resolved input report absent/);
  assert.deepEqual(fs.readFileSync(path.join(path.dirname(outcome.recordPath),'pre-inputs-previous-report.json')),previous);
});
test('a successful post-report command must produce a new report instead of reusing the pre-report',async t=>{
  const f=setup(t),runner=f.runner();let reports=0;
  const outcome=await build.buildIterationFixture({...f.options,runBuild:async(command,argv,options)=>{
    if(argv[0]===':app:writeIterationInputs'&&++reports===2)return {...succeeded};
    return runner(command,argv,options);
  }});
  assertUnusable(outcome,/fresh resolved input report absent/);assert.equal(reports,2);
  const attempt=path.dirname(outcome.recordPath);
  assert.deepEqual(fs.readFileSync(path.join(attempt,'post-inputs-previous-report.json')),fs.readFileSync(path.join(attempt,'resolved-inputs-before.json')));
});
test('a new symbolic report is refused before it can substitute resolved inputs',async t=>{
  const f=setup(t),file=path.join(f.root,'app/build/iteration-inputs.json');
  const outcome=await build.buildIterationFixture({...f.options,runBuild:f.runner(async({argv})=>{
    if(argv[0]!==':app:writeIterationInputs')return;
    fs.unlinkSync(file);fs.symlinkSync(f.dependency,file);
  })});
  assertUnusable(outcome,/fresh resolved input report absent|regular file|symbolic/);assert.equal(f.calls.length,1);
});
test('Gradle user-home properties and init scripts refuse before spawning',async t=>{
  for(const relative of ['gradle.properties','init.gradle','init.gradle.kts','init.d']){
    const f=setup(t),file=path.join(f.root,'.gradle-user-home',relative);fs.mkdirSync(path.dirname(file),{recursive:true});
    if(relative==='init.d')fs.mkdirSync(file);else fs.writeFileSync(file,'injected input');
    const outcome=await build.buildIterationFixture({...f.options,runBuild:f.runner()});assertUnusable(outcome,/unsupported input closure/);assert.equal(f.calls.length,0);
  }
});
test('JVM and Gradle project environment injection refuses before spawning',async t=>{
  for(const key of ['JAVA_OPTS','GRADLE_OPTS','JAVA_TOOL_OPTIONS','_JAVA_OPTIONS','JDK_JAVA_OPTIONS','ORG_GRADLE_PROJECT_injected']) {
    const f=setup(t),previous=process.env[key];process.env[key]='injected';
    try {const outcome=await build.buildIterationFixture({...f.options,runBuild:f.runner()});assertUnusable(outcome,/uncontrolled Gradle\/JVM environment input/);assert.equal(f.calls.length,0);}
    finally {if(previous===undefined)delete process.env[key];else process.env[key]=previous;}
  }
});
test('transient Gradle user-home configuration injection invalidates the build',async t=>{
  const f=setup(t),outcome=await build.buildIterationFixture({...f.options,runBuild:f.runner(async({phase})=>{
    if(phase===2){const file=path.join(f.root,'.gradle-user-home/gradle.properties');fs.writeFileSync(file,'org.gradle.jvmargs=-Dinjected=true');await new Promise(r=>setTimeout(r,20));fs.unlinkSync(file);}
  })});
  assertUnusable(outcome,/Gradle user configuration changed/);
});
test('changed-and-restored local SDK properties invalidate the build',async t=>{
  const f=setup(t),file=path.join(f.root,'local.properties');fs.writeFileSync(file,'sdk.dir=/fixture/sdk');const bytes=fs.readFileSync(file);
  const outcome=await build.buildIterationFixture({...f.options,runBuild:f.runner(async({phase})=>{
    if(phase===2){const saved=file+'.saved';fs.renameSync(file,saved);fs.writeFileSync(file,'sdk.dir=/fixture/other-sdk');await new Promise(r=>setTimeout(r,20));fs.unlinkSync(file);fs.renameSync(saved,file);}
  })});
  assertUnusable(outcome,/configuration changed|properties generation/);assert.deepEqual(fs.readFileSync(file),bytes);
});
test('one overall deadline covers all build phases',async t=>{
  const f=setup(t),outcome=await build.buildIterationFixture({...f.options,timeoutMs:1000,runBuild:f.runner(async({phase})=>{if(phase===1)await new Promise(r=>setTimeout(r,1050));})});
  assertUnusable(outcome,/overall build deadline/);assert.equal(f.calls.length,1);
});
test('cancellation after the pre-report prevents compilation',async t=>{
  const f=setup(t),controller=new AbortController();
  const outcome=await build.buildIterationFixture({...f.options,signal:controller.signal,runBuild:f.runner(async()=>controller.abort())});
  assertUnusable(outcome,/cancelled/);assert.equal(f.calls.length,1);
});
test('same-project build ownership spans post-report and releases only after drain',async t=>{
  const f=setup(t);let releasePost,enteredPost;
  const blocked=new Promise(r=>{releasePost=r;}),entered=new Promise(r=>{enteredPost=r;});
  const first=build.buildIterationFixture({...f.options,runBuild:f.runner(async({phase})=>{if(phase===3){enteredPost();await blocked;}})});
  await entered;
  let competingCalls=0;
  const second=await build.buildIterationFixture({...f.options,runBuild:async()=>{competingCalls++;return {...succeeded,code:1};}});
  releasePost();const completed=await first;
  assertUnusable(second,/project.*(?:owned|busy)/);assert.equal(competingCalls,0);assert.equal(completed.status,'built',JSON.stringify(completed));
  const following=await build.buildIterationFixture({...f.options,runBuild:f.runner()});assert.equal(following.status,'built',JSON.stringify(following));
});
test('uncertain process drain retains project ownership and prevents a second build',async t=>{
  const f=setup(t),first=await build.buildIterationFixture({...f.options,runBuild:async()=>{throw new Error('runner lost process result');}});
  assertUnusable(first,/drain is uncertain/);assert.equal(first.ownership.state,'held');assert.ok(fs.existsSync(first.ownership.path));
  let calls=0;
  const second=await build.buildIterationFixture({...f.options,runBuild:async()=>{calls++;return succeeded;}});
  assertUnusable(second,/project.*(?:owned|busy)/);assert.equal(calls,0);
});
test('external signal termination retains ownership without an explicit process-tree drain',async t=>{
  const f=setup(t),first=await build.buildIterationFixture({...f.options,runBuild:async()=>({...succeeded,code:null,signal:'SIGKILL'})});
  assertUnusable(first,/drain is uncertain/);assert.equal(first.ownership.state,'held');assert.ok(fs.existsSync(first.ownership.path));
  let calls=0;const second=await build.buildIterationFixture({...f.options,runBuild:async()=>{calls++;return succeeded;}});
  assertUnusable(second,/project.*(?:owned|busy)/);assert.equal(calls,0);
});
