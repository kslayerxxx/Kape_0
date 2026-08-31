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
  // 2. Cookie & Session Token JSON Importer
  // ==========================================
  window.importCookiesFromJSON = function (jsonInput) {
    try {
      const cookies =
        typeof jsonInput === "string" ? JSON.parse(jsonInput) : jsonInput;
      if (!Array.isArray(cookies)) {
        alert("Invalid format: Expected a JSON array of cookies.");
        return false;
      }

      let count = 0;
      cookies.forEach((c) => {
        if (!c.name || c.value === undefined) return;
        const name = encodeURIComponent(c.name.trim());
        const value = encodeURIComponent(c.value.trim());

        // 1. Set standard cookie
        let cookieStr = `${name}=${value}; path=/; max-age=31536000; SameSite=Lax`;
        if (location.hostname.includes("runninghub")) {
          cookieStr += "; domain=.runninghub.ai";
        }
        document.cookie = cookieStr;

        // 2. Set token directly into Web Storage for Vue frontend auth sync
        const lowerKey = c.name.toLowerCase();
        if (
          lowerKey.includes("token") ||
          lowerKey.includes("auth") ||
          lowerKey.includes("session")
        ) {
          try {
            localStorage.setItem(c.name, c.value);
            sessionStorage.setItem(c.name, c.value);
          } catch (e) {}
        }

        count++;
      });

      console.log(
        `[RH Importer] Imported ${count} cookies/tokens successfully.`,
      );
      location.href = "https://www.runninghub.ai/";
      return true;
    } catch (err) {
      alert("Failed to parse Cookie JSON: " + err.message);
      return false;
    }
  };

  async function pasteAndImportCookies() {
    try {
      let text = "";
      if (navigator.clipboard && navigator.clipboard.readText) {
        text = await navigator.clipboard.readText();
      }
      if (!text || !text.trim().startsWith("[")) {
        text = prompt("Paste your exported Cookie JSON array here:");
      }
      if (text) {
        window.importCookiesFromJSON(text);
      }
    } catch (e) {
      const manualText = prompt("Paste your exported Cookie JSON array here:");
      if (manualText) window.importCookiesFromJSON(manualText);
    }
  }

  // Global Hotkey: Works on Login Screen, Home, and Canvas
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && e.code === "KeyV") {
      e.preventDefault();
      pasteAndImportCookies();
    }
  });

  // ==========================================
  // 3. Telemetry Blocker
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
  // 4. UI Injections (Dark Grid)
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
  // 5. RunningHub Execution & Cancel Logic
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
  // 6. LiteGraph Canvas Prototype Hooks
  // ==========================================
  function applyCanvasHooks() {
    if (
      !window.LGraphCanvas ||
      !window.LGraphCanvas.prototype ||
      window.LGraphCanvas.prototype.__rh_patched
    )
      return;
    window.LGraphCanvas.prototype.__rh_patched = true;

    // Vector border indicator + Breakpoint stop badge
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
        ctx.moveTo(x + h - len);
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

    // Right-click menu option for breakpoints
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

    // Hardware rendering optimizations
    if (config.fpsOptimization) {
      window.LGraphCanvas.prototype.render_shadows = false;
      window.LGraphCanvas.prototype.render_connections_border = false;
      window.LGraphCanvas.prototype.highquality_render = false;
    }

    if (config.enhancedWires && window.LiteGraph) {
      window.LiteGraph.LINK_RENDER_MODE = 2;
    }
  }

  // ==========================================
  // 7. Global Floating Settings Gear (Always Visible)
  // ==========================================
  function createFloatingMenu() {
    if (document.getElementById("rh-floating-root")) return;

    const container = document.createElement("div");
    container.id = "rh-floating-root";
    container.innerHTML = `
      <div id="rh-toggle-btn" title="RunningHub Settings / Cookie Import">⚙️</div>
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
        <button id="rh-import-cookies-btn" style="width: 100%; margin-top: 8px; padding: 6px; background: #2b2b36; border: 1px solid #00FF66; color: #00FF66; border-radius: 4px; cursor: pointer; font-size: 11px; font-weight: bold;">📋 Paste Cookies (JSON)</button>
        <button id="rh-reload-btn" style="width: 100%; margin-top: 6px; padding: 6px; background: #00AA55; border: none; color: #fff; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: bold;">Apply & Reload</button>
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
    const importCookiesBtn = container.querySelector("#rh-import-cookies-btn");

    toggleBtn.onclick = () => {
      panel.style.display = panel.style.display === "none" ? "block" : "none";
    };
    closeBtn.onclick = () => {
      panel.style.display = "none";
    };

    importCookiesBtn.onclick = () => {
      pasteAndImportCookies();
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
  // 8. Task HUD Timer (Zero-Lag Observer)
  // ==========================================
  function initRunningHubTimerHUD() {
    if (document.getElementById("rh-timer-hud")) return;

    const hud = document.createElement("div");
    hud.id = "rh-timer-hud";
    hud.innerHTML = `<span class="hud-icon">⏱️</span><span id="rh-hud-time">00:00</span>`;

    const hudStyle = document.createElement("style");
    hudStyle.textContent = `
      #rh-timer-hud {
        position: fixed;
        bottom: 24px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 999998;
        background: rgba(18, 18, 22, 0.85);
        border: 1px solid rgba(0, 255, 102, 0.4);
        border-radius: 20px;
        padding: 6px 18px;
        display: none;
        align-items: center;
        gap: 8px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
        font-size: 15px;
        font-weight: 700;
        color: #00FF66;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.6);
        backdrop-filter: blur(4px);
        pointer-events: none;
        user-select: none;
      }
      #rh-timer-hud .hud-icon {
        font-size: 14px;
      }
    `;
    document.head.appendChild(hudStyle);
    document.body.appendChild(hud);

    const timeDisplay = hud.querySelector("#rh-hud-time");
    const targetSelector =
      ".workflow-result-wrap .rh-task-item .rh-task-status > div";

    let observer = null;

    function syncTimer() {
      const rawTimerEl = document.querySelector(targetSelector);
      if (!rawTimerEl) {
        hud.style.display = "none";
        return;
      }

      const text = rawTimerEl.innerText.trim();
      if (text) {
        timeDisplay.textContent = text;
        hud.style.display = "flex";
      } else {
        hud.style.display = "none";
      }
    }

    const listWrap =
      document.querySelector(".workflow-result-wrap .list-wrap") ||
      document.body;

    observer = new MutationObserver(() => {
      syncTimer();
    });

    observer.observe(listWrap, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  // ==========================================
  // 9. Persistent Engine Lifecycle Hook
  // ==========================================
  const lifecycleWatcher = setInterval(() => {
    // 1. Mount gear menu once
    if (document.body && !document.getElementById("rh-floating-root")) {
      createFloatingMenu();
    }

    // 2. Attach canvas hooks when LiteGraph engine initializes
    if (window.LGraphCanvas && !window.LGraphCanvas.prototype.__rh_patched) {
      applyCanvasHooks();
    }

    // 3. Attach execution watcher when websocket API initializes
    if (window.api && !window.__rh_exec_hooked) {
      attachExecutionWatcher();
    }

    // 4. Attach timer observer when task sidebar mounts
    if (
      document.querySelector(".workflow-result-wrap") &&
      !document.getElementById("rh-timer-hud")
    ) {
      initRunningHubTimerHUD();
    }
  }, 500);
})();
