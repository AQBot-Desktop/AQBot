import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

export const INSTALLED_APP_PATH = "/Applications/AQBot.app";
export const INSTALLED_BUNDLE_IDENTIFIER = "top.aqbot.desktop";

export function defaultHandlerSwiftProgram() {
  return `
import Foundation
import CoreServices

guard let scheme = ProcessInfo.processInfo.environment["AQBOT_URL_SCHEME"], !scheme.isEmpty else {
  fputs("AQBOT_URL_SCHEME is missing\\n", stderr)
  exit(1)
}
guard let bundleId = ProcessInfo.processInfo.environment["AQBOT_HANDLER_BUNDLE_ID"], !bundleId.isEmpty else {
  fputs("AQBOT_HANDLER_BUNDLE_ID is missing\\n", stderr)
  exit(1)
}

let status = LSSetDefaultHandlerForURLScheme(scheme as CFString, bundleId as CFString)
if status != noErr {
  fputs("LSSetDefaultHandlerForURLScheme failed with status \\(status)\\n", stderr)
  exit(1)
}
`.trim();
}

export function defaultHandlerSwiftEnv(scheme, bundleId) {
  return {
    AQBOT_URL_SCHEME: scheme,
    AQBOT_HANDLER_BUNDLE_ID: bundleId,
  };
}

export function setDefaultUrlSchemeHandler(scheme, bundleId, spawn = spawnSync) {
  const result = spawn("swift", ["-e", defaultHandlerSwiftProgram()], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...defaultHandlerSwiftEnv(scheme, bundleId),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    throw new Error(`Could not set ${scheme}:// handler: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `Could not set ${scheme}:// handler to ${bundleId}: ${(result.stderr || "").trim()}`,
    );
  }
}

export function restoreInstalledUrlSchemeHandler(scheme, spawn = spawnSync) {
  if (!existsSync(INSTALLED_APP_PATH)) return false;
  setDefaultUrlSchemeHandler(scheme, INSTALLED_BUNDLE_IDENTIFIER, spawn);
  return true;
}
