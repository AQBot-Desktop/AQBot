import assert from "node:assert/strict";
import test from "node:test";

import {
  INSTALLED_APP_PATH,
  INSTALLED_BUNDLE_IDENTIFIER,
  defaultHandlerSwiftEnv,
  defaultHandlerSwiftProgram,
  setDefaultUrlSchemeHandler,
} from "./tauri-dev-url-scheme.mjs";

test("swift helper reads scheme and bundle id from the environment", () => {
  const program = defaultHandlerSwiftProgram();
  assert.match(program, /LSSetDefaultHandlerForURLScheme/);
  assert.match(program, /AQBOT_URL_SCHEME/);
  assert.match(program, /AQBOT_HANDLER_BUNDLE_ID/);
});

test("dev session can restore the installed app as the aqbot handler", () => {
  assert.equal(INSTALLED_APP_PATH, "/Applications/AQBot.app");
  assert.equal(INSTALLED_BUNDLE_IDENTIFIER, "top.aqbot.desktop");
  assert.deepEqual(defaultHandlerSwiftEnv("aqbot", "top.aqbot.desktop.dev"), {
    AQBOT_URL_SCHEME: "aqbot",
    AQBOT_HANDLER_BUNDLE_ID: "top.aqbot.desktop.dev",
  });
});

test("setDefaultUrlSchemeHandler invokes swift with the handler environment", () => {
  const spawn = (command, args, options) => {
    assert.equal(command, "swift");
    assert.equal(args[0], "-e");
    assert.match(args[1], /LSSetDefaultHandlerForURLScheme/);
    assert.equal(options.env.AQBOT_URL_SCHEME, "aqbot");
    assert.equal(options.env.AQBOT_HANDLER_BUNDLE_ID, "top.aqbot.desktop.dev");
    return { status: 0, stderr: "" };
  };

  setDefaultUrlSchemeHandler("aqbot", "top.aqbot.desktop.dev", spawn);
});
