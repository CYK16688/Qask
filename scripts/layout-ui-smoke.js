#!/usr/bin/env node
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "qask-layout-smoke-profile-"));
const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "qask-layout-smoke-artifacts-"));
const expectedRows = {
  single: [1],
  dual: [2],
  triple: [3],
  quad: [2, 2],
};

app.setPath("userData", profileDir);
process.env.QASK_TRACE_LAYOUT_LIFECYCLE = "0";
require(path.join(root, "main.js"));

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForShell(window) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const ready = await window.webContents.executeJavaScript(
      "Boolean(document.querySelector('#panelsContainer') && document.querySelector('#layoutControls [data-layout]') && document.querySelectorAll('.panel').length >= 2)",
      true,
    );
    if (ready) return;
    await wait(100);
  }
  throw new Error("Qask shell did not initialize its initial layout in time");
}

async function inspectLayout(window, layoutId) {
  const report = await window.webContents.executeJavaScript(`
    (async () => {
      const expected = ${JSON.stringify(expectedRows)};
      const layoutButton = document.querySelector('#layoutControls [data-layout="${layoutId}"]');
      if (!layoutButton) throw new Error('missing layout button: ${layoutId}');
      layoutButton.click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await new Promise((resolve) => setTimeout(resolve, 200));

      const container = document.querySelector('#panelsContainer');
      const allPanels = Array.from(container.querySelectorAll('.panel'));
      const visiblePanels = allPanels
        .filter((panel) => !panel.hidden)
        .map((panel) => {
          const rect = panel.getBoundingClientRect();
          return {
            panelId: panel.dataset.panelId || null,
            modelId: panel.dataset.panelModelId || null,
            rank: Number(panel.dataset.panelRank),
            hidden: panel.hidden,
            connected: panel.isConnected,
            display: getComputedStyle(panel).display,
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          };
        })
        .sort((left, right) => left.rank - right.rank);
      const parkedPanels = allPanels
        .filter((panel) => panel.hidden)
        .map((panel) => ({
          panelId: panel.dataset.panelId || null,
          modelId: panel.dataset.panelModelId || null,
          connected: panel.isConnected,
          display: getComputedStyle(panel).display,
        }));
      const groupedRows = [];
      for (const panel of visiblePanels) {
        let row = groupedRows.find((candidate) => Math.abs(candidate.y - panel.y) <= 4);
        if (!row) {
          row = { y: panel.y, panels: [] };
          groupedRows.push(row);
        }
        row.panels.push(panel);
      }
      groupedRows.sort((left, right) => left.y - right.y);
      const rowWidths = groupedRows.map((row) => row.panels.sort((left, right) => left.x - right.x).length);
      const activeSidebarModels = Array.from(document.querySelectorAll('#modelList li.is-active'))
        .map((item) => item.dataset.modelId);
      const expandedPressed = Array.from(document.querySelectorAll('#layoutControls [data-layout][aria-pressed="true"]'))
        .map((button) => button.dataset.layout);
      const collapsedPressed = Array.from(document.querySelectorAll('.collapsed-layout-btn[aria-pressed="true"]'))
        .map((button) => button.dataset.layout);

      return {
        layoutId: ${JSON.stringify(layoutId)},
        containerLayout: container.dataset.layout,
        expectedRows: expected[${JSON.stringify(layoutId)}],
        rowWidths,
        visiblePanels,
        parkedPanels,
        activeSidebarModels,
        expandedPressed,
        collapsedPressed,
      };
    })()
  `, true);

  const expectedCount = expectedRows[layoutId].reduce((total, count) => total + count, 0);
  const expectedRanks = Array.from({ length: expectedCount }, (_, index) => index);
  const visibleModels = report.visiblePanels.map((panel) => panel.modelId);
  const failure = (
    report.containerLayout !== layoutId
    || report.visiblePanels.length !== expectedCount
    || JSON.stringify(report.rowWidths) !== JSON.stringify(expectedRows[layoutId])
    || JSON.stringify(report.visiblePanels.map((panel) => panel.rank)) !== JSON.stringify(expectedRanks)
    || JSON.stringify(report.activeSidebarModels) !== JSON.stringify(visibleModels)
    || JSON.stringify(report.expandedPressed) !== JSON.stringify([layoutId])
    || JSON.stringify(report.collapsedPressed) !== JSON.stringify([layoutId])
    || report.visiblePanels.some((panel) => !panel.connected || panel.display === "none" || panel.width <= 0 || panel.height <= 0)
    || report.parkedPanels.some((panel) => !panel.connected || panel.display !== "none")
  );
  if (failure) {
    throw new Error(`layout ${layoutId} mismatch: ${JSON.stringify(report)}`);
  }

  const screenshot = await window.webContents.capturePage();
  const screenshotPath = path.join(artifactDir, `${layoutId}.png`);
  fs.writeFileSync(screenshotPath, screenshot.toPNG());
  return { ...report, screenshotPath };
}

app.whenReady().then(async () => {
  try {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error("Qask main window was not created");
    await waitForShell(window);
    const reports = [];
    for (const layoutId of ["single", "dual", "triple", "quad"]) {
      reports.push(await inspectLayout(window, layoutId));
    }
    console.log(JSON.stringify({ ok: true, artifactDir, reports }));
  } catch (error) {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});

app.on("will-quit", () => {
  fs.rmSync(profileDir, { recursive: true, force: true });
});
