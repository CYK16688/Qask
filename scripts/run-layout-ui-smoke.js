#!/usr/bin/env node
// Spawn Electron for the layout smoke test with a clean environment. An
// inherited ELECTRON_RUN_AS_NODE would make Electron execute the smoke script
// as plain Node, where `app` is undefined.
const { spawn } = require("node:child_process");
const path = require("node:path");

const electronBinary = require("electron");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBinary, [path.join(__dirname, "layout-ui-smoke.js")], {
  stdio: "inherit",
  env,
});

child.on("close", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on("error", (error) => {
  console.error("启动 Electron 布局冒烟测试失败:", error.message);
  process.exit(1);
});
