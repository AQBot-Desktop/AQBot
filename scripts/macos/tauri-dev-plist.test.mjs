import assert from "node:assert/strict";
import test from "node:test";

import { devAppInfoPlist } from "./tauri-dev-plist.mjs";

test("dev app Info.plist claims the aqbot URL scheme so links open AQBot Dev", () => {
  const plist = devAppInfoPlist("0.0.143");

  assert.match(plist, /<key>CFBundleIdentifier<\/key>\s*<string>top\.aqbot\.desktop\.dev<\/string>/);
  assert.match(plist, /<key>CFBundleURLSchemes<\/key>\s*<array>\s*<string>aqbot<\/string>\s*<\/array>/);
  assert.match(plist, /<key>CFBundleURLName<\/key>\s*<string>aqbot<\/string>/);
});
