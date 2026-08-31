(function () {
  "use strict";

  // Guard set LAST (after successful top-level init) so a corrupted-storage
  // throw can never permanently brick the script.
  if (window.__RH_EXT_INITIALIZED__) return;

  const TAG = "[RH Ext]";
  const cleanups = [];
  try {
    // ==========================================
    // 0. Utilities (safe storage, escape, toast, modal)
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
        el.textContent = msg; // textContent — never innerHTML for dynamic text
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

    // Non-blocking modal replacing prompt()/alert() — never blocks the WebView2
    // event loop mid-generation.
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

    // ==========================================
    // 1. Popup Window & Title Bar Normalization
    // ==========================================

    // --- Title: property override (idempotent, configurable for teardown) ---
    try {
      const origTitleDesc =
        Object.getOwnPropertyDescriptor(document, "title") ||
        Object.getOwnPropertyDescriptor(Document.prototype, "title");
      if (origTitleDesc && origTitleDesc.configurable) {
        cleanups.push(() => {
          try {
            delete document.title;
            Object.defineProperty(document, "title", origTitleDesc);
          } catch (_) {}
        });
      }
      document.title = "RunningHub";
      Object.defineProperty(document, "title", {
        configurable: true,
        get() {
          return "RunningHub";
        },
        set() {
          /* SPA router writes are swallowed */
        },
      });
    } catch (e) {
      console.warn(
        TAG,
        "title override failed (poller fallback still active)",
        e,
      );
    }
    // NOTE: No MutationObserver on <title>. The poller enforces the text node
    // directly (cheap, SPA-replace-proof) — one less observer to leak.

    // --- window.open interception (top realm + iframe realm) ---
    function isWorkflowUrl(url) {
      if (typeof url !== "string" || !url) return false;
      try {
        const u = new URL(url, location.href);
        const path = u.pathname.toLowerCase();
        // Match path segments only — no raw substring matches on query junk.
        if (/(^|\/)(task|workflow|comfy)/.test(path)) return true;
        // Known query-token launches (e.g. /workshop?task_id=...)
        return (
          u.searchParams.has("task_id") || u.searchParams.has("workflow_id")
        );
      } catch (e) {
        return false; // unparseable → treat as non-workflow, pass through
      }
    }

    function patchWindowOpen(w) {
      if (!w || w.__RH_OPEN_PATCHED__) return;
      w.__RH_OPEN_PATCHED__ = true;
      const origOpen = w.open.bind(w);
      const patched = function (url, target, features) {
        try {
          if (isWorkflowUrl(url)) {
            return origOpen(
              url,
              target,
              "width=1400,height=900,resizable=yes,scrollbars=yes",
            );
          }
        } catch (e) {
          console.warn(TAG, "open-patch check failed; delegating natively", e);
        }
        return origOpen(url, target, features); // untouched path — zero behavior change
      };
      try {
        w.open = patched;
        cleanups.push(() => {
          try {
            w.open = origOpen;
            w.__RH_OPEN_PATCHED__ = false;
          } catch (_) {}
        });
      } catch (e) {
        console.warn(TAG, "could not patch window.open on realm", e);
      }
    }
    patchWindowOpen(window);

    // ==========================================
    // 2. Configuration & Persistence (all reads crash-proof)
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
      try {
        localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
      } catch (e) {
        console.warn(TAG, "saveConfig failed", e);
      }
    }

    // Sanitize custom scripts (recursion guard from v1, preserved)
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
      console.warn(TAG, "custom scripts reset", e);
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

    // Execute stored UserScripts (trusted-user feature; per-script error boundary)
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
    // 3. Cookie JSON Importer (Ctrl+Shift+V) — non-blocking
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
        console.warn(TAG, "clipboard read denied; falling back to modal", e);
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
      // Do NOT hijack paste inside text fields (script editor, prompt boxes, etc.)
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
            // Per Fetch spec: 204 must have a NULL body. new Response("",{status:204})
            // throws TypeError — that was a live bug in v1.
            return Promise.resolve(
              new Response(null, { status: 204, statusText: "No Content" }),
            );
          }
        } catch (e) {
          console.warn(TAG, "fetch-patch check failed; delegating natively", e);
        }
        return origFetch(input, init);
      };
      cleanups.push(() => {
        window.fetch = origFetch;
      });
    }

    // ==========================================
    // 5. ComfyUI Canvas & Execution Engine
    // ==========================================
    const stopNodeIds = new Set(); // string keys (menu/UI display)
    const stopNodeIdNums = new Set(); // numeric keys — ZERO-ALLOC hot-path checks

    function isStopId(id) {
      if (typeof id === "number") return stopNodeIdNums.has(id);
      return stopNodeIds.has(String(id));
    }
    function addStopId(id) {
      stopNodeIds.add(String(id));
      if (typeof id === "number") stopNodeIdNums.add(id);
    }
    function removeStopId(id) {
      stopNodeIds.delete(String(id));
      stopNodeIdNums.delete(typeof id === "number" ? id : Number(id));
    }

    let lastExecutedNodeId = null;

    function extractExecId(detail) {
      // Handles: number | string | {node, display_node} | null (end-of-queue)
      if (detail == null) return null;
      let raw = detail;
      if (typeof detail === "object") {
        raw =
          detail.node != null
            ? detail.node
            : detail.display_node != null
              ? detail.display_node
              : null;
      }
      if (raw == null) return null;
      const s = String(raw);
      return s === "null" || s === "undefined" || !s ? null : s;
    }

    function triggerRHInterrupt(iWin, iDoc) {
      // Primary: ComfyUI API interrupt (clean, no DOM roulette)
      try {
        if (iWin.api && typeof iWin.api.interrupt === "function") {
          iWin.api.interrupt();
          rhToast("🛑 Auto-cancel breakpoint triggered");
          return;
        }
      } catch (e) {
        console.warn(TAG, "api.interrupt failed", e);
      }
      // Fallback: STRICTLY scoped. No [class*='cancel'] wildcard — v1 could click
      // "cancel subscription" links or modal close buttons.
      try {
        const btn =
          document.querySelector(".workflow-result-wrap .rh-cancel-btn") ||
          (iDoc ? iDoc.querySelector(".rh-cancel-btn") : null);
        if (btn && btn.tagName === "BUTTON" && !btn.disabled) {
          btn.click();
          rhToast("🛑 Auto-cancel sent (cancel button)");
        } else {
          rhToast("⚠️ Breakpoint hit but no cancel control found");
        }
      } catch (e) {
        console.warn(TAG, "cancel-button fallback failed", e);
      }
    }

    // Cached iframe resolution (steady-state poller = 1 isConnected check)
    let cachedIframe = null;
    function findComfyIframe() {
      if (cachedIframe && cachedIframe.isConnected) return cachedIframe;
      cachedIframe =
        document.querySelector('iframe[src*="comfyUI.html"]') ||
        document.querySelector("iframe");
      return cachedIframe;
    }

    function injectCanvasEngine() {
      const iframe = findComfyIframe();
      if (!iframe) return;

      let iWin, iDoc;
      try {
        iWin = iframe.contentWindow;
        iDoc = iframe.contentDocument || (iWin && iWin.document);
      } catch (e) {
        return; // cross-origin / not ready — retried next tick
      }
      if (!iWin || !iDoc || !iDoc.body) return;

      // Cross-realm owner guard: if another realm (e.g. the RH UserScripts loader)
      // already owns engine injection in this iframe, stand down.
      if (
        iWin.__RH_IFRAME_ENGINE_OWNER__ &&
        iWin.__RH_IFRAME_ENGINE_OWNER__ !== window
      )
        return;
      iWin.__RH_IFRAME_ENGINE_OWNER__ = window;

      // Also constrain workflow popups launched FROM the iframe (same-origin).
      try {
        patchWindowOpen(iWin);
      } catch (_) {}

      // --- CSS injection (id-guarded, no will-change / image-rendering:
      //     both measured as net-negative on WebView2 compositor during panning) ---
      if (config.darkerGrid && !iDoc.getElementById("rh-canvas-perf-style")) {
        try {
          const st = iDoc.createElement("style");
          st.id = "rh-canvas-perf-style";
          st.textContent = `
          body, html, canvas#graph-canvas { background-color: #101012 !important; }
          .litegraph .lgraphcanvas { background-color: #101012 !important; }
          canvas#graph-canvas { touch-action: none !important; }
        `;
          iDoc.head.appendChild(st);
        } catch (e) {
          console.warn(TAG, "iframe style injection failed", e);
        }
      }

      if (!iWin.LGraphCanvas || !iWin.LGraphCanvas.prototype) return;
      const P = iWin.LGraphCanvas.prototype;

      // --- PER-FEATURE flags: a tick where LGraphCanvas exists but LiteGraph
      //     hasn't mounted can no longer permanently skip a feature. ---
      if (!P.__rh_render_attached) {
        P.__rh_render_attached = true;

        if (config.darkerGrid) P.clear_background = "#101012";

        if (config.fpsOptimization) {
          P.render_shadows = false;
          P.render_connections_border = false;
          P.highquality_render = false;
        }

        // ---- 5a. drawNode overlay: running indicator + breakpoint marker ----
        const overlayEnabled =
          config.vectorNodeIndicator || config.autoCancelBreakpoints;

        if (overlayEnabled) {
          const originalDrawNode = P.drawNode;
          P.drawNode = function (node, ctx) {
            const result = originalDrawNode.apply(this, arguments);
            try {
              if (!node || !ctx) return result;

              const isBreakpoint =
                config.autoCancelBreakpoints && isStopId(node.id);

              let isRunning = false;
              if (config.vectorNodeIndicator) {
                isRunning = !!(
                  node.is_executing ||
                  node.running ||
                  this.node_executing === node
                );
              }

              if (!isRunning && !isBreakpoint) return result;

              // Cull off-viewport nodes (free via LiteGraph's own check)
              if (
                typeof this.isNodeVisible === "function" &&
                !this.isNodeVisible(node)
              ) {
                return result;
              }

              if (isRunning) {
                const x = node.pos[0] - 6,
                  y = node.pos[1] - 6;
                const w = node.size[0] + 12,
                  h = node.size[1] + 12;
                ctx.save();
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
                ctx.lineTo(x + w);
                ctx.lineTo(x + w, y + len);
                ctx.moveTo(x, y + h - len);
                ctx.lineTo(x, y + h);
                ctx.lineTo(x + len, y + h);
                ctx.moveTo(x + w - len, y + h);
                ctx.lineTo(x + w);
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
                ctx.font = "bold 12px monospace";
                ctx.fillText(
                  "🛑 AUTO-CANCEL STOP",
                  node.pos[0],
                  node.pos[1] - 8,
                );
                ctx.restore();
              }
            } catch (e) {
              // NEVER let our overlay break LiteGraph's render loop.
              console.warn(TAG, "drawNode overlay error (suppressed)", e);
            }
            return result;
          };
        }

        // ---- 5b. Right-click breakpoint menu ----
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
                  // Re-read state at click time — the `isStopNode` captured above
                  // can be stale if the menu stayed open across executions.
                  if (isStopId(node.id)) removeStopId(node.id);
                  else addStopId(node.id);
                  try {
                    if (iWin.app && iWin.app.canvas) {
                      iWin.app.canvas.setDirty(true, true);
                      iWin.app.canvas.draw(true, true);
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
      }

      // Enhanced wires — guarded by its OWN flag (independent mount timeline)
      if (config.enhancedWires && iWin.LiteGraph && !iWin.__rh_link_mode_set) {
        try {
          iWin.LiteGraph.LINK_RENDER_MODE = 2;
          iWin.__rh_link_mode_set = true;
        } catch (e) {
          console.warn(TAG, "LINK_RENDER_MODE failed", e);
        }
      }

      // ---- 5c. Execution listener — IDENTITY-checked hook (self-heals if the
      //          site swaps/re-instantiates the `api` object mid-session) ----
      if (iWin.api && iWin.__rh_hooked_api !== iWin.api) {
        const api = iWin.api;
        iWin.__rh_hooked_api = api;
        try {
          api.addEventListener("executing", (e) => {
            try {
              const d = e && e.detail;
              // Raw id kept for graph lookups; null detail = end of queue → reset dedupe
              const rawId =
                d && typeof d === "object"
                  ? d.node != null
                    ? d.node
                    : d.display_node != null
                      ? d.display_node
                      : null
                  : d;
              if (rawId == null) {
                lastExecutedNodeId = null;
                return;
              }

              const idStr = String(rawId);
              if (idStr === lastExecutedNodeId) return;
              lastExecutedNodeId = idStr;

              if (
                config.autoCenterRunningNode &&
                iWin.app &&
                iWin.app.graph &&
                iWin.app.canvas &&
                typeof iWin.app.canvas.centerOnNode === "function"
              ) {
                const node = iWin.app.graph.getNodeById(rawId);
                if (node) iWin.app.canvas.centerOnNode(node);
              }

              if (config.autoCancelBreakpoints && isStopId(rawId)) {
                triggerRHInterrupt(iWin, iDoc);
              }
            } catch (err) {
              console.warn(TAG, "executing-handler error (suppressed)", err);
            }
          });
          // Reset dedupe at the start of each run so re-executed nodes
          // (loops, re-queues) re-trigger centering/breakpoints correctly.
          api.addEventListener("execution_start", () => {
            lastExecutedNodeId = null;
          });
        } catch (e) {
          console.error(TAG, "api.addEventListener failed", e);
        }
      }
    }

    // ==========================================
    // 6. Task Timer HUD — POLLER-DRIVEN (no MutationObserver)
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
        /* body not ready — next tick */
      }
    }

    function updateTaskTimerHUD() {
      const hud = document.getElementById("rh-timer-hud");
      if (!hud) return;
      try {
        const taskWrap = document.querySelector(".workflow-result-wrap");
        if (taskWrap) {
          const timeEl = taskWrap.querySelector(
            ".rh-task-status > div, .rh-task-time, [class*='status']",
          );
          if (timeEl && timeEl.innerText && timeEl.innerText.trim()) {
            const txt = timeEl.innerText.trim();
            const disp = hud.querySelector("#rh-hud-time");
            // Only touch the DOM on change — avoids per-tick layout work
            if (disp && disp.textContent !== txt) disp.textContent = txt;
            if (hud.style.display !== "flex") hud.style.display = "flex";
            return;
          }
        }
        if (hud.style.display !== "none") hud.style.display = "none";
      } catch (e) {
        /* transient DOM churn — next tick */
      }
    }

    // ==========================================
    // 7. Draggable Floating Settings UI (Pointer Events, XSS-safe list)
    // ==========================================
    function createFloatingMenu() {
      if (document.getElementById("rh-floating-root")) return;
      if (!document.body) return;

      // Style tag: OWN id + guard (v1 re-appended a duplicate on every body wipe)
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
            .map(
              (key) => `
            <label style="display: flex; justify-content: space-between; align-items: center; margin: 5px 0; font-size: 11px; cursor: pointer;">
              <span>${esc(key)}</span>
              <input type="checkbox" data-core-key="${esc(key)}" ${config[key] ? "checked" : ""} style="cursor: pointer;">
            </label>
          `,
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

      // --- Pointer-capture drag: pointerup is GUARANTEED to fire on the element
      //     even if released outside the window; pointercancel handles OS steals. ---
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
        let nextX = initialLeft + dx,
          nextY = initialTop + dy;
        nextX = Math.max(8, Math.min(nextX, window.innerWidth - 44));
        nextY = Math.max(8, Math.min(nextY, window.innerHeight - 44));
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
        // NOTE: s.name is user-controlled → esc() (v1 injected it raw: stored-XSS)
        userScriptList.innerHTML = customScripts
          .map(
            (s, idx) => `
        <div style="display: flex; justify-content: space-between; align-items: center; margin: 4px 0; background: #101014; padding: 3px 6px; border-radius: 4px; font-size: 11px;">
          <label style="cursor: pointer; display: flex; align-items: center; gap: 6px;">
            <input type="checkbox" data-script-idx="${idx}" ${s.enabled ? "checked" : ""}>
            <span style="max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(s.name)}</span>
          </label>
          <span class="rh-delete-script" data-delete-idx="${idx}" style="cursor: pointer; color: #ff5555; font-size: 12px;" title="Delete">🗑️</span>
        </div>
      `,
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

      addScriptBtn.onclick = () => {
        const name =
          newScriptName.value.trim() || `Script #${customScripts.length + 1}`;
        const code = newScriptCode.value.trim();
        if (!code) {
          rhToast("⚠️ Please enter script code.");
          return;
        }
        // Compile-check at add time — catches syntax errors BEFORE they save.
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
    // 8. Lifecycle Poller (single interval, fully synchronous, O(1) steady-state)
    // ==========================================
    function pollTick() {
      try {
        // Title enforcement (replaces the <title> MutationObserver — SPA-replace-proof)
        const titleEl = document.querySelector("title");
        if (titleEl && titleEl.textContent !== "RunningHub") {
          titleEl.textContent = "RunningHub";
        }
      } catch (e) {}

      try {
        if (document.body && !document.getElementById("rh-floating-root"))
          createFloatingMenu();
      } catch (e) {
        console.warn(TAG, "floating menu tick failed", e);
      }

      try {
        injectCanvasEngine();
      } catch (e) {
        console.warn(TAG, "canvas engine tick failed", e);
      }

      try {
        ensureTaskTimerHUD();
        updateTaskTimerHUD();
      } catch (e) {
        /* silent: cosmetic */
      }
    }
    const pollTimer = setInterval(pollTick, 600);
    cleanups.push(() => clearInterval(pollTimer));
    pollTick(); // first run immediately — no 600ms blank flash on load

    // Diagnostic teardown: run window.__RH_EXT_TEARDOWN__() in devtools to
    // restore the page to a pre-injection state.
    window.__RH_EXT_TEARDOWN__ = function () {
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
      ].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.remove();
      });
      window.__RH_EXT_INITIALIZED__ = false;
      console.info(TAG, "teardown complete");
    };

    // Guard set LAST — a throw anywhere above leaves the flag false so the next
    // injection attempt (poller/loader re-run) retries cleanly.
    window.__RH_EXT_INITIALIZED__ = true;
    console.info(
      TAG,
      "v2.0 initialized — features:",
      Object.keys(config)
        .filter((k) => config[k])
        .join(", "),
    );
  } catch (fatalErr) {
    window.__RH_EXT_INITIALIZED__ = false;
    console.error(
      TAG,
      "FATAL init error — will retry on next injection. Run __RH_EXT_TEARDOWN__() to clean partial state.",
      fatalErr,
    );
  }
})();
