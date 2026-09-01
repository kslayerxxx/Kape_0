/* ==========================================================================
 * RunningHub ComfyUI Desktop Wrapper — custom_r.js (v2.4 — FINAL)
 * --------------------------------------------------------------------------
 * Loaded by the bootstrap in src-tauri/src/inject/custom.js on every window.
 * Sources: RH_MAIN_SCRIPT_OVERRIDE (in-app editor) → RH_LAST_GOOD_SCRIPT.
 *
 * Verified RH stack (user-captured — do not re-infer):
 *  - Vue SPA (#appVue), Ant Design toasts (#rh-message-root / .ant-message)
 *  - Live task: .rh-task-item > .history-top-info > .rh-cancel-btn ("Cancel")
 *  - Cancel acts IMMEDIATELY (no confirm dialog) + transient success toast
 *  - ComfyUI runs DIRECTLY in /workflow/<id> popup window (no iframe)
 *  - LiteGraph fork: NEVER touch its 2D context / drawNode (see below)
 *  - node.is_executing / node.running do NOT exist — use api "executing" events
 *
 * v2.4 changes (vs v2.3):
 *  [FIX-A] drawNode hook REMOVED ENTIRELY. Root cause of the tiling/ghosting
 *    corruption, the frozen mouse AND the offset breakpoint box: this fork's
 *    LGraphCanvas leaves a translate applied after drawNode returns and its
 *    render state corrupts if anything else touches the context.
 *  [FIX-B] All node overlays (green running brackets, red breakpoint box +
 *    "🛑 AUTO-CANCEL STOP" label) now draw on a SEPARATE screen-space canvas
 *    (#rh-graph-overlay, pointer-events:none) — structurally immune to the
 *    fork's transform quirks, tracks nodes at any zoom/pan, never corrupts.
 *  [FIX-C] Engine target resolution: cached target + deep scan of ALL
 *    same-origin iframes for a live LGraphCanvas (iframe src can lie).
 *  [NEW-F] popupTitleStatus: workflow windows show "▶ 42s · Running" /
 *    "✅ Done in 1m 23s" in the title bar (visible from the taskbar).
 *  [NEW-C] closeGuard: beforeunload prompt if you close/refresh mid-run.
 *  [NEW] sameWindowWorkflows toggle (OFF by default): workflow links navigate
 *    in the same window instead of a popup. Popups stay 1400×900 either way.
 *  [NEW] 📝 Edit Script (in-app editor, sole update channel — no network,
 *    no rebuilds) + 🔄 Reload + Ctrl+Shift+E emergency editor hotkey.
 *  [NEW] "✅ RH engine attached" confirmation toast.
 *  Bootstrap handshake: sets __RH_SCRIPT_BOOT_OK__ immediately and
 *  __RH_EXT_INITIALIZED__ LAST (after successful init). Old versions (v2.3
 *  and earlier) do NOT signal boot — paste v2.4 into the first-run panel.
 * ========================================================================== */
(function () {
  "use strict";

  if (window.__RH_EXT_INITIALIZED__) return;
  // Bundled-fallback mode: if the bootstrap already installed an override or
  // last-good copy from localStorage, that copy wins and this bundled one
  // must not double-run. (See inject/custom_r.js in the repo.)
  if (window.__RH_LIVE_SOURCE__) return;

  // --- Bootstrap handshake: set BEFORE the origin guard so non-RH popups
  // (OAuth etc.) still count as "booted" and never trigger the first-run
  // panel there. ---
  window.__RH_SCRIPT_BOOT_OK__ = true;

  const RH_HOST_OK =
    /(^|\.)runninghub\.ai$/i.test(location.hostname) ||
    location.hostname === "localhost" ||
    location.hostname === "127.0.0.1";
  if (!RH_HOST_OK) return; // no features on foreign pages; bootstrap knows we booted

  const TAG = "[RH Ext]";
  const VERSION = "2.4";
  const cleanups = [];
  let destroyed = false;

  // --- Window roles -------------------------------------------------------
  let IN_IFRAME = false;
  try {
    IN_IFRAME = window.self !== window.top;
  } catch (_) {
    IN_IFRAME = true;
  }
  const IS_POPUP = !!(window.opener && window.opener !== window);
  const IS_WORKFLOW_PAGE = /\/workflow\/\d+/.test(location.pathname);
  // Gear/floating UI ONLY on the home window (locked decision).
  const SHOW_FLOATING_UI = !IS_POPUP && !IN_IFRAME && !IS_WORKFLOW_PAGE;
  // Title locked to "RunningHub" ONLY on home — workflow windows need a free
  // title because Feature F writes run status into it.
  const SHOULD_LOCK_TITLE = !IS_POPUP && !IS_WORKFLOW_PAGE;
  // Feature F + C scope: the window actually hosting the ComfyUI engine.
  const IS_ENGINE_WINDOW = IS_POPUP || IS_WORKFLOW_PAGE;

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
        console.warn(
          TAG,
          `Corrupted localStorage key "${key}" — resetting.`,
          e,
        );
        try {
          localStorage.removeItem(key);
        } catch (_) {}
        return fallback;
      }
    }

    function esc(s) {
      return String(s).replace(
        /[&<>"']/g,
        (c) =>
          ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;",
          })[c],
      );
    }

    function fmtDur(ms) {
      const s = Math.max(0, Math.floor(ms / 1000));
      if (s < 60) return s + "s";
      return Math.floor(s / 60) + "m " + String(s % 60).padStart(2, "0") + "s";
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
        requestAnimationFrame(() => {
          el.style.opacity = "1";
        });
        setTimeout(() => {
          el.style.opacity = "0";
          setTimeout(() => el.remove(), 220);
        }, ms || 2600);
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
        ta.addEventListener("keydown", (e) => {
          if (e.key === "Escape") close();
        });
        ta.focus();
      } catch (e) {
        console.error(TAG, "modal failed", e);
      }
    }

    // Emergency editor hotkey (Ctrl+Shift+E) — registered EARLY so it works
    // even if a later section throws during development of an edit.
    const onEditorHotkey = (e) => {
      const t = e.target;
      if (
        t &&
        (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
      )
        return;
      if (e.ctrlKey && e.shiftKey && e.code === "KeyE") {
        e.preventDefault();
        try {
          openScriptEditor();
        } catch (err) {
          console.error(TAG, "editor failed", err);
        }
      }
    };
    window.addEventListener("keydown", onEditorHotkey);
    cleanups.push(() => window.removeEventListener("keydown", onEditorHotkey));

    // ==========================================
    // 1. Configuration & Persistence
    // ==========================================
    const CONFIG_KEY = "RH_QOL_CONFIG";
    const CUSTOM_SCRIPTS_KEY = "RH_CUSTOM_SCRIPTS_LIST";
    const SCRIPT_OVERRIDE_KEY = "RH_MAIN_SCRIPT_OVERRIDE";
    const SCRIPT_CACHE_KEY = "RH_LAST_GOOD_SCRIPT";

    const DEFAULT_CONFIG = {
      blockTelemetry: true,
      fpsOptimization: true,
      vectorNodeIndicator: true,
      enhancedWires: true,
      darkerGrid: true,
      autoCenterRunningNode: false,
      autoCancelBreakpoints: true,
      closeGuard: true, // [C]
      popupTitleStatus: true, // [F]
      sameWindowWorkflows: false, // [TGL] off by default (locked decision)
    };

    const config = Object.assign({}, DEFAULT_CONFIG, safeParse(CONFIG_KEY, {}));

    function saveConfig() {
      try {
        localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
      } catch (e) {
        console.warn(TAG, "saveConfig failed", e);
      }
    }

    let customScripts = [];
    try {
      const rawScripts = safeParse(CUSTOM_SCRIPTS_KEY, []);
      if (Array.isArray(rawScripts)) {
        customScripts = rawScripts.filter(
          (s) =>
            s &&
            s.code &&
            !s.code.includes("RH_QOL_CONFIG") &&
            !s.code.includes("createFloatingMenu"),
        );
        if (rawScripts.length !== customScripts.length) {
          localStorage.setItem(
            CUSTOM_SCRIPTS_KEY,
            JSON.stringify(customScripts),
          );
        }
      }
    } catch (e) {
      customScripts = [];
      try {
        localStorage.removeItem(CUSTOM_SCRIPTS_KEY);
      } catch (_) {}
    }

    function saveCustomScripts() {
      try {
        localStorage.setItem(CUSTOM_SCRIPTS_KEY, JSON.stringify(customScripts));
      } catch (e) {
        console.warn(TAG, "saveCustomScripts failed", e);
      }
    }

    customScripts.forEach((s) => {
      if (s.enabled && s.code && s.code.trim()) {
        try {
          new Function(s.code)();
        } catch (e) {
          console.error(TAG, `UserScript error: ${s.name}`, e);
          rhToast(`⚠️ UserScript "${s.name}" failed — see console`);
        }
      }
    });

    // ==========================================
    // 2. Cookie JSON Importer (Ctrl+Shift+V)
    // ==========================================
    window.importCookiesFromJSON = function (jsonInput) {
      try {
        const cookies =
          typeof jsonInput === "string" ? JSON.parse(jsonInput) : jsonInput;
        if (!Array.isArray(cookies)) {
          rhToast("❌ Invalid format: expected a JSON array of cookies");
          return false;
        }
        cookies.forEach((c) => {
          if (!c.name || c.value === undefined) return;
          const name = encodeURIComponent(c.name.trim());
          const value = encodeURIComponent(c.value.trim());
          let cookieStr = `${name}=${value}; path=/; max-age=31536000; SameSite=Lax`;
          if (location.hostname.includes("runninghub"))
            cookieStr += "; domain=.runninghub.ai";
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
            } catch (_) {}
          }
        });
        rhToast(`✅ Imported ${cookies.length} cookie(s) — reloading…`);
        setTimeout(() => {
          location.href = "https://www.runninghub.ai/";
        }, 600);
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
      } catch (e) {
        /* permission denied → modal */
      }
      if (text && text.trim().startsWith("[")) {
        window.importCookiesFromJSON(text);
      } else {
        openPasteModal(
          "Paste Cookie JSON",
          '[{"name":"...","value":"..."}]',
          (v) => {
            window.importCookiesFromJSON(v);
          },
        );
      }
    }

    const onCookieHotkey = (e) => {
      const t = e.target;
      if (
        t &&
        (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
      )
        return;
      if (e.ctrlKey && e.shiftKey && e.code === "KeyV") {
        e.preventDefault();
        pasteAndImportCookies();
      }
    };
    window.addEventListener("keydown", onCookieHotkey);
    cleanups.push(() => window.removeEventListener("keydown", onCookieHotkey));

    // ==========================================
    // 3. Title lock (home only) & window.open
    // ==========================================
    if (SHOULD_LOCK_TITLE) {
      try {
        document.title = "RunningHub";
        Object.defineProperty(document, "title", {
          configurable: true,
          get() {
            return "RunningHub";
          },
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
        if (/(^|\/)(task|workflow|comfy)/.test(u.pathname.toLowerCase()))
          return true;
        return (
          u.searchParams.has("task_id") || u.searchParams.has("workflow_id")
        );
      } catch (e) {
        return false;
      }
    }

    function patchWindowOpen(w) {
      if (!w || w.__RH_OPEN_PATCHED__) return;
      w.__RH_OPEN_PATCHED__ = true;
      const origOpen = w.open.bind(w);
      try {
        w.open = function (url, target, features) {
          try {
            if (isWorkflowUrl(url)) {
              // Toggle (OFF by default): navigate in this window instead.
              if (config.sameWindowWorkflows) {
                location.href = new URL(url, location.href).href;
                return null;
              }
              return origOpen(
                url,
                target,
                "width=1400,height=900,resizable=yes,scrollbars=yes",
              );
            }
          } catch (e) {
            console.warn(TAG, "open-patch check failed", e);
          }
          return origOpen(url, target, features);
        };
      } catch (e) {
        console.warn(TAG, "could not patch window.open", e);
      }
    }
    patchWindowOpen(window);

    // ==========================================
    // 4. Telemetry Blocker (spec-correct 204)
    // ==========================================
    if (config.blockTelemetry) {
      const blockedHosts = [
        "google-analytics.com",
        "googletagmanager.com",
        "hm.baidu.com",
        "clarity.ms",
        "sentry.io",
      ];
      const origFetch = window.fetch.bind(window);
      window.fetch = function (input, init) {
        try {
          const url =
            typeof input === "string" ? input : (input && input.url) || "";
          if (url && blockedHosts.some((h) => url.includes(h))) {
            return Promise.resolve(
              new Response(null, { status: 204, statusText: "No Content" }),
            );
          }
        } catch (e) {
          console.warn(TAG, "fetch-patch check failed", e);
        }
        return origFetch(input, init);
      };
    }

    // ==========================================
    // 5. Breakpoints & visibility
    // ==========================================
    const stopNodeIds = new Set();

    function isStopId(id) {
      return stopNodeIds.has(String(id));
    }
    function toggleStopId(id) {
      const key = String(id);
      if (stopNodeIds.has(key)) {
        stopNodeIds.delete(key);
        return false;
      }
      stopNodeIds.add(key);
      return true;
    }

    // Rect-based visibility: offsetParent is null for position:fixed elements
    // (the RH result sidebar is fixed), so a rect check is required.
    function isVisible(el) {
      try {
        if (!el || el.disabled) return false;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const cs = getComputedStyle(el);
        return cs.display !== "none" && cs.visibility !== "hidden";
      } catch (_) {
        return false;
      }
    }

    // Verified RH cancel flow (unchanged from v2.3 — WORKS, don't touch):
    //  - Button: .rh-task-item .rh-cancel-btn (text "Cancel"), acts instantly,
    //    NO confirm dialog.
    //  - Success signal: transient toast in #rh-message-root / .ant-message.
    //  - Retry (max 8 × 800ms) stops the moment RH confirms.
    //  - api.interrupt() fires as a harmless secondary nudge (server-side exec
    //    makes the local interrupt a no-op; the button is the real control).
    function triggerRHInterrupt(t) {
      const iWin = t.win,
        iDoc = t.doc;
      rhToast("🛑 Breakpoint hit — sending cancel…");
      let attempts = 0;
      let announced = false;
      let confirmed = false;
      const MAX = 8; // ~6.5s of retries if the button mounts late

      const successRX = /cancel|取消|success|成功/i;
      const watch = setInterval(() => {
        if (confirmed) {
          clearInterval(watch);
          return;
        }
        try {
          const root =
            document.querySelector("#rh-message-root") ||
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
        if (confirmed) return;
        attempts++;

        let clicked = null;
        const docs = [document];
        if (iDoc && iDoc !== document) docs.push(iDoc);

        for (const doc of docs) {
          const btn =
            doc.querySelector(".rh-task-item .rh-cancel-btn") ||
            doc.querySelector(".workflow-result-wrap .rh-cancel-btn") ||
            doc.querySelector("[class*='workflow-result-wrap'] .rh-cancel-btn");
          if (btn && isVisible(btn)) {
            clicked = btn;
            break;
          }
        }
        if (!clicked) {
          outer: for (const doc of docs) {
            for (const b of doc.querySelectorAll(
              "button, .el-button, [role='button']",
            )) {
              const txt = (b.textContent || "").trim();
              if (
                txt &&
                txt.length <= 12 &&
                /^(cancel|取消)$/i.test(txt) &&
                isVisible(b)
              ) {
                clicked = b;
                break outer;
              }
            }
          }
        }

        try {
          if (iWin.api && typeof iWin.api.interrupt === "function")
            iWin.api.interrupt();
        } catch (e) {
          console.warn(TAG, "api.interrupt failed", e);
        }

        if (clicked) {
          try {
            clicked.click();
            if (!announced) {
              announced = true;
              rhToast(
                "🛑 Cancel clicked: " +
                  ((clicked.textContent || "").trim() || "rh-cancel-btn").slice(
                    0,
                    30,
                  ),
              );
            }
          } catch (e) {
            console.warn(TAG, "cancel click failed", e);
          }
        }

        if (attempts < MAX) setTimeout(tick, 800);
        else if (!confirmed) {
          rhToast(
            "⚠️ Breakpoint hit but cancel not confirmed — check the task",
            4000,
          );
          clearInterval(watch);
        }
      };
      tick();
    }

    // ==========================================
    // 6. Engine target resolution (v2.4)
    // ==========================================
    let engineTarget = null;

    function frameHasLiveCanvas(w) {
      try {
        return !!(
          w &&
          w.LGraphCanvas &&
          w.LGraphCanvas.prototype &&
          w.document &&
          w.document.body
        );
      } catch (_) {
        return false;
      } // cross-origin access throws
    }

    function looksLikeComfyWindow() {
      try {
        if (window.LGraphCanvas) return true;
        if (window.app && window.app.canvas) return true;
        const p = location.pathname.toLowerCase();
        if (/\/workflow\/\d+/.test(p)) return true; // RH workflow sessions
        if (p.includes("/comfy")) return true;
      } catch (_) {}
      return false;
    }

    function engineTargetAlive() {
      if (!engineTarget) return false;
      if (engineTarget.host && !engineTarget.host.isConnected) return false; // iframe removed
      return (
        frameHasLiveCanvas(engineTarget.win) ||
        (!engineTarget.host && looksLikeComfyWindow())
      ); // self before mount
    }

    function resolveEngineTarget() {
      if (IN_IFRAME) return { win: window, doc: document };
      if (engineTargetAlive()) return engineTarget;
      engineTarget = null;

      // Engine hosted by THIS window (RH workflow popups: ComfyUI runs directly,
      // there is no comfyUI.html iframe in the user's flow).
      if (
        (frameHasLiveCanvas(window) || looksLikeComfyWindow()) &&
        document.body
      ) {
        engineTarget = { win: window, doc: document, host: null };
        return engineTarget;
      }

      // Deep scan ALL same-origin iframes for a live LGraphCanvas — iframe src
      // can lie (user's canvas iframe src didn't match "comfy").
      try {
        for (const f of document.querySelectorAll("iframe")) {
          try {
            const w = f.contentWindow;
            if (!w || !w.LGraphCanvas) continue;
            const d = f.contentDocument || w.document;
            if (d && d.body) {
              engineTarget = { win: w, doc: d, host: f };
              return engineTarget;
            }
          } catch (_) {
            /* cross-origin — skip */
          }
        }
      } catch (_) {}
      return null;
    }

    // ==========================================
    // 7. Canvas look & feel (live-instance, per-tick)
    // ==========================================
    const SPLINE_LINK = 2;
    function enforceInstanceSettings(cv) {
      try {
        if (
          config.darkerGrid &&
          cv.clear_background !== undefined &&
          cv.clear_background !== "#101012"
        ) {
          cv.clear_background = "#101012";
        }
        if (config.enhancedWires) {
          if (
            cv.link_render_mode !== undefined &&
            cv.link_render_mode !== SPLINE_LINK
          ) {
            cv.link_render_mode = SPLINE_LINK;
          }
          if (cv.connections_width !== undefined && cv.connections_width < 4) {
            cv.connections_width = 4;
          }
          if (cv.link_width !== undefined && cv.link_width < 2)
            cv.link_width = 2;
        }
      } catch (_) {
        /* instance not ready */
      }
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
      } catch (e) {
        console.warn(TAG, "canvas CSS injection failed", e);
      }
    }

    // ==========================================
    // 8. Engine attach (NO drawNode — see [FIX-A])
    // ==========================================
    function attachEngine(t) {
      const win = t.win,
        P = win.LGraphCanvas && win.LGraphCanvas.prototype;
      if (!P) return;

      if (
        win.__RH_IFRAME_ENGINE_OWNER__ &&
        win.__RH_IFRAME_ENGINE_OWNER__ !== window
      )
        return;
      win.__RH_IFRAME_ENGINE_OWNER__ = window;

      if (!P.__rh_render_attached) {
        P.__rh_render_attached = true;

        if (config.darkerGrid) P.clear_background = "#101012";

        if (config.fpsOptimization) {
          P.render_shadows = false;
          P.highquality_render = false;
          // Keep connection border when enhancedWires is ON — disabling it
          // makes wires look thinner.
          if (!config.enhancedWires) P.render_connections_border = false;
        }

        try {
          if (config.enhancedWires) {
            const SPLINE =
              win.LGraphCanvas.SPLINE_LINK != null
                ? win.LGraphCanvas.SPLINE_LINK
                : SPLINE_LINK;
            P.link_render_mode = SPLINE;
            P.connections_width = 4;
            P.link_width = 2;
          }
        } catch (e) {
          console.warn(TAG, "wire config failed", e);
        }

        // Right-click breakpoint menu (verified working since v2.1).
        const originalGetNodeMenuOptions = P.getNodeMenuOptions;
        P.getNodeMenuOptions = function (node) {
          const options = originalGetNodeMenuOptions
            ? originalGetNodeMenuOptions.apply(this, arguments)
            : [];
          try {
            const isStopNode = isStopId(node && node.id);
            const hasExisting = options.some(
              (o) =>
                o &&
                o.content &&
                (o.content.includes("Auto-Cancel") ||
                  o.content.includes("Stop Breakpoint")),
            );
            if (!hasExisting) {
              options.push({
                content: isStopNode
                  ? "🛑 Remove Stop Breakpoint"
                  : "🛑 Set Auto-Cancel Breakpoint",
                callback: () => {
                  const nowStop = toggleStopId(node.id);
                  rhToast(
                    nowStop
                      ? "🛑 Breakpoint SET on node " + node.id
                      : "Breakpoint removed from node " + node.id,
                  );
                  // Redraw via LiteGraph's OWN methods only — never the context.
                  try {
                    const cv = win.app && win.app.canvas;
                    if (cv) {
                      cv.setDirty(true, true);
                      cv.draw(true, true);
                    }
                  } catch (e) {
                    console.warn(TAG, "menu redraw failed", e);
                  }
                },
              });
            }
          } catch (e) {
            console.warn(TAG, "menu override error", e);
          }
          return options;
        };

        if (!win.__rh_engine_toast_shown__) {
          win.__rh_engine_toast_shown__ = true;
          rhToast("✅ RH engine attached");
        }
      }

      // Event-driven running tracking (api object identity-checked so swaps
      // re-hook). Drives overlays, [F] title status and [C] close-guard.
      if (win.api && win.__rh_hooked_api !== win.api) {
        const api = win.api;
        win.__rh_hooked_api = api;
        try {
          api.addEventListener("executing", (e) => {
            try {
              const d = e && e.detail;
              const rawId =
                d && typeof d === "object"
                  ? d.node != null
                    ? d.node
                    : d.display_node != null
                      ? d.display_node
                      : null
                  : d;
              if (rawId == null) {
                win.__rh_running = null;
                return;
              } // queue end

              win.__rh_running = { num: Number(rawId), str: String(rawId) };

              if (
                config.autoCenterRunningNode &&
                win.app &&
                win.app.graph &&
                win.app.canvas &&
                typeof win.app.canvas.centerOnNode === "function"
              ) {
                const node = win.app.graph.getNodeById(rawId);
                if (node) win.app.canvas.centerOnNode(node);
              }

              if (config.autoCancelBreakpoints && isStopId(rawId)) {
                triggerRHInterrupt({ win, doc: t.doc });
              }
            } catch (err) {
              console.warn(TAG, "executing-handler error", err);
            }
          });

          api.addEventListener("execution_start", () => {
            try {
              win.__rh_run_start = Date.now();
              win.__rh_run_active = true;
              win.__rh_running = null;
              win.__rh_last_done_str = "";
              win.__rh_title_base = null; // recapture per run
              win.__rh_title_released = false;
            } catch (_) {}
          });

          const onEnd = (label) => () => {
            try {
              win.__rh_running = null;
              win.__rh_run_active = false;
              win.__rh_last_done_str = win.__rh_run_start
                ? label + " in " + fmtDur(Date.now() - win.__rh_run_start)
                : label;
            } catch (_) {}
          };
          try {
            api.addEventListener("execution_success", onEnd("✅ Done"));
          } catch (_) {}
          try {
            api.addEventListener("execution_error", onEnd("❌ Error"));
          } catch (_) {}
          try {
            api.addEventListener("execution_interrupted", onEnd("⏸ Cancelled"));
          } catch (_) {}

          try {
            api.addEventListener("executed", (e) => {
              try {
                const d = e && e.detail;
                const nid = d && typeof d === "object" ? d.node : d;
                const R = win.__rh_running;
                if (R && (nid === R.num || String(nid) === R.str))
                  win.__rh_running = null;
              } catch (_) {}
            });
          } catch (_) {}
        } catch (e) {
          console.error(TAG, "api.addEventListener failed", e);
        }
      }
    }

    // ==========================================
    // 9. Screen-space overlay canvas (v2.4 — [FIX-B])
    //    Separate canvas, drawn in SCREEN coordinates derived from the live
    //    canvas instance (ds.scale / ds.offset + bounding rect). We never
    //    touch the LiteGraph 2D context — that was the tiling/freeze bug.
    // ==========================================
    const overlayState = { cv: null, ctx: null, w: 0, h: 0, dpr: 1 };

    function ensureOverlay(t) {
      try {
        const doc = t.doc;
        let cv = doc.getElementById("rh-graph-overlay");
        if (!cv || !cv.isConnected) {
          cv = doc.createElement("canvas");
          cv.id = "rh-graph-overlay";
          cv.style.cssText =
            "position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:999997;";
          (doc.body || doc.documentElement).appendChild(cv);
          overlayState.ctx = null;
        }
        overlayState.cv = cv;
        if (!overlayState.ctx) overlayState.ctx = cv.getContext("2d");
      } catch (e) {
        overlayState.cv = null;
        overlayState.ctx = null;
      }
    }

    function syncOverlaySize() {
      const dv = overlayState.cv.ownerDocument.defaultView;
      const w = dv.innerWidth,
        h = dv.innerHeight;
      const dpr = Math.max(1, dv.devicePixelRatio || 1);
      if (
        overlayState.w !== w ||
        overlayState.h !== h ||
        overlayState.dpr !== dpr
      ) {
        overlayState.w = w;
        overlayState.h = h;
        overlayState.dpr = dpr;
        overlayState.cv.width = Math.round(w * dpr);
        overlayState.cv.height = Math.round(h * dpr);
      }
    }

    // Graph-space node rect → this document's viewport coordinates. Ratio
    // covers builds where the canvas attribute size differs from CSS size.
    function nodeScreenRect(lgc, node) {
      try {
        const el = lgc.canvas;
        if (!el || !lgc.ds || !node.pos || !node.size) return null;
        const base = el.getBoundingClientRect();
        if (base.width <= 0 || base.height <= 0) return null;
        const scaleX = el.width ? base.width / el.width : 1;
        const scaleY = el.height ? base.height / el.height : 1;
        const s = lgc.ds.scale || 1;
        const ox = lgc.ds.offset ? lgc.ds.offset[0] : 0;
        const oy = lgc.ds.offset ? lgc.ds.offset[1] : 0;
        return {
          x: base.left + (node.pos[0] * s + ox) * scaleX,
          y: base.top + (node.pos[1] * s + oy) * scaleY,
          w: node.size[0] * s * scaleX,
          h: node.size[1] * s * scaleY,
        };
      } catch (_) {
        return null;
      }
    }

    function culled(r) {
      return !!(
        r &&
        r.x < overlayState.w &&
        r.y < overlayState.h &&
        r.x + r.w > 0 &&
        r.y + r.h > 0
      );
    }

    function drawBreakpointBox(ctx, r) {
      const x = r.x - 3,
        y = r.y - 3,
        w = r.w + 6,
        h = r.h + 6;
      ctx.save();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = "#FF3344";
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);
      ctx.font = "bold 11px monospace";
      ctx.fillStyle = "#FF3344";
      ctx.textBaseline = "bottom";
      ctx.fillText("🛑 AUTO-CANCEL STOP", x, y - 4);
      ctx.restore();
    }

    function drawRunningBrackets(ctx, r) {
      const pad = 6;
      const x = r.x - pad,
        y = r.y - pad,
        w = r.w + pad * 2,
        h = r.h + pad * 2;
      const len = Math.max(10, Math.min(18, Math.min(w, h) * 0.28));
      ctx.save();
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(0,255,102,0.25)";
      ctx.strokeRect(x - 3, y - 3, w + 6, h + 6);
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = "#00FF66";
      ctx.lineCap = "round";
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

    function overlayLoop() {
      if (destroyed) return;
      requestAnimationFrame(overlayLoop);
      try {
        const t = engineTarget;
        if (!t || !overlayState.cv || !overlayState.ctx) return;
        if (overlayState.cv.ownerDocument !== t.doc) return;
        syncOverlaySize();
        const ctx = overlayState.ctx;
        ctx.setTransform(overlayState.dpr, 0, 0, overlayState.dpr, 0, 0);
        ctx.clearRect(0, 0, overlayState.w, overlayState.h);

        const win = t.win;
        const lgc = win.app && win.app.canvas;
        const graph = win.app && win.app.graph;
        if (!lgc || !graph || !lgc.canvas || !lgc.ds) return;

        if (config.autoCancelBreakpoints && stopNodeIds.size > 0) {
          for (const id of Array.from(stopNodeIds)) {
            const node = graph.getNodeById(Number(id));
            if (!node) continue;
            const r = nodeScreenRect(lgc, node);
            if (culled(r)) drawBreakpointBox(ctx, r);
          }
        }
        if (config.vectorNodeIndicator && win.__rh_running) {
          const node = graph.getNodeById(win.__rh_running.num);
          if (node) {
            const r = nodeScreenRect(lgc, node);
            if (culled(r)) drawRunningBrackets(ctx, r);
          }
        }
      } catch (_) {
        /* overlay errors must NEVER reach the page */
      }
    }
    requestAnimationFrame(overlayLoop);

    // ==========================================
    // 10. [F] Popup title status + [C] close-guard
    // ==========================================
    function titleTick() {
      try {
        if (!IS_ENGINE_WINDOW || !config.popupTitleStatus) return;
        const win = engineTarget ? engineTarget.win : window;
        let base = win.__rh_title_base;
        if (!base) {
          base =
            (document.title || "RunningHub")
              .replace(/\s*[·▶✅❌⏸][\s\S]*$/, "")
              .trim() || "RunningHub";
          win.__rh_title_base = base;
        }
        if (win.__rh_run_active && win.__rh_run_start) {
          document.title =
            base +
            " · ▶ " +
            fmtDur(Date.now() - win.__rh_run_start) +
            " · Running";
          win.__rh_title_released = false;
        } else if (win.__rh_last_done_str) {
          document.title = base + " · " + win.__rh_last_done_str;
        } else if (!win.__rh_title_released) {
          document.title = base;
          win.__rh_title_released = true;
        }
      } catch (_) {}
    }
    const titleTimer = setInterval(titleTick, 1000);
    cleanups.push(() => clearInterval(titleTimer));

    window.addEventListener("beforeunload", (e) => {
      try {
        if (destroyed) return; // deliberate teardown/hot-reload — never block it
        if (!config.closeGuard) return;
        if (!IS_ENGINE_WINDOW) return;
        const win = engineTarget ? engineTarget.win : window;
        if (win && (win.__rh_run_active || win.__rh_running)) {
          e.preventDefault();
          e.returnValue = "";
        }
      } catch (_) {}
    });

    // ==========================================
    // 11. Task Timer HUD (poller-driven, .rh-task-item scoped)
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
      } catch (e) {
        /* body not ready */
      }
    }

    function updateTaskTimerHUD() {
      const hud = document.getElementById("rh-timer-hud");
      if (!hud) return;
      try {
        let timeEl =
          document.querySelector(
            ".rh-task-item [class*='status'], .rh-task-item .rh-task-time",
          ) ||
          document.querySelector(
            ".workflow-result-wrap .rh-task-status > div, " +
              "[class*='workflow-result-wrap'] .rh-task-time, " +
              "[class*='workflow-result-wrap'] [class*='status']",
          );
        if (timeEl && timeEl.innerText && timeEl.innerText.trim()) {
          const txt = timeEl.innerText.trim();
          const disp = hud.querySelector("#rh-hud-time");
          if (disp && disp.textContent !== txt) disp.textContent = txt;
          if (hud.style.display !== "flex") hud.style.display = "flex";
          return;
        }
        if (hud.style.display !== "none") hud.style.display = "none";
      } catch (e) {
        /* transient */
      }
    }

    // ==========================================
    // 12. Floating Settings UI — home window only
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
        <div style="font-weight: bold; margin-bottom: 4px; font-size: 13px; border-bottom: 1px solid #333; padding-bottom: 4px; display: flex; justify-content: space-between; align-items: center;">
          <span>QoL & Script Manager</span>
          <span id="rh-close-btn" style="cursor:pointer; color:#777; font-size: 16px;">✕</span>
        </div>
        <div id="rh-live-source" style="font-size:10px;color:#666;margin:6px 0 8px 0;">live script copy: …</div>

        <div style="display:flex;gap:6px;margin-bottom:10px;">
          <button id="rh-edit-script-btn" style="flex:1;padding:6px;background:#2b2b36;border:1px solid #00FF66;color:#00FF66;border-radius:4px;cursor:pointer;font-size:11px;font-weight:bold;">📝 Edit Script</button>
          <button id="rh-reload-btn" title="Reload page" style="padding:6px 10px;background:#2b2b36;border:1px solid #444;color:#ccc;border-radius:4px;cursor:pointer;font-size:11px;">🔄</button>
        </div>

        <button id="rh-import-cookies-btn" style="width: 100%; margin-bottom: 10px; padding: 6px; background: #2b2b36; border: 1px solid #00FF66; color: #00FF66; border-radius: 4px; cursor: pointer; font-size: 11px; font-weight: bold;">📋 Paste Cookies (JSON)</button>

        <div style="font-size: 11px; color: #888; font-weight: bold; margin-bottom: 4px; text-transform: uppercase;">Core Features:</div>
        <div id="rh-core-toggles" style="margin-bottom: 8px;">
          ${Object.keys(DEFAULT_CONFIG)
            .map(
              (key) => `
            <label style="display: flex; justify-content: space-between; align-items: center; margin: 5px 0; font-size: 11px; cursor: pointer;">
              <span>${esc(key)}</span>
              <input type="checkbox" data-core-key="${esc(key)}" ${config[key] ? "checked" : ""} style="cursor: pointer;">
            </label>`,
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
      document.body.appendChild(container);
      container.style.left = savedPos.x + "px";
      container.style.top = savedPos.y + "px";

      const liveSrcEl = container.querySelector("#rh-live-source");
      if (liveSrcEl) {
        liveSrcEl.textContent =
          "live script copy: " +
          (window.__RH_LIVE_SOURCE__ === "cache"
            ? "LAST-GOOD CACHE"
            : "OVERRIDE");
      }

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

      let isDragging = false,
        startX = 0,
        startY = 0,
        initialLeft = 0,
        initialTop = 0,
        dragDistance = 0;

      function onPointerMove(e) {
        if (!isDragging) return;
        const dx = e.clientX - startX,
          dy = e.clientY - startY;
        dragDistance = Math.hypot(dx, dy);
        let nextX = Math.max(
          8,
          Math.min(initialLeft + dx, window.innerWidth - 44),
        );
        let nextY = Math.max(
          8,
          Math.min(initialTop + dy, window.innerHeight - 44),
        );
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
          localStorage.setItem(
            POS_KEY,
            JSON.stringify({
              x: Math.round(rect.left),
              y: Math.round(rect.top),
            }),
          );
        } catch (e) {
          console.warn(TAG, "pos save failed", e);
        }
        adjustPanelPosition();
      }

      toggleBtn.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        const rect = container.getBoundingClientRect();
        initialLeft = rect.left;
        initialTop = rect.top;
        dragDistance = 0;
        try {
          toggleBtn.setPointerCapture(e.pointerId);
        } catch (_) {}
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
      const editScriptBtn = container.querySelector("#rh-edit-script-btn");
      const reloadBtn = container.querySelector("#rh-reload-btn");
      const importCookiesBtn = container.querySelector(
        "#rh-import-cookies-btn",
      );
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
            <span style="max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(s.name)}</span>
          </label>
          <span class="rh-delete-script" data-delete-idx="${idx}" style="cursor: pointer; color: #ff5555; font-size: 12px;" title="Delete">🗑️</span>
        </div>`,
          )
          .join("");
        userScriptList
          .querySelectorAll(".rh-delete-script")
          .forEach((delBtn) => {
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

      closeBtn.onclick = () => {
        panel.style.display = "none";
      };
      importCookiesBtn.onclick = () => {
        pasteAndImportCookies();
      };
      editScriptBtn.onclick = () => {
        panel.style.display = "none";
        openScriptEditor();
      };
      reloadBtn.onclick = () => {
        location.reload();
      };

      addScriptBtn.onclick = () => {
        const name =
          newScriptName.value.trim() || `Script #${customScripts.length + 1}`;
        const code = newScriptCode.value.trim();
        if (!code) {
          rhToast("⚠️ Please enter script code.");
          return;
        }
        try {
          new Function(code);
        } catch (err) {
          rhToast("❌ Syntax error in script: " + err.message);
          return;
        }
        customScripts.push({ id: Date.now(), name, code, enabled: true });
        newScriptName.value = "";
        newScriptCode.value = "";
        renderCustomScriptList();
      };

      saveApplyBtn.onclick = () => {
        try {
          container
            .querySelectorAll("input[data-core-key]")
            .forEach((input) => {
              config[input.dataset.coreKey] = input.checked;
            });
          saveConfig();
          container
            .querySelectorAll("input[data-script-idx]")
            .forEach((input) => {
              const idx = parseInt(input.dataset.scriptIdx, 10);
              if (customScripts[idx])
                customScripts[idx].enabled = input.checked;
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
    // 13. In-app Script Editor (sole update channel)
    //     Also opens via Ctrl+Shift+E from any RH window — emergency hatch
    //     that works even if the floating menu never appeared.
    // ==========================================
    function openScriptEditor() {
      if (document.getElementById("rh-edit-overlay")) return;
      let overrideSrc = null,
        cacheSrc = null;
      try {
        overrideSrc = localStorage.getItem(SCRIPT_OVERRIDE_KEY);
      } catch (_) {}
      try {
        cacheSrc = localStorage.getItem(SCRIPT_CACHE_KEY);
      } catch (_) {}

      const label =
        window.__RH_LIVE_SOURCE__ === "cache" ||
        (window.__RH_LIVE_SOURCE__ !== "override" &&
          overrideSrc == null &&
          cacheSrc != null)
          ? "LAST-GOOD CACHE (no override set — saving creates one)"
          : overrideSrc != null || window.__RH_LIVE_SOURCE__ === "override"
            ? "OVERRIDE (your edited copy is live)"
            : "— none —";
      const prefill =
        overrideSrc != null ? overrideSrc : cacheSrc != null ? cacheSrc : "";

      const ov = document.createElement("div");
      ov.id = "rh-edit-overlay";
      ov.style.cssText =
        "position:fixed;inset:0;z-index:1000002;background:rgba(0,0,0,.6);" +
        "display:flex;align-items:center;justify-content:center;";
      ov.innerHTML = `
      <div style="width:min(920px,94vw);height:min(80vh,720px);background:#16161a;border:1px solid #333;border-radius:8px;display:flex;flex-direction:column;overflow:hidden;font-family:monospace;color:#ddd;box-shadow:0 12px 40px rgba(0,0,0,.8);">
        <div style="padding:10px 14px;border-bottom:1px solid #333;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
          <div style="font-weight:bold;font-size:13px;">📝 Edit Script — custom_r.js v${VERSION}</div>
          <div id="rh-edit-state" style="font-size:10px;color:#00FF66;">LIVE: ${esc(label)}</div>
        </div>
        <textarea id="rh-edit-code" spellcheck="false" style="flex:1;width:100%;box-sizing:border-box;background:#0e0e12;border:none;color:#00FF66;padding:10px;font-family:monospace;font-size:11px;resize:none;outline:none;"></textarea>
        <div style="padding:10px 14px;display:flex;gap:8px;justify-content:flex-end;align-items:center;">
          <div style="margin-right:auto;font-size:9px;color:#666;">Syntax-checked before saving · cache refreshes only after a clean boot</div>
          <button id="rh-edit-remove" style="padding:6px 14px;background:#552222;border:1px solid #883333;color:#ffbbbb;border-radius:4px;cursor:pointer;font-size:11px;">Remove Override</button>
          <button id="rh-edit-cancel" style="padding:6px 14px;background:#2b2b36;border:1px solid #444;color:#ccc;border-radius:4px;cursor:pointer;font-size:11px;">Cancel</button>
          <button id="rh-edit-save" style="padding:6px 18px;background:#00AA55;border:none;color:#fff;border-radius:4px;cursor:pointer;font-weight:bold;font-size:11px;">Save &amp; Reload</button>
        </div>
      </div>`;
      document.body.appendChild(ov);
      const ta = ov.querySelector("#rh-edit-code");
      ta.value = prefill;
      ov.querySelector("#rh-edit-cancel").onclick = () => ov.remove();
      ta.addEventListener("keydown", (e) => {
        if (e.key === "Escape") ov.remove();
      });
      ov.querySelector("#rh-edit-remove").onclick = () => {
        try {
          localStorage.removeItem(SCRIPT_OVERRIDE_KEY);
        } catch (_) {}
        location.reload();
      };
      ov.querySelector("#rh-edit-save").onclick = () => {
        const code = ta.value;
        if (!code || !code.trim()) {
          rhToast("⚠️ Refusing to save an empty script");
          return;
        }
        try {
          new Function(code);
        } catch (err) {
          // syntax check BEFORE saving
          rhToast("❌ Syntax error: " + err.message, 6000);
          return;
        }
        try {
          localStorage.setItem(SCRIPT_OVERRIDE_KEY, code);
        } catch (err) {
          rhToast("❌ Save failed: " + err.message);
          return;
        }
        rhToast("✅ Saved — reloading…");
        setTimeout(() => location.reload(), 400);
      };
      ta.focus();
    }

    // ==========================================
    // 14. Lifecycle Poller
    // ==========================================
    function pollTick() {
      try {
        if (SHOULD_LOCK_TITLE) {
          const titleEl = document.querySelector("title");
          if (titleEl && titleEl.textContent !== "RunningHub")
            titleEl.textContent = "RunningHub";
        }
      } catch (e) {}

      try {
        if (
          SHOW_FLOATING_UI &&
          document.body &&
          !document.getElementById("rh-floating-root")
        ) {
          createFloatingMenu();
        }
      } catch (e) {
        console.warn(TAG, "floating menu tick failed", e);
      }

      try {
        const t = resolveEngineTarget();
        if (t && t.win.LGraphCanvas && t.win.LGraphCanvas.prototype) {
          injectCanvasCSS(t);
          attachEngine(t);
          ensureOverlay(t);
          const cv = t.win.app && t.win.app.canvas;
          if (cv) enforceInstanceSettings(cv);
        }
      } catch (e) {
        console.warn(TAG, "canvas engine tick failed", e);
      }

      try {
        ensureTaskTimerHUD();
        updateTaskTimerHUD();
      } catch (e) {
        /* cosmetic */
      }
    }
    const pollTimer = setInterval(pollTick, 600);
    cleanups.push(() => clearInterval(pollTimer));
    pollTick();

    // ==========================================
    // 15. Teardown (used by __RH_HOT_RELOAD__)
    // ==========================================
    window.__RH_EXT_TEARDOWN__ = function () {
      destroyed = true;
      cleanups.forEach((fn) => {
        try {
          fn();
        } catch (e) {
          console.warn(TAG, "cleanup error", e);
        }
      });
      [
        "rh-floating-root",
        "rh-timer-hud",
        "rh-toast-host",
        "rh-modal-overlay",
        "rh-floating-style",
        "rh-canvas-perf-style",
        "rh-edit-overlay",
        "rh-firstrun-overlay",
      ].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.remove();
      });
      // The overlay canvas may live in the engine document (iframe case).
      try {
        if (engineTarget && engineTarget.doc) {
          const oc = engineTarget.doc.getElementById("rh-graph-overlay");
          if (oc) oc.remove();
        }
      } catch (_) {}
      window.__RH_EXT_INITIALIZED__ = false;
      console.info(TAG, "teardown complete");
    };

    // Debug handle (console)
    window.__RH_DEBUG__ = {
      version: VERSION,
      config,
      stopNodeIds,
      engine: () => engineTarget,
      cancel: triggerRHInterrupt,
      teardown: () =>
        window.__RH_EXT_TEARDOWN__ && window.__RH_EXT_TEARDOWN__(),
    };

    // MUST be set last — the bootstrap refreshes the last-good cache only
    // when this is true after the eval returns.
    window.__RH_LIVE_SOURCE__ = "bundled";
    window.__RH_EXT_INITIALIZED__ = true;
    console.info(TAG, "v" + VERSION + " initialized", {
      IS_POPUP,
      IN_IFRAME,
      IS_WORKFLOW_PAGE,
      SHOW_FLOATING_UI,
      source: window.__RH_LIVE_SOURCE__ || "bundled",
    });
  } catch (fatalErr) {
    window.__RH_EXT_INITIALIZED__ = false;
    console.error(
      TAG,
      "FATAL init error — last-good cache was NOT overwritten.",
      fatalErr,
    );
  }
})();
