(function () {
  // ==========================================
  // 1. Config & Persistent State
  // ==========================================
  const CONFIG_KEY = "RH_QOL_CONFIG";
  const CUSTOM_SCRIPTS_KEY = "RH_CUSTOM_SCRIPTS_LIST";

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
    JSON.parse(localStorage.getItem(CONFIG_KEY) || "{}"),
  );

  function saveConfig() {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  }

  // Multi-script registry: [{ id, name, code, enabled }]
  let customScripts = JSON.parse(
    localStorage.getItem(CUSTOM_SCRIPTS_KEY) || "[]",
  );

  function saveCustomScripts() {
    localStorage.setItem(CUSTOM_SCRIPTS_KEY, JSON.stringify(customScripts));
  }

  // Run all enabled external scripts
  customScripts.forEach((s) => {
    if (s.enabled && s.code && s.code.trim()) {
      try {
        new Function(s.code)();
      } catch (e) {
        console.error(`[RH Script Error: ${s.name}]`, e);
      }
    }
  });

  // ==========================================
  // 2. Cookie JSON Importer (Global Hotkey & Method)
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

        let cookieStr = `${name}=${value}; path=/; max-age=31536000; SameSite=Lax`;
        if (location.hostname.includes("runninghub")) {
          cookieStr += "; domain=.runninghub.ai";
        }
        document.cookie = cookieStr;

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
      if (text) window.importCookiesFromJSON(text);
    } catch (e) {
      const manualText = prompt("Paste your exported Cookie JSON array here:");
      if (manualText) window.importCookiesFromJSON(manualText);
    }
  }

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
      const url = typeof input === "string" ? input : input?.url || "";
      if (blockedHosts.some((host) => url.includes(host))) {
        return Promise.resolve(
          new Response("", { status: 204, statusText: "No Content" }),
        );
      }
      return originalFetch.apply(this, arguments);
    };
  }

  // ==========================================
  // 4. Dark Grid CSS
  // ==========================================
  const dynamicStyle = document.createElement("style");
  dynamicStyle.id = "rh-custom-styles";
  if (config.darkerGrid) {
    dynamicStyle.textContent = `canvas#graph-canvas { background-color: #121214 !important; }`;
  }
  document.head.appendChild(dynamicStyle);

  // ==========================================
  // 5. Breakpoint & Execution Monitoring
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
          window.app?.graph &&
          window.app?.canvas?.centerOnNode
        ) {
          const node = window.app.graph.getNodeById(executingNodeId);
          if (node) window.app.canvas.centerOnNode(node);
        }

        if (config.autoCancelBreakpoints && stopNodeIds.has(executingNodeId)) {
          console.warn(
            `[RH Breakpoint] Reached stop node #${executingNodeId}. Halting.`,
          );
          triggerRunningHubCancel();
        }
      });
    }
  }

  // ==========================================
  // 6. LiteGraph Canvas Hooks
  // ==========================================
  function applyCanvasHooks() {
    if (
      !window.LGraphCanvas ||
      !window.LGraphCanvas.prototype ||
      window.LGraphCanvas.prototype.__rh_patched
    )
      return;
    window.LGraphCanvas.prototype.__rh_patched = true;

    const originalDrawNode = window.LGraphCanvas.prototype.drawNode;
    window.LGraphCanvas.prototype.drawNode = function (node, ctx) {
      originalDrawNode.apply(this, arguments);

      const isExecuting =
        node.is_executing || node.running || this.node_executing === node;
      const isBreakpoint =
        config.autoCancelBreakpoints && stopNodeIds.has(String(node.id));

      if (config.vectorNodeIndicator && isExecuting) {
        ctx.save();
        const x = node.pos[0] - 6,
          y = node.pos[1] - 6,
          w = node.size[0] + 12,
          h = node.size[1] + 12;
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
          if (isStopNode) stopNodeIds.delete(String(node.id));
          else stopNodeIds.add(String(node.id));
          if (window.app?.canvas) window.app.canvas.setDirty(true, true);
        },
      });
      return options;
    };

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
  // 7. Timer HUD Badge
  // ==========================================
  function initRunningHubTimerHUD() {
    if (document.getElementById("rh-timer-hud")) return;

    const hud = document.createElement("div");
    hud.id = "rh-timer-hud";
    hud.innerHTML = `<span style="font-size:14px;">⏱️</span><span id="rh-hud-time">00:00</span>`;
    hud.style.cssText =
      "position:fixed; bottom:24px; left:50%; transform:translateX(-50%); z-index:999998; background:rgba(18,18,22,0.85); border:1px solid rgba(0,255,102,0.4); border-radius:20px; padding:6px 18px; display:none; align-items:center; gap:8px; font-family:sans-serif; font-size:15px; font-weight:700; color:#00FF66; box-shadow:0 4px 16px rgba(0,0,0,0.6); pointer-events:none; user-select:none;";
    document.body.appendChild(hud);

    const timeDisplay = hud.querySelector("#rh-hud-time");
    const observer = new MutationObserver(() => {
      const raw = document.querySelector(
        ".workflow-result-wrap .rh-task-item .rh-task-status > div",
      );
      if (raw && raw.innerText.trim()) {
        timeDisplay.textContent = raw.innerText.trim();
        hud.style.display = "flex";
      } else {
        hud.style.display = "none";
      }
    });

    const wrap =
      document.querySelector(".workflow-result-wrap .list-wrap") ||
      document.querySelector(".workflow-result-wrap") ||
      document.body;
    observer.observe(wrap, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  // ==========================================
  // 8. Unified Manager UI (Core Toggles + UserScript Toggles)
  // ==========================================
  function createFloatingMenu() {
    if (document.getElementById("rh-floating-root")) return;

    const container = document.createElement("div");
    container.id = "rh-floating-root";
    container.innerHTML = `
      <div id="rh-toggle-btn" title="RH Settings & Scripts">⚙️</div>
      <div id="rh-settings-panel" style="display: none;">
        <div style="font-weight: bold; margin-bottom: 8px; font-size: 13px; border-bottom: 1px solid #333; padding-bottom: 4px; display: flex; justify-content: space-between; align-items: center;">
          <span>QoL & Script Manager</span>
          <span id="rh-close-btn" style="cursor:pointer; color:#777; font-size: 16px;">✕</span>
        </div>

        <button id="rh-import-cookies-btn" style="width: 100%; margin-bottom: 10px; padding: 6px; background: #2b2b36; border: 1px solid #00FF66; color: #00FF66; border-radius: 4px; cursor: pointer; font-size: 11px; font-weight: bold;">📋 Paste Cookies (JSON)</button>

        <div style="font-size: 11px; color: #888; font-weight: bold; margin-bottom: 4px; text-transform: uppercase;">Core Features:</div>
        <div id="rh-core-toggles" style="margin-bottom: 8px;">
          ${Object.keys(DEFAULT_CONFIG)
            .map(
              (key) => `
            <label style="display: flex; justify-content: space-between; align-items: center; margin: 5px 0; font-size: 11px; cursor: pointer;">
              <span>${key}</span>
              <input type="checkbox" data-core-key="${key}" ${config[key] ? "checked" : ""} style="cursor: pointer;">
            </label>
          `,
            )
            .join("")}
        </div>

        <div style="font-size: 11px; color: #888; font-weight: bold; margin: 8px 0 4px 0; border-top: 1px solid #333; padding-top: 6px; text-transform: uppercase;">Custom UserScripts:</div>
        <div id="rh-user-script-list" style="max-height: 80px; overflow-y: auto; margin-bottom: 6px;"></div>

        <div style="display: flex; gap: 4px; margin-bottom: 6px;">
          <input id="rh-new-script-name" type="text" placeholder="Script Name (e.g. AutoZoom)" style="flex: 1; background: #0e0e12; border: 1px solid #333; color: #fff; padding: 4px; font-size: 10px; border-radius: 4px;">
        </div>
        <textarea id="rh-new-script-code" rows="4" placeholder="// Paste custom JS code here..." style="width: 100%; box-sizing: border-box; background: #0e0e12; border: 1px solid #333; color: #00FF66; font-family: monospace; font-size: 10px; padding: 4px; border-radius: 4px; resize: vertical;"></textarea>

        <button id="rh-add-script-btn" style="width: 100%; margin-top: 4px; padding: 4px; background: #223344; border: 1px solid #335577; color: #88ccff; border-radius: 4px; cursor: pointer; font-size: 10px;">➕ Add Script</button>

        <div style="display: flex; gap: 6px; margin-top: 10px; border-top: 1px solid #333; padding-top: 8px;">
          <button id="rh-save-apply-btn" style="width: 100%; padding: 6px; background: #00AA55; border: none; color: #fff; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: bold;">Save & Reload</button>
        </div>
      </div>
    `;

    const menuStyle = document.createElement("style");
    menuStyle.textContent = `
      #rh-floating-root { position: fixed; bottom: 20px; right: 20px; z-index: 999999; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
      #rh-toggle-btn { width: 36px; height: 36px; background: #1e1e24; border: 1px solid #444; border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer; font-size: 16px; box-shadow: 0 4px 12px rgba(0,0,0,0.5); user-select: none; transition: transform 0.15s ease; }
      #rh-toggle-btn:hover { transform: scale(1.08); }
      #rh-settings-panel { position: absolute; bottom: 46px; right: 0; width: 310px; max-height: 520px; overflow-y: auto; background: #16161a; border: 1px solid #333; border-radius: 8px; padding: 12px; color: #ddd; box-shadow: 0 8px 24px rgba(0,0,0,0.7); }
    `;
    document.head.appendChild(menuStyle);
    document.body.appendChild(container);

    const toggleBtn = container.querySelector("#rh-toggle-btn");
    const panel = container.querySelector("#rh-settings-panel");
    const closeBtn = container.querySelector("#rh-close-btn");
    const importCookiesBtn = container.querySelector("#rh-import-cookies-btn");
    const userScriptList = container.querySelector("#rh-user-script-list");
    const newScriptName = container.querySelector("#rh-new-script-name");
    const newScriptCode = container.querySelector("#rh-new-script-code");
    const addScriptBtn = container.querySelector("#rh-add-script-btn");
    const saveApplyBtn = container.querySelector("#rh-save-apply-btn");

    function renderCustomScriptList() {
      if (customScripts.length === 0) {
        userScriptList.innerHTML = `<div style="font-size: 10px; color: #666; font-style: italic;">No extra custom scripts added.</div>`;
        return;
      }
      userScriptList.innerHTML = customScripts
        .map(
          (s, idx) => `
        <div style="display: flex; justify-content: space-between; align-items: center; margin: 4px 0; background: #101014; padding: 3px 6px; border-radius: 4px; font-size: 11px;">
          <label style="cursor: pointer; display: flex; align-items: center; gap: 6px;">
            <input type="checkbox" data-script-idx="${idx}" ${s.enabled ? "checked" : ""}>
            <span style="max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${s.name}</span>
          </label>
          <span class="rh-delete-script" data-delete-idx="${idx}" style="cursor: pointer; color: #ff5555; font-size: 12px;" title="Delete">🗑️</span>
        </div>
      `,
        )
        .join("");

      userScriptList.querySelectorAll(".rh-delete-script").forEach((delBtn) => {
        delBtn.onclick = (e) => {
          const idx = parseInt(e.target.dataset.deleteIdx, 10);
          customScripts.splice(idx, 1);
          renderCustomScriptList();
        };
      });
    }

    renderCustomScriptList();

    toggleBtn.onclick = () => {
      panel.style.display = panel.style.display === "none" ? "block" : "none";
    };
    closeBtn.onclick = () => {
      panel.style.display = "none";
    };
    importCookiesBtn.onclick = () => {
      pasteAndImportCookies();
    };

    addScriptBtn.onclick = () => {
      const name =
        newScriptName.value.trim() || `Script #${customScripts.length + 1}`;
      const code = newScriptCode.value.trim();
      if (!code) {
        alert("Please enter script code.");
        return;
      }
      customScripts.push({ id: Date.now(), name, code, enabled: true });
      newScriptName.value = "";
      newScriptCode.value = "";
      renderCustomScriptList();
    };

    saveApplyBtn.onclick = () => {
      // Save Core Toggles
      container.querySelectorAll("input[data-core-key]").forEach((input) => {
        config[input.dataset.coreKey] = input.checked;
      });
      saveConfig();

      // Save Custom Script Toggles
      container.querySelectorAll("input[data-script-idx]").forEach((input) => {
        const idx = parseInt(input.dataset.scriptIdx, 10);
        if (customScripts[idx]) {
          customScripts[idx].enabled = input.checked;
        }
      });
      saveCustomScripts();

      location.reload();
    };
  }

  // ==========================================
  // 9. Startup Poller
  // ==========================================
  setInterval(() => {
    if (document.body && !document.getElementById("rh-floating-root")) {
      createFloatingMenu();
    }
    if (window.LGraphCanvas && !window.LGraphCanvas.prototype.__rh_patched) {
      applyCanvasHooks();
    }
    if (window.api && !window.__rh_exec_hooked) {
      attachExecutionWatcher();
    }
    if (
      document.querySelector(".workflow-result-wrap") &&
      !document.getElementById("rh-timer-hud")
    ) {
      initRunningHubTimerHUD();
    }
  }, 500);
})();
