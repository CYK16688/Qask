// Runs before the stylesheet paints so the first frame already uses the saved
// appearance instead of flashing the opposite theme. renderer.js owns the live
// switching after the shell boots.
(() => {
  try {
    const stored = JSON.parse(window.localStorage.getItem("qask.theme") || '"system"');
    const mode = ["system", "dark", "light"].includes(stored) ? stored : "system";
    const dark = mode === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
      : mode === "dark";
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
  } catch (error) {
    document.documentElement.dataset.theme = "dark";
    document.documentElement.style.colorScheme = "dark";
  }
})();
