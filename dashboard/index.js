(() => {
  const registry = window.__HERMES_PLUGINS__;
  if (registry && typeof registry.register === "function") {
    registry.register("beads", function BeadsDashboardEntry() {
      return null;
    });
  }
})();
