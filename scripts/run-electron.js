#!/usr/bin/env node
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const electronBinary = require("electron");

const args = process.argv.slice(2);
// Resolve the app from the script location, not from the caller's cwd, so
// `npm start` works from any directory.
const appPath = path.resolve(__dirname, "..");
const traceLayoutLifecycle = args.includes("--trace-layout-lifecycle");
const appArgs = args.filter((arg) => arg !== "--trace-layout-lifecycle");
const hasExplicitAppPath = appArgs.some((arg) => (
  !arg.startsWith("-") && fs.existsSync(path.resolve(arg))
));
if (!hasExplicitAppPath) {
  appArgs.push(appPath);
}

const env = {
  ...process.env,
  ELECTRON_NO_ATTACH_CONSOLE: 'true',
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