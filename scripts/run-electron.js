#!/usr/bin/env node
const { spawn } = require("node:child_process");
const path = require("node:path");

const electronBinary = require("electron");

const args = process.argv.slice(2);
const appPath = path.resolve(process.cwd());
const traceLayoutLifecycle = args.includes("--trace-layout-lifecycle");
const appArgs = args.filter((arg) => arg !== "--trace-layout-lifecycle");
if (appArgs.length === 0) {
  appArgs.push(appPath);
}

const env = {
  ...process.env,
  ELECTRON_NO_ATTACH_CONSOLE: 'true',
  ELECTRON_DISABLE_GPU: 'false',
  ELECTRON_LOG_LEVEL: traceLayoutLifecycle ? 'info' : 'error',
};
if (traceLayoutLifecycle) {
  env.QASK_TRACE_LAYOUT_LIFECYCLE = "1";
}
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBinary, appArgs, {
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
  console.error("启动 Electron 失败:", error.message);
  process.exit(1);
});