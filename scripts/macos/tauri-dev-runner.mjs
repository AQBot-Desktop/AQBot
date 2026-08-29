#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEV_BUNDLE_IDENTIFIER,
  DEV_URL_SCHEME,
  devAppInfoPlist,
} from "./tauri-dev-plist.mjs";
import {
  restoreInstalledUrlSchemeHandler,
  setDefaultUrlSchemeHandler,
} from "./tauri-dev-url-scheme.mjs";
import {
  clearOwnedSessionMarker,
  stopExistingApp,
} from "./tauri-dev-session.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");
const tauriDir = path.join(repoRoot, "src-tauri");
const identity = "AQBot Dev";
const bundleIdentifier = DEV_BUNDLE_IDENTIFIER;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function run(command, args, options = {}) {
  const quiet = options.quiet ?? false;
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? tauriDir,
    env: process.env,
    encoding: quiet ? "utf8" : undefined,
    stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) fail(`${command} failed: ${result.error.message}`);
  if (result.status !== 0) {
    if (quiet) {
      console.error(`$ ${[command, ...args].join(" ")}`);
      if (result.stdout) process.stderr.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }
    process.exit(result.status ?? 1);
  }
}

function optionValue(args, longName, shortName) {
  const equals = args.find((arg) => arg.startsWith(`${longName}=`));
  if (equals) return equals.slice(longName.length + 1);
  const index = args.findIndex((arg) => arg === longName || arg === shortName);
  return index >= 0 ? args[index + 1] : undefined;
}

function profileName(args) {
  const explicit = optionValue(args, "--profile");
  if (explicit) return explicit;
  return args.includes("--release") ? "release" : "debug";
}

function cargoTargetDir(args) {
  const configured = process.env.CARGO_TARGET_DIR
    ? path.resolve(tauriDir, process.env.CARGO_TARGET_DIR)
    : path.join(tauriDir, "target");
  const target = optionValue(args, "--target", "-t");
  return target ? path.join(configured, target) : configured;
}

function diagnosticLogPath() {
  return process.env.AQBOT_LOG_FILE
    ? path.resolve(process.env.AQBOT_LOG_FILE)
    : path.join(os.homedir(), ".aqbot", "logs", "aqbot.log");
}

function sessionMarkerPath() {
  return path.join(
    os.homedir(),
    ".aqbot",
    "diagnostics",
    `current-session-${bundleIdentifier}.json`,
  );
}

function matchingCrashReport(pid, launchedAt) {
  const directory = path.join(os.homedir(), "Library", "Logs", "DiagnosticReports");
  if (!existsSync(directory)) return undefined;

  const candidates = readdirSync(directory)
    .filter((name) => name.startsWith("AQBot-") && name.endsWith(".ips"))
    .map((name) => path.join(directory, name))
    .filter((candidate) => statSync(candidate).mtimeMs >= launchedAt - 2_000)
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);

  for (const candidate of candidates) {
    try {
      const contents = readFileSync(candidate, "utf8");
      const newline = contents.indexOf("\n");
      if (newline < 0) continue;
      const metadata = JSON.parse(contents.slice(0, newline));
      const report = JSON.parse(contents.slice(newline + 1));
      if (metadata.bundleID === bundleIdentifier && report.pid === pid) return candidate;
    } catch (error) {
      console.warn(`Could not inspect crash report ${candidate}: ${error.message}`);
    }
  }
  return undefined;
}

async function waitForCrashReport(pid, launchedAt) {
  const deadline = Date.now() + 15_000;
  do {
    const report = matchingCrashReport(pid, launchedAt);
    if (report) return report;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  return undefined;
}

function showCrashAlert(detail) {
  const script = [
    "on run argv",
    'display alert "AQBot Dev 异常退出" message (item 1 of argv) as critical buttons {"知道了"} default button "知道了"',
    "end run",
  ];
  const args = script.flatMap((line) => ["-e", line]);
  spawnSync("/usr/bin/osascript", [...args, detail], { stdio: "ignore" });
}

async function assembleBundle(binary, bundle) {
  const executable = path.join(bundle, "Contents", "MacOS", "AQBot");
  const resources = path.join(bundle, "Contents", "Resources");
  await stopExistingApp({
    executable,
    markerPath: sessionMarkerPath(),
    bundleIdentifier,
  });
  rmSync(bundle, { force: true, recursive: true });
  mkdirSync(path.dirname(executable), { recursive: true });
  mkdirSync(resources, { recursive: true });
  copyFileSync(binary, executable);
  chmodSync(executable, 0o755);
  cpSync(path.join(tauriDir, "icons", "icon.icns"), path.join(resources, "icon.icns"));
  const { version } = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  writeFileSync(path.join(bundle, "Contents", "Info.plist"), devAppInfoPlist(version));
  return executable;
}

function lsregisterPath() {
  return [
    "/System/Library/Frameworks/CoreServices.framework",
    "Frameworks/LaunchServices.framework/Support/lsregister",
  ].join("/");
}

function registerBundle(bundlePath, { quiet = false } = {}) {
  if (!existsSync(bundlePath)) return;
  run(lsregisterPath(), ["-f", bundlePath], { cwd: repoRoot, quiet });
}

function restoreInstalledUrlHandler() {
  registerBundle("/Applications/AQBot.app", { quiet: true });
  try {
    restoreInstalledUrlSchemeHandler(DEV_URL_SCHEME);
  } catch (error) {
    console.warn(error.message);
  }
}

function claimDevUrlScheme() {
  try {
    setDefaultUrlSchemeHandler(DEV_URL_SCHEME, bundleIdentifier);
  } catch (error) {
    console.warn(error.message);
    console.warn("aqbot:// may still open the installed AQBot.app instead of AQBot Dev.");
  }
}

function launch(bundle, executable, appArgs) {
  registerBundle(bundle);
  claimDevUrlScheme();

  const launchedAt = Date.now();
  const child = spawn(executable, appArgs, {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });
  let requestedStop = false;
  let forceTimer;

  const stop = () => {
    if (requestedStop) return;
    requestedStop = true;
    // The outer Tauri CLI shares this process group and may terminate the runner
    // before the child "exit" callback runs. Clear only the marker owned by this
    // exact PID up front so an intentional Ctrl-C is never reported as a crash.
    clearOwnedSessionMarker(sessionMarkerPath(), child.pid);
    spawnSync(
      "/usr/bin/osascript",
      ["-e", `tell application id "${bundleIdentifier}" to quit`],
      { stdio: "ignore" },
    );
    forceTimer = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      console.warn(`AQBot Dev did not quit within 3 seconds; terminating PID ${child.pid}.`);
      child.kill("SIGTERM");
    }, 3_000);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  child.on("error", (error) => fail(`Could not launch AQBot Dev.app: ${error.message}`));
  child.on("exit", async (code, signal) => {
    restoreInstalledUrlHandler();
    if (forceTimer) clearTimeout(forceTimer);
    if (requestedStop) {
      clearOwnedSessionMarker(sessionMarkerPath(), child.pid);
      process.exit(0);
    }

    const abnormal = signal !== null || (code ?? 1) !== 0;
    if (!abnormal) {
      clearOwnedSessionMarker(sessionMarkerPath(), child.pid);
      process.exit(0);
      return;
    }

    const exitReason = signal ? `signal ${signal}` : `exit code ${code ?? 1}`;
    const logPath = diagnosticLogPath();
    console.error(`AQBot Dev exited unexpectedly (${exitReason}).`);
    console.error(`AQBot log: ${logPath}`);
    console.error("Waiting up to 15 seconds for a matching macOS crash report...");
    const report = await waitForCrashReport(child.pid, launchedAt);
    if (report) console.error(`macOS crash report: ${report}`);
    else console.error("macOS crash report: no matching .ips report was found within 15 seconds.");
    showCrashAlert([
      `退出原因：${exitReason}`,
      `AQBot 日志：${logPath}`,
      report ? `系统报告：${report}` : "系统报告：暂未生成",
    ].join("\n"));
    process.exit(code ?? 1);
  });
}

if (process.platform !== "darwin") fail("The AQBot development runner only supports macOS.");

const runnerArgs = process.argv.slice(2);
if (runnerArgs[0] !== "run") {
  fail(`Expected Cargo run arguments, received: ${runnerArgs.join(" ")}`);
}
const separator = runnerArgs.indexOf("--");
const cargoArgs = (separator >= 0 ? runnerArgs.slice(0, separator) : runnerArgs).slice();
const appArgs = separator >= 0 ? runnerArgs.slice(separator + 1) : [];
cargoArgs[0] = "build";
if (!cargoArgs.some((arg) => arg === "--bin" || arg.startsWith("--bin="))) {
  cargoArgs.push("--bin", "AQBot");
}

run("cargo", cargoArgs);

const profile = profileName(cargoArgs);
const buildRoot = cargoTargetDir(cargoArgs);
const binary = path.join(buildRoot, profile, "AQBot");
const bundle = path.join(buildRoot, profile, "dev-bundle", "AQBot Dev.app");
const executable = await assembleBundle(binary, bundle);

run("codesign", [
  "--force",
  "--sign",
  identity,
  "--identifier",
  bundleIdentifier,
  "--timestamp=none",
  bundle,
], { quiet: true });
run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", bundle], {
  quiet: true,
});
launch(bundle, executable, appArgs);
