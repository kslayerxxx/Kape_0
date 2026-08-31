/* ==========================================================================
 * RunningHub ComfyUI Desktop Wrapper — custom_r.js (HARDENED v2.3 — FINAL)
 * --------------------------------------------------------------------------
 * Verified RH stack (user-captured):
 *  - Vue SPA (#appVue), Ant Design toasts (#rh-message-root / .ant-message)
 *  - Live task: .rh-task-item > .history-top-info > .rh-cancel-btn ("Cancel")
 *  - Cancel acts IMMEDIATELY (no confirm dialog) + transient success toast
 *  - ComfyUI runs DIRECTLY in /workflow/<id> popup window (no iframe)
 *
 * Fixes in this build (vs v2.2):
 *  [FIX-13] Cancel flow rebuilt from verified RH behavior:
 *    - click .rh-task-item .rh-cancel-btn (exact "Cancel" button)
 *    - NO confirm-dialog code (removed — RH cancels instantly; v2.2's
 *      el-message-box clicker targeted the wrong UI library anyway)
 *    - VERIFICATION: watches #rh-message-root for the "Cancelled"/success
 *      toast and stops retrying the moment RH confirms the cancel landed
 *    - retry loop (8x / 800ms) only continues while unconfirmed
 *  [FIX-8] /workflow/<id> URLs trigger direct-window engine attachment
 *  [FIX-9] Rect-based visibility (fixed-position sidebar elements pass)
 *  [FIX-10] Selector priority per verified RH DOM
 *  [FIX-11] HUD scoped to .rh-task-item with wrapper fallbacks
 *  [FIX-3] drawNode transform-snapshot (breakpoint box aligned to node)
 *  [FIX-5] Event-driven running-node tracking (no node.is_executing needed)
 *  [FIX-6] Wires: link_render_mode/connections_width enforced on LIVE canvas
 * ========================================================================== */
(function () {
  "use strict";

  if (window.__RH_EXT_INITIALIZED__) return;

  const TAG = "[RH Ext]";
  const cleanups = [];

  let IN_IFRAME = false;
  try { IN_IFRAME = window.self !== window.top; } catch (_) { IN_IFRAME = true; }
  const IS_POPUP = !!(window.opener && window.opener !== window);
  const SHOW_FLOATING_UI = !IS_POPUP && !IN_IFRAME;

  try {

  // ==========================================
  // 0. Utilities
  // ==========================================
  function safeParse(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (raw == null) return fallback;
      const val = JSON.parse(raw);
      return val == null ? fallback : val;
    } catch (e) {
      console.warn(TAG, `Corrupted localStorage key "${key}" — resetting.`, e);
      try { localStorage.removeItem(key); } catch (_) {}
      return fallback;
    }
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }

  function rhToast(msg, ms) {
    try {
      let host = document.getElementById("rh-toast-host");
      if (!host || !host.isConnected) {
        host = document.createElement("div");
        host.id = "rh-toast-host";
        host.style.cssText =
          "position:fixed;bottom:70px;left:50%;transform:translateX(-50%);z-index:1000000;" +
          "display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none;";
        (document.body || document.documentElement).appendChild(host);
      }
      const el = document.createElement("div");
      el.textContent = msg;
      el.style.cssText =
        "background:rgba(18,18,22,0.95);border:1px solid rgba(0,255,102,0.5);color:#00FF66;" +
        "border-radius:8px;padding:8px 16px;font:600 13px/1.4 monospace;" +
        "box-shadow:0 4px 16px rgba(0,0,0,0.7);opacity:0;transition:opacity .18s ease;";
      host.appendChild(el);
      requestAnimationFrame(() => { el.style.opacity = "1"; });
      setTimeout(() => { el.style.opacity = "0"; setTimeout(() => el.remove(), 220); }, ms || 2600);
    } catch (e) {
      console.warn(TAG, "toast:", msg, e);
    }
  }

  function openPasteModal(title, placeholder, onSubmit) {
    try {
      if (document.getElementById("rh-modal-overlay")) return;
      const ov = document.createElement("div");
      ov.id = "rh-modal-overlay";
      ov.style.cssText =
        "position:fixed;inset:0;z-index:1000001;background:rgba(0,0,0,.55);" +
        "display:flex;align-items:center;justify-content:center;";
      ov.innerHTML = `
        <div style="width:440px;max-width:92vw;background:#16161a;border:1px solid #333;border-radius:8px;padding:14px;color:#ddd;font-family:monospace;box-shadow:0 12px 40px rgba(0,0,0,.8);">
          <div style="font-weight:bold;margin-bottom:8px;font-size:13px;">${esc(title)}</div>
          <textarea id="rh-modal-text" rows="8" placeholder="${esc(placeholder)}"
            style="width:100%;box-sizing:border-box;background:#0e0e12;border:1px solid #333;color:#00FF66;padding:6px;border-radius:4px;font-family:monospace;font-size:11px;resize:vertical;"></textarea>
          <div style="display:flex;gap:8px;margin-top:10px;">
            <button id="rh-modal-ok" style="flex:1;padding:6px;background:#00AA55;border:none;color:#fff;border-radius:4px;font-weight:bold;cursor:pointer;">Import</button>
            <button id="rh-modal-cancel" style="flex:1;padding:6px;background:#2b2b36;border:1px solid #444;color:#ccc;border-radius:4px;cursor:pointer;">Cancel</button>
          </div>
        </div>`;
      document.body.appendChild(ov);
      const close = () => ov.remove();
      ov.querySelector("#rh-modal-cancel").addEventListener("click", close);
      ov.querySelector("#rh-modal-ok").addEventListener("click", () => {
        const v = ov.querySelector("#rh-modal-text").value;
        close();
        if (v && v.trim()) onSubmit(v.trim());
      });
      const ta = ov.querySelector("#rh-modal-text");
      ta.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
      ta.focus();
    } catch (e) {
      console.error(TAG, "modal failed", e);
    }
  }

  // ==========================================
  // 1. Popup Window & Title Normalization
  // ==========================================
  if (!IS_POPUP) {
    try {
      document.title = "RunningHub";
      Object.defineProperty(document, "title", {
        configurable: true,
        get() { return "RunningHub"; },
        set() {},
      });
    } catch (e) {
      console.warn(TAG, "title override failed (poller fallback active)", e);
    }
  }

  function isWorkflowUrl(url) {
    if (typeof url !== "string" || !url) return false;
    try {
      const u = new URL(url, location.href);
      if (/(^|\/)(task|workflow|comfy)/.test(u.pathname.toLowerCase())) return true;
      return u.searchParams.has("task_id") || u.searchParams.has("workflow_id");
    } catch (e) { return false; }
  }

  function patchWindowOpen(w) {
    if (!w || w.__RH_OPEN_PATCHED__) return;
    w.__RH_OPEN_PATCHED__ = true;
    const origOpen = w.open.bind(w);
    try {
      w.open = function (url, target, features) {
        try {
          if (isWorkflowUrl(url)) {
            return origOpen(url, target, "width=1400,height=900,resizable=yes,scrollbars=yes");
          }
        } catch (e) { console.warn(TAG, "open-patch check failed", e); }
        return origOpen(url, target, features);
      };
    } catch (e) { console.warn(TAG, "could not patch window.open", e); }
  }
  patchWindowOpen(window);

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

  const config = Object.assign({}, DEFAULT_CONFIG, safeParse(CONFIG_KEY, {}));

  function saveConfig() {
    try { localStorage.setItem(CONFIG_KEY, JSON.stringify(config)); }
    catch (e) { console.warn(TAG, "saveConfig failed", e); }
  }

  let customScripts = [];
  try {
    const rawScripts = safeParse(CUSTOM_SCRIPTS_KEY, []);
    if (Array.isArray(rawScripts)) {
      customScripts = rawScripts.filter(
        (s) => s && s.code && !s.code.includes("RH_QOL_CONFIG") && !s.code.includes("createFloatingMenu")
      );
      if (rawScripts.length !== customScripts.length) {
        localStorage.setItem(CUSTOM_SCRIPTS_KEY, JSON.stringify(customScripts));
      }
    }
  } catch (e) {
    customScripts = [];
    try { localStorage.removeItem(CUSTOM_SCRIPTS_KEY); } catch (_) {}
  }

  function saveCustomScripts() {
    try { localStorage.setItem(CUSTOM_SCRIPTS_KEY, JSON.stringify(customScripts)); }
    catch (e) { console.warn(TAG, "saveCustomScripts failed", e); }
  }

  customScripts.forEach((s) => {
    if (s.enabled && s.code && s.code.trim()) {
      try { new Function(s.code)(); }
      catch (e) {
        console.error(TAG, `UserScript error: ${s.name}`, e);
        rhToast(`⚠️ UserScript "${s.name}" failed — see console`);
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
        rhToast("❌ Invalid format: expected a JSON array of cookies");
        return false;
      }
      cookies.forEach((c) => {
        if (!c.name || c.value === undefined) return;
        const name = encodeURIComponent(c.name.trim());
        const value = encodeURIComponent(c.value.trim());
        let cookieStr = `${name}=${value}; path=/; max-age=31536000; SameSite=Lax`;
        if (location.hostname.includes("runninghub")) cookieStr += "; domain=.runninghub.ai";
        document.cookie = cookieStr;
        const lowerKey = c.name.toLowerCase();
        if (lowerKey.includes("token") || lowerKey.includes("auth") || lowerKey.includes("session")) {
          try {
            localStorage.setItem(c.name, c.value);
            sessionStorage.setItem(c.name, c.value);
          } catch (_) {}
        }
      });
      rhToast(`✅ Imported ${cookies.length} cookie(s) — reloading…`);
      setTimeout(() => { location.href = "https://www.runninghub.ai/"; }, 600);
      return true;
    } catch (err) {
      console.error(TAG, "cookie import failed", err);
      rhToast("❌ Failed to parse Cookie JSON: " + err.message);
      return false;
    }
  };

  async function pasteAndImportCookies() {
    let text = "";
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        text = await navigator.clipboard.readText();
      }
    } catch (e) { /* permission denied → modal */ }
    if (text && text.trim().startsWith("[")) {
      window.importCookiesFromJSON(text);
    } else {
      openPasteModal("Paste Cookie JSON", '[{"name":"...","value":"..."}]', (v) => {
        window.importCookiesFromJSON(v);
      });
    }
  }

  const onCookieHotkey = (e) => {
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (e.ctrlKey && e.shiftKey && e.code === "KeyV") {
      e.preventDefault();
      pasteAndImportCookies();
    }
  };
  window.addEventListener("keydown", onCookieHotkey);
  cleanups.push(() => window.removeEventListener("keydown", onCookieHotkey));

  // ==========================================
  // 4. Telemetry Blocker (spec-correct 204)
  // ==========================================
  if (config.blockTelemetry) {
    const blockedHosts = [
      "google-analytics.com", "googletagmanager.com",
      "hm.baidu.com", "clarity.ms", "sentry.io",
    ];
    const origFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      try {
        const url = typeof input === "string" ? input : (input && input.url) || "";
        if (url && blockedHosts.some((h) => url.includes(h))) {
          return Promise.resolve(new Response(null, { status: 204, statusText: "No Content" }));
        }
      } catch (e) { console.warn(TAG, "fetch-patch check failed", e); }
      return origFetch(input, init);
    };
  }

  // ==========================================
  // 5. ComfyUI Canvas & Execution Engine
  // ==========================================
  const stopNodeIds = new Set();

  function isStopId(id) { return stopNodeIds.has(String(id)); }
  function toggleStopId(id) {
    const key = String(id);
    if (stopNodeIds.has(key)) { stopNodeIds.delete(key); return false; }
    stopNodeIds.add(key);
    return true;
  }

  // [FIX-9] Rect-based visibility: offsetParent is null for position:fixed
  // elements (the RH result sidebar is fixed), so a rect check is used.
  function isVisible(el) {
    try {
      if (!el || el.disabled) return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const cs = getComputedStyle(el);
      return cs.display !== "none" && cs.visibility !== "hidden";
    } catch (_) { return false; }
  }

  // [FIX-13] Verified RH cancel flow:
  //  - Button: .rh-task-item .rh-cancel-btn (text "Cancel"), acts instantly,
  //    NO confirm dialog (v2.2's dialog clicker REMOVED — RH toasts are Ant
  //    Design, that code targeted Element UI and was dead weight).
  //  - Success signal: transient toast in #rh-message-root / .ant-message
  //    ("Cancelled Sucessfully"). Watched to CONFIRM the cancel landed.
  function triggerRHInterrupt(t) {
    const iWin = t.win, iDoc = t.doc;
    rhToast("🛑 Breakpoint hit — sending cancel…");
    let attempts = 0;
    let announced = false;
    let confirmed = false;
    const MAX = 8; // ~6.5s of retries if the button mounts late

    // Success watcher: RH's confirmation toast lives in #rh-message-root
    // (.ant-message). Transient (~seconds) → poll fast, hard-stop at 12s.
    const successRX = /cancel|取消|success|成功/i;
    const watch = setInterval(() => {
      if (confirmed) { clearInterval(watch); return; }
      try {
        const root = document.querySelector("#rh-message-root") ||
                     document.querySelector(".ant-message");
        if (root && successRX.test(root.textContent || "")) {
          confirmed = true;
          clearInterval(watch);
          rhToast("✅ Task cancelled — confirmed by RunningHub");
        }
      } catch (_) {}
    }, 200);
    setTimeout(() => clearInterval(watch), 12000);

    const tick = () => {
      if (confirmed) return; // RH confirmed — done
      attempts++;

      let clicked = null;
      const docs = [document];
      if (iDoc && iDoc !== document) docs.push(iDoc);

      // 1) Verified selector path: live task's cancel button
      for (const doc of docs) {
        const btn =
          doc.querySelector(".rh-task-item .rh-cancel-btn") ||
          doc.querySelector(".workflow-result-wrap .rh-cancel-btn") ||
          doc.querySelector("[class*='workflow-result-wrap'] .rh-cancel-btn");
        if (btn && isVisible(btn)) { clicked = btn; break; }
      }
      // 2) Last-resort text fallback (RH's label is exactly "Cancel")
      if (!clicked) {
        outer: for (const doc of docs) {
          for (const b of doc.querySelectorAll("button, .el-button, [role='button']")) {
            const txt = (b.textContent || "").trim();
            if (txt && txt.length <= 12 && /^(cancel|取消)$/i.test(txt) && isVisible(b)) {
              clicked = b; break outer;
            }
          }
        }
      }

      // 3) api.interrupt as a secondary nudge (harmless if a local no-op —
      //    RH executes server-side; the RH button is the real control)
      try {
        if (iWin.api && typeof iWin.api.interrupt === "function") iWin.api.interrupt();
      } catch (e) { console.warn(TAG, "api.interrupt failed", e); }

      if (clicked) {
        try {
          clicked.click();
          if (!announced) {
            announced = true;
            rhToast("🛑 Cancel clicked: " +
              ((clicked.textContent || "").trim() || "rh-cancel-btn").slice(0, 30));
          }
        } catch (e) { console.warn(TAG, "cancel click failed", e); }
      }

      if (attempts < MAX) setTimeout(tick, 800);
      else if (!confirmed) {
        rhToast("⚠️ Breakpoint hit but cancel not confirmed — check the task", 4000);
        clearInterval(watch);
      }
    };
    tick();
  }

  // [FIX-8] Engine target resolution — /workflow/<id> popup windows detect
  // as ComfyUI directly (URLs: runninghub.ai/workflow/2094194439212820310).
  let comfyIframe = null;
  function looksLikeComfyWindow() {
    try {
      if (window.LGraphCanvas) return true;
      if (window.app && window.app.canvas) return true;
      const p = location.pathname.toLowerCase();
      if (/\/workflow\/\d+/.test(p)) return true;   // RH workflow sessions
      if (p.includes("/comfy")) return true;
    } catch (_) {}
    return false;
  }

  function resolveEngineTarget() {
    if (IN_IFRAME) return { win: window, doc: document };
    if (comfyIframe && !comfyIframe.isConnected) comfyIframe = null;
    if (!comfyIframe) {
      comfyIframe =
        document.querySelector('iframe[src*="comfyUI.html"]') ||
        Array.from(document.querySelectorAll("iframe")).find((f) => {
          try { return /comfy/i.test(f.src || ""); } catch (_) { return false; }
        }) || null;
    }
    if (comfyIframe) {
      try {
        const w = comfyIframe.contentWindow;
        const d = comfyIframe.contentDocument || (w && w.document);
        if (w && d && d.body) return { win: w, doc: d };
      } catch (_) { /* cross-origin — retry next tick */ }
      return null;
    }
    if (looksLikeComfyWindow() && document.body) return { win: window, doc: document };
    return null;
  }

  // [FIX-6/7] Live-instance enforcement (ComfyUI re-applies its own settings)
  const SPLINE_LINK = 2;
  function enforceInstanceSettings(cv) {
    try {
      if (config.darkerGrid && cv.clear_background !== undefined && cv.clear_background !== "#101012") {
        cv.clear_background = "#101012";
      }
      if (config.enhancedWires) {
        if (cv.link_render_mode !== undefined && cv.link_render_mode !== SPLINE_LINK) {
          cv.link_render_mode = SPLINE_LINK;
        }
        if (cv.connections_width !== undefined && cv.connections_width < 4) {
          cv.connections_width = 4;
        }
        if (cv.link_width !== undefined && cv.link_width < 2) cv.link_width = 2;
      }
    } catch (_) { /* instance not ready */ }
  }

  function injectCanvasCSS(t) {
    if (!config.darkerGrid) return;
    try {
      const iDoc = t.doc;
      if (!iDoc.getElementById("rh-canvas-perf-style")) {
        const head = iDoc.head || iDoc.documentElement;
        const st = iDoc.createElement("style");
        st.id = "rh-canvas-perf-style";
        st.textContent = `
          body, html { background-color: #101012 !important; }
          canvas#graph-canvas, canvas.lgraphcanvas,
          .graph-canvas-container canvas, .litegraph .lgraphcanvas {
            background-color: #101012 !important;
          }
          canvas#graph-canvas { touch-action: none !important; }
        `;
        head.appendChild(st);
      }
    } catch (e) { console.warn(TAG, "canvas CSS injection failed", e); }
  }

  function attachEngine(t) {
    const win = t.win, P = win.LGraphCanvas && win.LGraphCanvas.prototype;
    if (!P) return;

    if (win.__RH_IFRAME_ENGINE_OWNER__ && win.__RH_IFRAME_ENGINE_OWNER__ !== window) return;
    win.__RH_IFRAME_ENGINE_OWNER__ = window;

    if (!P.__rh_render_attached) {
      P.__rh_render_attached = true;

      if (config.darkerGrid) P.clear_background = "#101012";

      if (config.fpsOptimization) {
        P.render_shadows = false;
        P.highquality_render = false;
        // Keep connection border when enhancedWires is ON — disabling it
        // makes wires look thinner (fought the "thicker wires" requirement).
        if (!config.enhancedWires) P.render_connections_border = false;
      }

      try {
        if (config.enhancedWires) {
          const SPLINE = (win.LGraphCanvas.SPLINE_LINK != null) ? win.LGraphCanvas.SPLINE_LINK : SPLINE_LINK;
          P.link_render_mode = SPLINE;
          P.connections_width = 4;
          P.link_width = 2;
        }
      } catch (e) { console.warn(TAG, "wire config failed", e); }

      // [FIX-3] drawNode overlay — transform-snapshot restore. This fork
      // leaves a translate applied on return; snapshotting before the call
      // and forcing it back after keeps overlays in true graph coordinates.
      const overlayEnabled = config.vectorNodeIndicator || config.autoCancelBreakpoints;
      if (overlayEnabled) {
        const originalDrawNode = P.drawNode;
        P.drawNode = function (node, ctx) {
          let prevT = null;
          const canFix = typeof ctx.getTransform === "function" && typeof ctx.setTransform === "function";
          if (canFix) { try { prevT = ctx.getTransform(); } catch (_) { prevT = null; } }

          const result = originalDrawNode.apply(this, arguments);

          if (canFix && prevT) { try { ctx.setTransform(prevT); } catch (_) {} }

          try {
            if (!node || !ctx) return result;

            const isBreakpoint = config.autoCancelBreakpoints && isStopId(node.id);

            let isRunning = false;
            if (config.vectorNodeIndicator) {
              const R = win.__rh_running;
              isRunning = !!(
                (R && (node.id === R.num || String(node.id) === R.str)) ||
                node.is_executing || node.running || this.node_executing === node
              );
            }

            if (!isRunning && !isBreakpoint) return result;

            if (typeof this.isNodeVisible === "function" && !this.isNodeVisible(node)) {
              return result;
            }

            // Zoom-compensated line widths → constant screen thickness
            const zoom = (this.ds && this.ds.scale) ? this.ds.scale : 1;
            const u = 1 / Math.max(zoom, 0.0001);

            if (isRunning) {
              const x = node.pos[0] - 6, y = node.pos[1] - 6;
              const w = node.size[0] + 12, h = node.size[1] + 12;
              ctx.save();
              ctx.lineWidth = 8 * u;
              ctx.strokeStyle = "rgba(0, 255, 102, 0.25)";
              ctx.strokeRect(x - 2, y - 2, w + 4, h + 4);
              ctx.lineWidth = 4 * u;
              ctx.strokeStyle = "#00FF66";
              ctx.strokeRect(x, y, w, h);
              const len = 16 * u;
              ctx.lineWidth = 5 * u;
              ctx.strokeStyle = "#FFFFFF";
              ctx.beginPath();
              ctx.moveTo(x, y + len); ctx.lineTo(x, y); ctx.lineTo(x + len, y);
              ctx.moveTo(x + w - len, y); ctx.lineTo(x + w); ctx.lineTo(x + w, y + len);
              ctx.moveTo(x, y + h - len); ctx.lineTo(x, y + h); ctx.lineTo(x + len, y + h);
              ctx.moveTo(x + w - len, y + h); ctx.lineTo(x + w); ctx.lineTo(x + w, y + h - len);
              ctx.stroke();
              ctx.restore();
            }

            if (isBreakpoint) {
              ctx.save();
              ctx.lineWidth = 4 * u;
              ctx.strokeStyle = "#FF3344";
              ctx.strokeRect(node.pos[0] - 2, node.pos[1] - 2, node.size[0] + 4, node.size[1] + 4);
              ctx.fillStyle = "#FF3344";
              ctx.font = `bold ${12 * u}px monospace`;
              ctx.fillText("🛑 AUTO-CANCEL STOP", node.pos[0], node.pos[1] - 8 * u);
              ctx.restore();
            }
          } catch (e) {
            console.warn(TAG, "drawNode overlay error (suppressed)", e);
          }
          return result;
        };
      }

      // Right-click breakpoint menu
      const originalGetNodeMenuOptions = P.getNodeMenuOptions;
      P.getNodeMenuOptions = function (node) {
        const options = originalGetNodeMenuOptions
          ? originalGetNodeMenuOptions.apply(this, arguments)
          : [];
        try {
          const isStopNode = isStopId(node && node.id);
          const hasExisting = options.some(
            (o) => o && o.content && (o.content.includes("Auto-Cancel") || o.content.includes("Stop Breakpoint"))
          );
          if (!hasExisting) {
            options.push({
              content: isStopNode ? "🛑 Remove Stop Breakpoint" : "🛑 Set Auto-Cancel Breakpoint",
              callback: () => {
                const nowStop = toggleStopId(node.id);
                rhToast(nowStop ? "🛑 Breakpoint SET on node " + node.id : "Breakpoint removed from node " + node.id);
                try {
                  const cv = win.app && win.app.canvas;
                  if (cv) { cv.setDirty(true, true); cv.draw(true, true); }
                } catch (e) { console.warn(TAG, "menu redraw failed", e); }
              },
            });
          }
        } catch (e) { console.warn(TAG, "menu override error", e); }
        return options;
      };
    }

    // [FIX-5] Event-driven running-node tracking + breakpoints
    if (win.api && win.__rh_hooked_api !== win.api) {
      const api = win.api;
      win.__rh_hooked_api = api;
      try {
        api.addEventListener("executing", (e) => {
          try {
            const d = e && e.detail;
            const rawId = (d && typeof d === "object")
              ? (d.node != null ? d.node : (d.display_node != null ? d.display_node : null))
              : d;
            if (rawId == null) { win.__rh_running = null; return; }

            win.__rh_running = { num: Number(rawId), str: String(rawId) };

            if (config.autoCenterRunningNode && win.app && win.app.graph && win.app.canvas &&
                typeof win.app.canvas.centerOnNode === "function") {
              const node = win.app.graph.getNodeById(rawId);
              if (node) win.app.canvas.centerOnNode(node);
            }

            if (config.autoCancelBreakpoints && isStopId(rawId)) {
              triggerRHInterrupt({ win, doc: t.doc });
            }
          } catch (err) { console.warn(TAG, "executing-handler error", err); }
        });

        const clearRunning = () => { win.__rh_running = null; };
        try { api.addEventListener("execution_start", clearRunning); } catch (_) {}
        try { api.addEventListener("execution_success", clearRunning); } catch (_) {}
        try { api.addEventListener("execution_error", clearRunning); } catch (_) {}
        try { api.addEventListener("execution_interrupted", clearRunning); } catch (_) {}
        try {
          api.addEventListener("executed", (e) => {
            try {
              const d = e && e.detail;
              const nid = (d && typeof d === "object") ? d.node : d;
              const R = win.__rh_running;
              if (R && (nid === R.num || String(nid) === R.str)) win.__rh_running = null;
            } catch (_) {}
          });
        } catch (_) {}
      } catch (e) { console.error(TAG, "api.addEventListener failed", e); }
    }
  }

  // ==========================================
  // 6. Task Timer HUD — poller-driven, .rh-task-item scoped
  // ==========================================
  function ensureTaskTimerHUD() {
    if (document.getElementById("rh-timer-hud")) return;
    try {
      const hud = document.createElement("div");
      hud.id = "rh-timer-hud";
      hud.innerHTML = `<span style="font-size:14px;">⏱️</span><span id="rh-hud-time">00:00</span>`;
      hud.style.cssText =
        "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:999998;" +
        "background:rgba(18,18,22,0.9);border:1px solid rgba(0,255,102,0.5);border-radius:20px;" +
        "padding:6px 18px;display:none;align-items:center;gap:8px;font-family:monospace;" +
        "font-size:15px;font-weight:700;color:#00FF66;box-shadow:0 4px 16px rgba(0,0,0,0.7);" +
        "pointer-events:none;user-select:none;";
      document.body.appendChild(hud);
    } catch (e) { /* body not ready */ }
  }

  function updateTaskTimerHUD() {
    const hud = document.getElementById("rh-timer-hud");
    if (!hud) return;
    try {
      let timeEl =
        document.querySelector(".rh-task-item [class*='status'], .rh-task-item .rh-task-time") ||
        document.querySelector(
          ".workflow-result-wrap .rh-task-status > div, " +
          "[class*='workflow-result-wrap'] .rh-task-time, " +
          "[class*='workflow-result-wrap'] [class*='status']"
        );
      if (timeEl && timeEl.innerText && timeEl.innerText.trim()) {
        const txt = timeEl.innerText.trim();
        const disp = hud.querySelector("#rh-hud-time");
        if (disp && disp.textContent !== txt) disp.textContent = txt;
        if (hud.style.display !== "flex") hud.style.display = "flex";
        return;
      }
      if (hud.style.display !== "none") hud.style.display = "none";
    } catch (e) { /* transient */ }
  }

  // ==========================================
  // 7. Floating Settings UI — home window only
  // ==========================================
  function createFloatingMenu() {
    if (document.getElementById("rh-floating-root")) return;
    if (!document.body) return;

    if (!document.getElementById("rh-floating-style")) {
      const menuStyle = document.createElement("style");
      menuStyle.id = "rh-floating-style";
      menuStyle.textContent = `
        #rh-floating-root { position: fixed; z-index: 999999; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; touch-action: none; }
        #rh-toggle-btn { width: 38px; height: 38px; background: #1e1e24; border: 1px solid #444; border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: grab; font-size: 17px; box-shadow: 0 4px 12px rgba(0,0,0,0.5); user-select: none; transition: transform 0.1s ease, border-color 0.2s ease; }
        #rh-toggle-btn:active { cursor: grabbing; transform: scale(0.95); border-color: #00FF66; }
        #rh-settings-panel { position: absolute; bottom: 46px; left: 0; width: 310px; max-height: 520px; overflow-y: auto; background: #16161a; border: 1px solid #333; border-radius: 8px; padding: 12px; color: #ddd; box-shadow: 0 8px 24px rgba(0,0,0,0.7); }
      `;
      document.head.appendChild(menuStyle);
    }

    const POS_KEY = "RH_FLOATING_POS";
    const savedPosRaw = safeParse(POS_KEY, {});
    const savedPos = {
      x: Number.isFinite(savedPosRaw.x) ? savedPosRaw.x : 20,
      y: Number.isFinite(savedPosRaw.y) ? savedPosRaw.y : 20,
    };

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
            .map((key) => `
            <label style="display: flex; justify-content: space-between; align-items: center; margin: 5px 0; font-size: 11px; cursor: pointer;">
              <span>${esc(key)}</span>
              <input type="checkbox" data-core-key="${esc(key)}" ${config[key] ? "checked" : ""} style="cursor: pointer;">
            </label>`)
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
    document.body.appendChild(container);
    container.style.left = savedPos.x + "px";
    container.style.top = savedPos.y + "px";

    function adjustPanelPosition() {
      const rect = container.getBoundingClientRect();
      const panel = container.querySelector("#rh-settings-panel");
      if (!panel) return;
      if (rect.top < 300) { panel.style.bottom = "auto"; panel.style.top = "46px"; }
      else { panel.style.top = "auto"; panel.style.bottom = "46px"; }
      if (rect.left > window.innerWidth - 320) { panel.style.left = "auto"; panel.style.right = "0"; }
      else { panel.style.right = "auto"; panel.style.left = "0"; }
    }

    const toggleBtn = container.querySelector("#rh-toggle-btn");
    const panel = container.querySelector("#rh-settings-panel");

    let isDragging = false, startX = 0, startY = 0, initialLeft = 0, initialTop = 0, dragDistance = 0;

    function onPointerMove(e) {
      if (!isDragging) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      dragDistance = Math.hypot(dx, dy);
      let nextX = Math.max(8, Math.min(initialLeft + dx, window.innerWidth - 44));
      let nextY = Math.max(8, Math.min(initialTop + dy, window.innerHeight - 44));
      container.style.left = nextX + "px";
      container.style.top = nextY + "px";
    }

    function endDrag() {
      if (!isDragging) return;
      isDragging = false;
      toggleBtn.removeEventListener("pointermove", onPointerMove);
      toggleBtn.removeEventListener("pointerup", endDrag);
      toggleBtn.removeEventListener("pointercancel", endDrag);
      try {
        const rect = container.getBoundingClientRect();
        localStorage.setItem(POS_KEY, JSON.stringify({ x: Math.round(rect.left), y: Math.round(rect.top) }));
      } catch (e) { console.warn(TAG, "pos save failed", e); }
      adjustPanelPosition();
    }

    toggleBtn.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      isDragging = true;
      startX = e.clientX; startY = e.clientY;
      const rect = container.getBoundingClientRect();
      initialLeft = rect.left; initialTop = rect.top;
      dragDistance = 0;
      try { toggleBtn.setPointerCapture(e.pointerId); } catch (_) {}
      toggleBtn.addEventListener("pointermove", onPointerMove);
      toggleBtn.addEventListener("pointerup", endDrag);
      toggleBtn.addEventListener("pointercancel", endDrag);
      e.preventDefault();
    });

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
        .map((s, idx) => `
        <div style="display: flex; justify-content: space-between; align-items: center; margin: 4px 0; background: #101014; padding: 3px 6px; border-radius: 4px; font-size: 11px;">
          <label style="cursor: pointer; display: flex; align-items: center; gap: 6px;">
            <input type="checkbox" data-script-idx="${idx}" ${s.enabled ? "checked" : ""}>
            <span style="max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(s.name)}</span>
          </label>
          <span class="rh-delete-script" data-delete-idx="${idx}" style="cursor: pointer; color: #ff5555; font-size: 12px;" title="Delete">🗑️</span>
        </div>`)
        .join("");
      userScriptList.querySelectorAll(".rh-delete-script").forEach((delBtn) => {
        delBtn.onclick = (e) => {
          const idx = parseInt(e.target.dataset.deleteIdx, 10);
          if (Number.isInteger(idx) && customScripts[idx]) {
            customScripts.splice(idx, 1);
            renderCustomScriptList();
          }
        };
      });
    }
    renderCustomScriptList();

    closeBtn.onclick = () => { panel.style.display = "none"; };
    importCookiesBtn.onclick = () => { pasteAndImportCookies(); };

    addScriptBtn.onclick = () => {
      const name = newScriptName.value.trim() || `Script #${customScripts.length + 1}`;
      const code = newScriptCode.value.trim();
      if (!code) { rhToast("⚠️ Please enter script code."); return; }
      try { new Function(code); }
      catch (err) { rhToast("❌ Syntax error in script: " + err.message); return; }
      customScripts.push({ id: Date.now(), name, code, enabled: true });
      newScriptName.value = "";
      newScriptCode.value = "";
      renderCustomScriptList();
    };

    saveApplyBtn.onclick = () => {
      try {
        container.querySelectorAll("input[data-core-key]").forEach((input) => {
          config[input.dataset.coreKey] = input.checked;
        });
        saveConfig();
        container.querySelectorAll("input[data-script-idx]").forEach((input) => {
          const idx = parseInt(input.dataset.scriptIdx, 10);
          if (customScripts[idx]) customScripts[idx].enabled = input.checked;
        });
        saveCustomScripts();
        location.reload();
      } catch (e) {
        console.error(TAG, "save failed", e);
        rhToast("❌ Save failed: " + e.message);
      }
    };
  }

  // ==========================================
  // 8. Lifecycle Poller
  // ==========================================
  function pollTick() {
    try {
      if (!IS_POPUP) {
        const titleEl = document.querySelector("title");
        if (titleEl && titleEl.textContent !== "RunningHub") titleEl.textContent = "RunningHub";
      }
    } catch (e) {}

    try {
      if (SHOW_FLOATING_UI && document.body && !document.getElementById("rh-floating-root")) {
        createFloatingMenu();
      }
    } catch (e) { console.warn(TAG, "floating menu tick failed", e); }

    try {
      const t = resolveEngineTarget();
      if (t && t.win.LGraphCanvas && t.win.LGraphCanvas.prototype) {
        injectCanvasCSS(t);
        attachEngine(t);
        const cv = t.win.app && t.win.app.canvas;
        if (cv) enforceInstanceSettings(cv);
      }
    } catch (e) { console.warn(TAG, "canvas engine tick failed", e); }

    try { ensureTaskTimerHUD(); updateTaskTimerHUD(); } catch (e) { /* cosmetic */ }
  }
  const pollTimer = setInterval(pollTick, 600);
  cleanups.push(() => clearInterval(pollTimer));
  pollTick();

  window.__RH_EXT_TEARDOWN__ = function () {
    cleanups.forEach((fn) => { try { fn(); } catch (e) { console.warn(TAG, "cleanup error", e); } });
    ["rh-floating-root", "rh-timer-hud", "rh-toast-host", "rh-modal-overlay",
     "rh-floating-style", "rh-canvas-perf-style"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.remove();
    });
    window.__RH_EXT_INITIALIZED__ = false;
    console.info(TAG, "teardown complete");
  };

  window.__RH_EXT_INITIALIZED__ = true;
  console.info(TAG, "v2.3 initialized", { IS_POPUP, IN_IFRAME, path: location.pathname });

  } catch (fatalErr) {
    window.__RH_EXT_INITIALIZED__ = false;
    console.error(TAG, "FATAL init error — will retry on next injection.", fatalErr);
  }
})();
