(function () {
  // Prevent duplicate instances across lifecycle re-runs
  if (window.__RH_EXT_INITIALIZED__) return;
  window.__RH_EXT_INITIALIZED__ = true;

  // ==========================================
  // 1. Popup Window & Title Bar Normalization
  // ==========================================
  try {
    document.title = "RunningHub";
    Object.defineProperty(document, "title", {
      get() { return "RunningHub"; },
      set() {}
    });
    const titleEl = document.querySelector("title");
    if (titleEl) {
      new MutationObserver(() => {
        if (titleEl.textContent !== "RunningHub") titleEl.textContent = "RunningHub";
      }).observe(titleEl, { childList: true });
    }
  } catch (e) {}

  // Prevent auto-maximized / glitchy popups on workflow launch
  const origOpen = window.open;
  window.open = function (url, target, features) {
    const isWorkflow = typeof url === "string" && (url.includes("task") || url.includes("workflow") || url.includes("comfy"));
    const customFeatures = isWorkflow ? "width=1400,height=900,resizable=yes,scrollbars=yes" : features;
    return origOpen.call(this, url, target, customFeatures || features);
  };

  // ==========================================
  // 2. Configuration & Persistence
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
    JSON.parse(localStorage.getItem(CONFIG_KEY) || "{}")
  );

  function saveConfig() {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  }

  // Sanitize localStorage custom scripts to prevent recursive lockups
  let customScripts = [];
  try {
    const rawScripts = JSON.parse(localStorage.getItem(CUSTOM_SCRIPTS_KEY) || "[]");
    customScripts = rawScripts.filter(
      (s) => s && s.code && !s.code.includes("RH_QOL_CONFIG") && !s.code.includes("createFloatingMenu")
    );
    if (rawScripts.length !== customScripts.length) {
      localStorage.setItem(CUSTOM_SCRIPTS_KEY, JSON.stringify(customScripts));
    }
  } catch (e) {
    customScripts = [];
    localStorage.removeItem(CUSTOM_SCRIPTS_KEY);
  }

  function saveCustomScripts() {
    localStorage.setItem(CUSTOM_SCRIPTS_KEY, JSON.stringify(customScripts));
  }

  // Execute clean UserScripts safely
  customScripts.forEach((s) => {
    if (s.enabled && s.code && s.code.trim()) {
      try {
        new Function(s.code)();
      } catch (e) {
        console.error(`[RH UserScript Error: ${s.name}]`, e);
      }
    }
  });

  // ==========================================
  // 3. Cookie JSON Importer (Ctrl+Shift+V)
  // ==========================================
  window.importCookiesFromJSON = function (jsonInput) {
    try {
      const cookies = typeof jsonInput === "string" ? JSON.parse(jsonInput) : jsonInput;
      if (!Array.isArray(cookies)) {
        alert("Invalid format: Expected a JSON array of cookies.");
        return false;
      }

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
        if (lowerKey.includes("token") || lowerKey.includes("auth") || lowerKey.includes("session")) {
          try {
            localStorage.setItem(c.name, c.value);
            sessionStorage.setItem(c.name, c.value);
          } catch (e) {}
        }
      });

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
  // 4. Telemetry Blocker
  // ==========================================
  if (config.blockTelemetry) {
    const blockedHosts = [
      "google-analytics.com",
      "googletagmanager.com",
      "hm.baidu.com",
      "clarity.ms",
      "sentry.io",
    ];
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === "string" ? input : input?.url || "";
      if (blockedHosts.some((h) => url.includes(h))) {
        return Promise.resolve(new Response("", { status: 204, statusText: "No Content" }));
      }
      return origFetch.apply(this, arguments);
    };
  }

  // ==========================================
  // 5. ComfyUI Canvas & Execution Engine
  // ==========================================
  const stopNodeIds = new Set();
  let lastExecutedNodeId = null;

  function triggerRHInterrupt(iWin, iDoc) {
    if (iWin.api && typeof iWin.api.interrupt === "function") {
      iWin.api.interrupt();
    }
    const cancelBtn =
      document.querySelector(".workflow-result-wrap .rh-cancel-btn, .rh-cancel-btn, [class*='cancel']") ||
      iDoc.querySelector(".rh-cancel-btn, [class*='cancel']");
    if (cancelBtn) cancelBtn.click();
  }

  function injectCanvasEngine() {
    const iframe =
      document.querySelector('iframe[src*="comfyUI.html"]') ||
      document.querySelector("iframe");

    if (!iframe) return;

    let iWin, iDoc;
    try {
      iWin = iframe.contentWindow;
      iDoc = iframe.contentDocument || iWin.document;
    } catch (e) {
      return;
    }

    if (!iWin || !iDoc) return;

    // Dark canvas background & smooth panning CSS
    if (config.darkerGrid && !iDoc.getElementById("rh-canvas-perf-style")) {
      const st = iDoc.createElement("style");
      st.id = "rh-canvas-perf-style";
      st.textContent = `
        body, html, canvas#graph-canvas { 
          background-color: #101012 !important; 
        }
        .litegraph .lgraphcanvas { 
          background-color: #101012 !important; 
        }
        canvas#graph-canvas {
          touch-action: none !important;
          image-rendering: -webkit-optimize-contrast !important;
          will-change: transform !important;
        }
      `;
      iDoc.head.appendChild(st);
    }

    if (!iWin.LGraphCanvas || !iWin.LGraphCanvas.prototype) return;

    // Attach overrides safely once
    if (!iWin.LGraphCanvas.prototype.__rh_attached) {
      iWin.LGraphCanvas.prototype.__rh_attached = true;

      if (config.darkerGrid) {
        iWin.LGraphCanvas.prototype.clear_background = "#101012";
      }

      if (config.enhancedWires && iWin.LiteGraph) {
        iWin.LiteGraph.LINK_RENDER_MODE = 2;
      }

      if (config.fpsOptimization) {
        iWin.LGraphCanvas.prototype.render_shadows = false;
        iWin.LGraphCanvas.prototype.render_connections_border = false;
        iWin.LGraphCanvas.prototype.highquality_render = false;
      }

      // 1. Vector Indicator & Breakpoint Render
      const originalDrawNode = iWin.LGraphCanvas.prototype.drawNode;
      iWin.LGraphCanvas.prototype.drawNode = function (node, ctx) {
        originalDrawNode.apply(this, arguments);

        const isRunning = node.is_executing || node.running || this.node_executing === node;
        const isBreakpoint = config.autoCancelBreakpoints && stopNodeIds.has(String(node.id));

        if (config.vectorNodeIndicator && isRunning) {
          ctx.save();
          const x = node.pos[0] - 6, y = node.pos[1] - 6, w = node.size[0] + 12, h = node.size[1] + 12;
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
          ctx.moveTo(x, y + len); ctx.lineTo(x, y); ctx.lineTo(x + len, y);
          ctx.moveTo(x + w - len, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + len);
          ctx.moveTo(x, y + h - len); ctx.lineTo(x, y + h); ctx.lineTo(x + len, y + h);
          ctx.moveTo(x + w - len, y + h); ctx.lineTo(x + w, y + h); ctx.moveTo(x + w, y + h - len);
          ctx.stroke();
          ctx.restore();
        }

        if (isBreakpoint) {
          ctx.save();
          ctx.lineWidth = 4;
          ctx.strokeStyle = "#FF3344";
          ctx.strokeRect(node.pos[0] - 2, node.pos[1] - 2, node.size[0] + 4, node.size[1] + 4);
          ctx.fillStyle = "#FF3344";
          ctx.font = "bold 12px monospace";
          ctx.fillText("🛑 AUTO-CANCEL STOP", node.pos[0], node.pos[1] - 8);
          ctx.restore();
        }
      };

      // 2. Right-Click Breakpoint Menu
      const originalGetNodeMenuOptions = iWin.LGraphCanvas.prototype.getNodeMenuOptions;
      iWin.LGraphCanvas.prototype.getNodeMenuOptions = function (node) {
        const options = originalGetNodeMenuOptions ? originalGetNodeMenuOptions.apply(this, arguments) : [];
        const isStopNode = stopNodeIds.has(String(node.id));
        
        const hasExisting = options.some(o => o?.content?.includes("Auto-Cancel") || o?.content?.includes("Stop Breakpoint"));
        if (!hasExisting) {
          options.push({
            content: isStopNode ? "🛑 Remove Stop Breakpoint" : "🛑 Set Auto-Cancel Breakpoint",
            callback: () => {
              if (isStopNode) stopNodeIds.delete(String(node.id));
              else stopNodeIds.add(String(node.id));
              
              if (iWin.app?.canvas) {
                iWin.app.canvas.setDirty(true, true);
                iWin.app.canvas.draw(true, true);
              }
            },
          });
        }
        return options;
      };
    }

    // 3. Execution Listener & Breakpoint Interrupter
    if (iWin.api && !iWin.__rh_api_hooked) {
      iWin.__rh_api_hooked = true;
      iWin.api.addEventListener("executing", (e) => {
        const executingNodeId = String(e.detail);
        if (!executingNodeId || executingNodeId === lastExecutedNodeId) return;
        lastExecutedNodeId = executingNodeId;

        if (config.autoCenterRunningNode && iWin.app?.graph && iWin.app?.canvas?.centerOnNode) {
          const node = iWin.app.graph.getNodeById(executingNodeId);
          if (node) iWin.app.canvas.centerOnNode(node);
        }

        if (config.autoCancelBreakpoints && stopNodeIds.has(executingNodeId)) {
          triggerRHInterrupt(iWin, iDoc);
        }
      });
    }
  }

  // ==========================================
  // 6. Task Timer HUD
  // ==========================================
  function initTaskTimerHUD() {
    if (document.getElementById("rh-timer-hud")) return;

    const hud = document.createElement("div");
    hud.id = "rh-timer-hud";
    hud.innerHTML = `<span style="font-size:14px;">⏱️</span><span id="rh-hud-time">00:00</span>`;
    hud.style.cssText =
      "position:fixed; bottom:24px; left:50%; transform:translateX(-50%); z-index:999998; background:rgba(18,18,22,0.9); border:1px solid rgba(0,255,102,0.5); border-radius:20px; padding:6px 18px; display:none; align-items:center; gap:8px; font-family:monospace; font-size:15px; font-weight:700; color:#00FF66; box-shadow:0 4px 16px rgba(0,0,0,0.7); pointer-events:none; user-select:none;";
    document.body.appendChild(hud);

    const timeDisplay = hud.querySelector("#rh-hud-time");
    const observer = new MutationObserver(() => {
      const taskWrap = document.querySelector(".workflow-result-wrap");
      if (taskWrap) {
        const timeEl = taskWrap.querySelector(".rh-task-status > div, .rh-task-time, [class*='status']");
        if (timeEl && timeEl.innerText.trim()) {
          timeDisplay.textContent = timeEl.innerText.trim();
          hud.style.display = "flex";
          return;
        }
      }
      hud.style.display = "none";
    });

    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  // ==========================================
  // 7. Draggable Floating Settings UI
  // ==========================================
  function createFloatingMenu() {
    if (document.getElementById("rh-floating-root")) return;

    const POS_KEY = "RH_FLOATING_POS";
    const savedPos = JSON.parse(localStorage.getItem(POS_KEY) || '{"x": 20, "y": 20}');

    const container = document.createElement("div");
    container.id = "rh-floating-root";
    container.innerHTML = `
      <div id="rh-toggle-btn" title="Drag to move / Click for Settings">⚙️</div>
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
          `
            )
            .join("")}
        </div>

        <div style="font-size: 11px; color: #888; font-weight: bold; margin: 8px 0 4px 0; border-top: 1px solid #333; padding-top: 6px; text-transform: uppercase;">Custom UserScripts:</div>
        <div id="rh-user-script-list" style="max-height: 80px; overflow-y: auto; margin-bottom: 6px;"></div>

        <div style="display: flex; gap: 4px; margin-bottom: 6px;">
          <input id="rh-new-script-name" type="text" placeholder="Script Name" style="flex: 1; background: #0e0e12; border: 1px solid #333; color: #fff; padding: 4px; font-size: 10px; border-radius: 4px;">
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
      #rh-floating-root { 
        position: fixed; 
        z-index: 999999; 
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        touch-action: none;
      }
      #rh-toggle-btn { 
        width: 38px; 
        height: 38px; 
        background: #1e1e24; 
        border: 1px solid #444; 
        border-radius: 50%; 
        display: flex; 
        align-items: center; 
        justify-content: center; 
        cursor: grab; 
        font-size: 17px; 
        box-shadow: 0 4px 12px rgba(0,0,0,0.5); 
        user-select: none; 
        transition: transform 0.1s ease, border-color 0.2s ease; 
      }
      #rh-toggle-btn:active { cursor: grabbing; transform: scale(0.95); border-color: #00FF66; }
      #rh-settings-panel { 
        position: absolute; 
        bottom: 46px; 
        left: 0; 
        width: 310px; 
        max-height: 520px; 
        overflow-y: auto; 
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

    container.style.left = savedPos.x + "px";
    container.style.top = savedPos.y + "px";

    function adjustPanelPosition() {
      const rect = container.getBoundingClientRect();
      const panel = container.querySelector("#rh-settings-panel");
      if (!panel) return;

      if (rect.top < 300) {
        panel.style.bottom = "auto";
        panel.style.top = "46px";
      } else {
        panel.style.top = "auto";
        panel.style.bottom = "46px";
      }

      if (rect.left > window.innerWidth - 320) {
        panel.style.left = "auto";
        panel.style.right = "0";
      } else {
        panel.style.right = "auto";
        panel.style.left = "0";
      }
    }

    const toggleBtn = container.querySelector("#rh-toggle-btn");
    const panel = container.querySelector("#rh-settings-panel");

    let isDragging = false;
    let startX = 0, startY = 0;
    let initialLeft = 0, initialTop = 0;
    let dragDistance = 0;

    toggleBtn.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;

      const rect = container.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;
      dragDistance = 0;

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    });

    function onMouseMove(e) {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      dragDistance = Math.hypot(dx, dy);

      let nextX = initialLeft + dx;
      let nextY = initialTop + dy;

      const maxX = window.innerWidth - 44;
      const maxY = window.innerHeight - 44;
      nextX = Math.max(8, Math.min(nextX, maxX));
      nextY = Math.max(8, Math.min(nextY, maxY));

      container.style.left = nextX + "px";
      container.style.top = nextY + "px";
    }

    function onMouseUp() {
      if (!isDragging) return;
      isDragging = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);

      const rect = container.getBoundingClientRect();
      localStorage.setItem(POS_KEY, JSON.stringify({ x: Math.round(rect.left), y: Math.round(rect.top) }));
      adjustPanelPosition();
    }

    toggleBtn.addEventListener("click", () => {
      if (dragDistance > 5) return;
      adjustPanelPosition();
      panel.style.display = panel.style.display === "none" ? "block" : "none";
    });

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
      `
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

    closeBtn.onclick = () => { panel.style.display = "none"; };
    importCookiesBtn.onclick = () => { pasteAndImportCookies(); };

    addScriptBtn.onclick = () => {
      const name = newScriptName.value.trim() || `Script #${customScripts.length + 1}`;
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
      container.querySelectorAll("input[data-core-key]").forEach((input) => {
        config[input.dataset.coreKey] = input.checked;
      });
      saveConfig();

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
  // 8. Lifecycle Poller
  // ==========================================
  setInterval(() => {
    if (document.body && !document.getElementById("rh-floating-root")) {
      createFloatingMenu();
    }
    injectCanvasEngine();
    initTaskTimerHUD();
  }, 600);
})();
