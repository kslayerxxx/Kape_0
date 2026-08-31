(function () {
  // ==========================================
  // 1. Configuration & Persistence
  // ==========================================
  const DEFAULT_CONFIG = {
    blockTelemetry: true,
    fpsOptimization: true,
    vectorNodeIndicator: true,
    enhancedWires: true,
    darkerGrid: true,
    autoCenterRunningNode: false,
    autoCancelBreakpoints: true,
  };

  const config = Object.assign(
    {},
    DEFAULT_CONFIG,
    JSON.parse(localStorage.getItem("RH_QOL_CONFIG") || "{}"),
  );

  function saveConfig() {
    localStorage.setItem("RH_QOL_CONFIG", JSON.stringify(config));
  }

  // ==========================================
  // 2. Telemetry & Analytics Blocker
  // ==========================================
  if (config.blockTelemetry) {
    const blockedHosts = [
      "google-analytics.com",
      "googletagmanager.com",
      "hm.baidu.com",
      "clarity.ms",
      "sentry.io",
    ];
    const originalFetch = window.fetch;
    window.fetch = function (input, init) {
      const url =
        typeof input === "string" ? input : input && input.url ? input.url : "";
      if (blockedHosts.some((host) => url.includes(host))) {
        return Promise.resolve(
          new Response("", { status: 204, statusText: "No Content" }),
        );
      }
      return originalFetch.apply(this, arguments);
    };
  }

  // ==========================================
  // 3. UI Injections
  // ==========================================
  const dynamicStyle = document.createElement("style");
  dynamicStyle.id = "rh-custom-styles";
  let css = "";
  if (config.darkerGrid) {
    css += `canvas#graph-canvas { background-color: #121214 !important; }`;
  }
  dynamicStyle.textContent = css;
  document.head.appendChild(dynamicStyle);

  // ==========================================
  // 4. RunningHub Execution & Cancel Logic
  // ==========================================
  const stopNodeIds = new Set();
  let lastExecutedNodeId = null;

  function triggerRunningHubCancel() {
    if (window.api && typeof window.api.interrupt === "function") {
      window.api.interrupt();
    }

    const cancelBtn = document.querySelector(
      ".workflow-result-wrap .rh-task-item .rh-cancel-btn",
    );

    if (cancelBtn) {
      cancelBtn.click();
      console.log("[RH Breakpoint] Triggered click on .rh-cancel-btn");
      return;
    }

    const sidebar = document.querySelector(".workflow-result-wrap");
    const toggleSidebarBtn = document.querySelector(
      ".workflow-result-wrap .hide-btn",
    );

    if (
      toggleSidebarBtn &&
      (!sidebar ||
        sidebar.offsetWidth === 0 ||
        sidebar.classList.contains("is-hide"))
    ) {
      toggleSidebarBtn.click();
      setTimeout(() => {
        const retryCancelBtn = document.querySelector(
          ".workflow-result-wrap .rh-task-item .rh-cancel-btn",
        );
        if (retryCancelBtn) retryCancelBtn.click();
      }, 150);
    }
  }

  function attachExecutionWatcher() {
    if (window.api && !window.__rh_exec_hooked) {
      window.__rh_exec_hooked = true;
      window.api.addEventListener("executing", (e) => {
        const executingNodeId = String(e.detail);
        if (executingNodeId === lastExecutedNodeId) return;
        lastExecutedNodeId = executingNodeId;

        if (
          config.autoCenterRunningNode &&
          window.app &&
          window.app.graph &&
          window.app.canvas
        ) {
          const node = window.app.graph.getNodeById(executingNodeId);
          if (node && window.app.canvas.centerOnNode) {
            window.app.canvas.centerOnNode(node);
          }
        }

        if (config.autoCancelBreakpoints && stopNodeIds.has(executingNodeId)) {
          console.warn(
            `[RH Breakpoint] Reached stop node #${executingNodeId}. Halting execution.`,
          );
          triggerRunningHubCancel();
        }
      });
    }
  }

  // ==========================================
  // 5. LiteGraph Canvas Engine Hooks
  // ==========================================
  function applyCanvasHooks() {
    if (
      !window.LGraphCanvas ||
      !window.LGraphCanvas.prototype ||
      window.LGraphCanvas.prototype.__rh_patched
    )
      return;
    window.LGraphCanvas.prototype.__rh_patched = true;

    // A. Vector Indicator + Breakpoint Stop Badge
    const originalDrawNode = window.LGraphCanvas.prototype.drawNode;
    window.LGraphCanvas.prototype.drawNode = function (node, ctx) {
      originalDrawNode.apply(this, arguments);

      const isExecuting =
        node.is_executing || node.running || this.node_executing === node;
      const isBreakpoint =
        config.autoCancelBreakpoints && stopNodeIds.has(String(node.id));

      if (config.vectorNodeIndicator && isExecuting) {
        ctx.save();
        const x = node.pos[0] - 6;
        const y = node.pos[1] - 6;
        const w = node.size[0] + 12;
        const h = node.size[1] + 12;

        ctx.lineWidth = 8;
        ctx.strokeStyle = "rgba(0, 255, 102, 0.25)";
        ctx.strokeRect(x - 2, y - 2, w + 4, h + 4);

        ctx.lineWidth = 4;
        ctx.strokeStyle = "#00FF66";
        ctx.strokeRect(x, y, w, h);

        const len = 16;
        ctx.lineWidth = 5;
        ctx.strokeStyle = "#FFFFFF";

        ctx.beginPath();
        ctx.moveTo(x, y + len);
        ctx.lineTo(x, y);
        ctx.lineTo(x + len, y);
        ctx.moveTo(x + w - len, y);
        ctx.lineTo(x + w, y);
        ctx.lineTo(x + w, y + len);
        ctx.moveTo(x, y + h - len);
        ctx.lineTo(x, y + h);
        ctx.lineTo(x + len, y + h);
        ctx.moveTo(x + w - len, y + h);
        ctx.lineTo(x + w, y + h);
        ctx.lineTo(x + w, y + h - len);
        ctx.stroke();
        ctx.restore();
      }

      if (isBreakpoint) {
        ctx.save();
        ctx.lineWidth = 4;
        ctx.strokeStyle = "#FF3344";
        ctx.strokeRect(
          node.pos[0] - 2,
          node.pos[1] - 2,
          node.size[0] + 4,
          node.size[1] + 4,
        );

        ctx.fillStyle = "#FF3344";
        ctx.font = "bold 11px sans-serif";
        ctx.fillText("🛑 AUTO-CANCEL STOP", node.pos[0], node.pos[1] - 8);
        ctx.restore();
      }
    };

    // B. Context Menu Hook
    const originalGetNodeMenuOptions =
      window.LGraphCanvas.prototype.getNodeMenuOptions;
    window.LGraphCanvas.prototype.getNodeMenuOptions = function (node) {
      const options = originalGetNodeMenuOptions
        ? originalGetNodeMenuOptions.apply(this, arguments)
        : [];
      const isStopNode = stopNodeIds.has(String(node.id));

      options.push({
        content: isStopNode
          ? "🛑 Remove Stop Breakpoint"
          : "🛑 Set Auto-Cancel Breakpoint",
        callback: () => {
          if (isStopNode) {
            stopNodeIds.delete(String(node.id));
          } else {
            stopNodeIds.add(String(node.id));
          }
          if (window.app && window.app.canvas) {
            window.app.canvas.setDirty(true, true);
          }
        },
      });
      return options;
    };

    // C. Low-Spec GPU Optimization
    if (config.fpsOptimization) {
      window.LGraphCanvas.prototype.render_shadows = false;
      window.LGraphCanvas.prototype.render_connections_border = false;
      window.LGraphCanvas.prototype.highquality_render = false;
    }

    // D. Spline Rendering
    if (config.enhancedWires && window.LiteGraph) {
      window.LiteGraph.LINK_RENDER_MODE = 2;
    }
  }

  // ==========================================
  // 6. Floating UI Settings Overlay
  // ==========================================
  function createFloatingMenu() {
    const container = document.createElement("div");
    container.id = "rh-floating-root";
    container.innerHTML = `
      <div id="rh-toggle-btn" title="RunningHub QoL Settings">⚙️</div>
      <div id="rh-settings-panel" style="display: none;">
        <div style="font-weight: bold; margin-bottom: 10px; font-size: 13px; border-bottom: 1px solid #333; padding-bottom: 6px; display: flex; justify-content: space-between; align-items: center;">
          <span>QoL Settings</span>
          <span id="rh-close-btn" style="cursor:pointer; color:#777; font-size: 16px;">✕</span>
        </div>
        ${Object.keys(DEFAULT_CONFIG)
          .map(
            (key) => `
          <label style="display: flex; justify-content: space-between; align-items: center; margin: 8px 0; font-size: 12px; cursor: pointer;">
            <span>${key}</span>
            <input type="checkbox" data-key="${key}" ${config[key] ? "checked" : ""} style="cursor: pointer;">
          </label>
        `,
          )
          .join("")}
        <button id="rh-reload-btn" style="width: 100%; margin-top: 10px; padding: 6px; background: #00AA55; border: none; color: #fff; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: bold;">Apply & Reload</button>
      </div>
    `;

    const menuStyle = document.createElement("style");
    menuStyle.textContent = `
      #rh-floating-root {
        position: fixed;
        bottom: 20px;
        right: 20px;
        z-index: 999999;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      #rh-toggle-btn {
        width: 36px;
        height: 36px;
        background: #1e1e24;
        border: 1px solid #444;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        font-size: 16px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.5);
        user-select: none;
        transition: transform 0.15s ease;
      }
      #rh-toggle-btn:hover {
        transform: scale(1.08);
      }
      #rh-settings-panel {
        position: absolute;
        bottom: 46px;
        right: 0;
        width: 250px;
        background: #16161a;
        border: 1px solid #333;
        border-radius: 8px;
        padding: 12px;
        color: #ddd;
        box-shadow: 0 8px 24px rgba(0,0,0,0.7);
      }
    `;
    document.head.appendChild(menuStyle);
    document.body.appendChild(container);

    const toggleBtn = container.querySelector("#rh-toggle-btn");
    const panel = container.querySelector("#rh-settings-panel");
    const closeBtn = container.querySelector("#rh-close-btn");
    const reloadBtn = container.querySelector("#rh-reload-btn");

    toggleBtn.onclick = () => {
      panel.style.display = panel.style.display === "none" ? "block" : "none";
    };
    closeBtn.onclick = () => {
      panel.style.display = "none";
    };

    reloadBtn.onclick = () => {
      container.querySelectorAll('input[type="checkbox"]').forEach((input) => {
        config[input.dataset.key] = input.checked;
      });
      saveConfig();
      location.reload();
    };
  }

  // ==========================================
  // 7. Route & View Awareness + Init Poller
  // ==========================================
  function isWorkflowCanvasActive() {
    const canvasElement = document.querySelector("canvas#graph-canvas");
    const isWorkflowRoute =
      !location.pathname.includes("/explore") &&
      !location.pathname.includes("/ai-application") &&
      !location.pathname.includes("/model");
    return !!(canvasElement && isWorkflowRoute);
  }

  const initTimer = setInterval(() => {
    if (document.body && !document.getElementById("rh-floating-root")) {
      createFloatingMenu();
    }
    if (window.LGraphCanvas) {
      applyCanvasHooks();
    }
    if (window.api) {
      attachExecutionWatcher();
    }

    const floatingRoot = document.getElementById("rh-floating-root");
    if (floatingRoot) {
      if (isWorkflowCanvasActive()) {
        floatingRoot.style.display = "block";
      } else {
        floatingRoot.style.display = "none";
        const panel = document.getElementById("rh-settings-panel");
        if (panel) panel.style.display = "none";
      }
    }
  }, 500);
})();
