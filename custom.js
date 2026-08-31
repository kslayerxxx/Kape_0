(function () {
  // --- 1. Settings & Persistence ---
  const DEFAULT_CONFIG = {
    blockTelemetry: true,
    fpsOptimization: true,
    vectorNodeIndicator: true,
    enhancedWires: true,
    darkerGrid: true,
    autoCenterRunningNode: false,
    customShortcuts: true,
  };

  const config = Object.assign(
    {},
    DEFAULT_CONFIG,
    JSON.parse(localStorage.getItem("RH_QOL_CONFIG") || "{}"),
  );

  function saveConfig() {
    localStorage.setItem("RH_QOL_CONFIG", JSON.stringify(config));
  }

  // --- 2. Telemetry & Analytics Blocker ---
  if (config.blockTelemetry) {
    const blockedHosts = [
      "google-analytics.com",
      "googletagmanager.com",
      "hm.baidu.com",
      "clarity.ms",
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

  // --- 3. Style Injections (Zero GPU Blur Overhead) ---
  const dynamicStyle = document.createElement("style");
  dynamicStyle.id = "rh-custom-styles";
  let css = "";
  if (config.darkerGrid) {
    css += `
      canvas#graph-canvas { 
        background-color: #121214 !important; 
      }
    `;
  }
  dynamicStyle.textContent = css;
  document.head.appendChild(dynamicStyle);

  // --- 4. ComfyUI / LiteGraph Canvas Hooks ---
  function applyCanvasHooks() {
    if (!window.LGraphCanvas || !window.LGraphCanvas.prototype) return;

    // A. Zero-Lag Vector Active Node Indicator (Reticles + Concentric Borders)
    if (
      config.vectorNodeIndicator &&
      !window.LGraphCanvas.prototype.__pake_vector_glow
    ) {
      window.LGraphCanvas.prototype.__pake_vector_glow = true;
      const originalDrawNode = window.LGraphCanvas.prototype.drawNode;

      window.LGraphCanvas.prototype.drawNode = function (node, ctx) {
        originalDrawNode.apply(this, arguments);

        if (node.is_executing || node.running || this.node_executing === node) {
          ctx.save();

          const x = node.pos[0] - 6;
          const y = node.pos[1] - 6;
          const w = node.size[0] + 12;
          const h = node.size[1] + 12;

          // Outer solid translucent boundary
          ctx.lineWidth = 10;
          ctx.strokeStyle = "rgba(0, 255, 102, 0.25)";
          ctx.strokeRect(x - 2, y - 2, w + 4, h + 4);

          // Inner solid high-contrast neon green border
          ctx.lineWidth = 4;
          ctx.strokeStyle = "#00FF66";
          ctx.strokeRect(x, y, w, h);

          // High-visibility white corner target reticles
          const len = 16;
          ctx.lineWidth = 6;
          ctx.strokeStyle = "#FFFFFF";

          ctx.beginPath();
          // Top-Left & Top-Right
          ctx.moveTo(x, y + len);
          ctx.lineTo(x, y);
          ctx.lineTo(x + len, y);
          ctx.moveTo(x + w - len, y);
          ctx.lineTo(x + w, y);
          ctx.lineTo(x + w, y + len);
          // Bottom-Left & Bottom-Right
          ctx.moveTo(x, y + h - len);
          ctx.lineTo(x, y + h);
          ctx.lineTo(x + len, y + h);
          ctx.moveTo(x + w - len, y + h);
          ctx.lineTo(x + w, y + h);
          ctx.lineTo(x + w, y + h - len);
          ctx.stroke();

          ctx.restore();
        }
      };
    }

    // B. Low-Spec GPU Optimization (Strip redundant passes)
    if (config.fpsOptimization) {
      window.LGraphCanvas.prototype.render_shadows = false;
      window.LGraphCanvas.prototype.render_connections_border = false;
      window.LGraphCanvas.prototype.highquality_render = false;
    }

    // C. High-Contrast Wires
    if (config.enhancedWires && window.LiteGraph) {
      window.LiteGraph.LINK_RENDER_MODE = 2;
    }

    // D. Auto-Pan Viewport on Node Execution
    if (config.autoCenterRunningNode && window.app && window.app.canvas) {
      Object.defineProperty(window.app.canvas, "node_executing", {
        set: function (node) {
          this._node_executing = node;
          if (node && node.pos) {
            this.centerOnNode(node);
          }
        },
        get: function () {
          return this._node_executing;
        },
      });
    }
  }

  // --- 5. Global Keyboard Shortcuts ---
  window.addEventListener("keydown", (e) => {
    if (
      !config.customShortcuts ||
      ["INPUT", "TEXTAREA"].includes(e.target.tagName)
    )
      return;

    // Press 'F' to fit workflow on screen
    if (e.key === "f" && window.app && window.app.canvas) {
      window.app.canvas.fitGraphToView();
    }

    // Press 'M' to toggle mute on selected nodes
    if (
      e.key === "m" &&
      window.app &&
      window.app.canvas &&
      window.app.canvas.selected_nodes
    ) {
      Object.values(window.app.canvas.selected_nodes).forEach((node) => {
        node.mode = node.mode === 2 ? 0 : 2;
      });
      window.app.canvas.setDirty(true, true);
    }
  });

  // --- 6. Lightweight Isolated Floating Toggle Menu ---
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

  // --- 7. Initialization Poller ---
  const initTimer = setInterval(() => {
    if (document.body && !document.getElementById("rh-floating-root")) {
      createFloatingMenu();
    }
    if (window.LGraphCanvas) {
      applyCanvasHooks();
      clearInterval(initTimer);
    }
  }, 1000);
})();
