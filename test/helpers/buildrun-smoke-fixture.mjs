import fs from "node:fs";
import path from "node:path";

export function buildRunSmokeFixturePlan({ root, platform }) {
  const windows = platform === "win32";
  return {
    platform,
    executesMcpSuccessPath: !windows,
    scope: windows
      ? "wrapper-selection-only contract; no native build_and_run execution"
      : "hermetic MCP build_and_run success-path execution",
    binDir: path.join(root, "bin"),
    projectDir: path.join(root, "project"),
    adbPath: path.join(root, "bin", windows ? "adb.cmd" : "adb"),
    gradlePath: path.join(root, "project", windows ? "gradlew.bat" : "gradlew"),
  };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

export function materializeBuildRunSmokeFixture({
  root,
  pngBase64,
  platform = process.platform,
  execPath = process.execPath,
  scenario = "success",
}) {
  const plan = buildRunSmokeFixturePlan({ root, platform });
  fs.mkdirSync(plan.binDir, { recursive: true });
  fs.mkdirSync(plan.projectDir, { recursive: true });

  const adbDriver = path.join(plan.binDir, "fake-adb.cjs");
  const gradleDriver = path.join(plan.projectDir, "fake-gradle.cjs");
  fs.writeFileSync(
    adbDriver,
    `const a=process.argv.slice(2),scenario=${JSON.stringify(scenario)};\nif(a.includes("install")) process.stdout.write("Success\\n");\nelse if(a.includes("monkey")){if(scenario==="launch-failure"){process.stderr.write("device offline\\n");process.exitCode=1;}else process.stdout.write("Events injected: 1\\n");}\nelse if(a.includes("pidof")){if(scenario!=="dead-process")process.stdout.write("4242\\n");else process.exitCode=1;}\nelse if(a.includes("--pid")&&a.includes("logcat")) process.stdout.write("I SpatialView: RenderEntity create texture success\\n");\nelse if(a.includes("exec-out")&&a.includes("screencap")) process.stdout.write(Buffer.from(${JSON.stringify(pngBase64)},"base64"));\n`,
  );
  fs.writeFileSync(
    gradleDriver,
    `const fs=require("node:fs"),p=require("node:path");\nconst dir=p.join(process.cwd(),"app","build","outputs","apk","debug"),out=p.join(dir,"app-debug.apk");\nfs.mkdirSync(dir,{recursive:true});fs.writeFileSync(out,"fixture apk");fs.writeFileSync(p.join(dir,"output-metadata.json"),JSON.stringify({variantName:"debug",applicationId:"com.example.contractfixture",elements:[{outputFile:"app-debug.apk"}]}));process.stdout.write("BUILD SUCCESSFUL\\n");\n`,
  );

  if (platform === "win32") {
    fs.writeFileSync(plan.adbPath, `@echo off\r\n"${execPath}" "${adbDriver}" %*\r\n`);
    fs.writeFileSync(plan.gradlePath, `@echo off\r\n"${execPath}" "${gradleDriver}" %*\r\n`);
  } else {
    fs.writeFileSync(plan.adbPath, `#!/bin/sh\nexec ${shellQuote(execPath)} ${shellQuote(adbDriver)} "$@"\n`, { mode: 0o755 });
    fs.writeFileSync(plan.gradlePath, `#!/bin/sh\nexec ${shellQuote(execPath)} ${shellQuote(gradleDriver)} "$@"\n`, { mode: 0o755 });
    fs.chmodSync(plan.adbPath, 0o755);
    fs.chmodSync(plan.gradlePath, 0o755);
  }
  return { ...plan, adbDriver, gradleDriver };
}
