/* ==========================================================================
 * RunningHub ComfyUI Desktop Wrapper — custom_r.js  v2.6 FINAL
 * --------------------------------------------------------------------------
 * VERIFIED BY LIVE PROBE (2026-09) — facts, not assumptions:
 *  - /workflow/<id> is an RH Vue SPA. ComfyUI runs in a SAME-ORIGIN iframe,
 *    src="/comfyUI.html". Injected scripts DO run in BOTH frames.
 *  - v2.5 died because it made the iframe copy "stand down": at document
 *    start the frame-tree test is a race and BOTH copies opted out. v2.6
 *    never stands down — every copy runs; UI placement is decided by
 *    document identity (document === window.top.document).
 *  - Task sidebar is in the TOP frame: .workflow-result-wrap > .list-wrap >
 *    .rh-task-item > .history-top-info > .rh-cancel-btn (a DIV, "Cancel").
 *    Ships COLLAPSED (class "hide", 1px) → children measure 0x0, so click by
 *    selector with NO size gate. Also .rh-task-status > .task-status-running
 *    ("Generating 00:15") and .rh-task-id. Toasts mount at #rh-message-root.
 *  - Engine: app.canvas in the iframe. clear_background is a BOOLEAN flag,
 *    clear_background_color is the colour; links_render_mode (plural) is the
 *    link style; connections_width defaults to 3.
 *  - Overlay coords: use the engine's convertOffsetToCanvas, then multiply by
 *    viewportFactor() — the canvas backing store can disagree with its CSS box
 *    (attr 1053x802 vs css 965x735 seen live).
 *  - node.is_executing does NOT exist. Run state comes from api events, and
 *    RH does NOT forward execution_success → end of run is "executing" with a
 *    null node (plus status/DOM backstops).
 *  - NEVER hook drawNode/draw or touch LiteGraph's 2D context (tiling and
 *    frozen-input corruption). Overlays live on our own canvas.
 * ========================================================================== */
(function () {
  "use strict";

  var VERSION = "2.6";

  /* A stale copy saved in localStorage must never outrank a newer bundled one.
   * v2.5 and earlier are exactly the copies that break in workflow windows, so
   * if what is already live is older than this file, tear it down and take
   * over. (parseFloat is fine while versions stay single-decimal.) */
  var liveVer = parseFloat(window.__RH_SCRIPT_VERSION__ || 0) || 0;
  var myVer = parseFloat(VERSION) || 0;
  if (window.__RH_EXT_INITIALIZED__ === true || window.__RH_LIVE_SOURCE__) {
    if (liveVer >= myVer) return;
    try {
      if (typeof window.__RH_EXT_TEARDOWN__ === "function")
        window.__RH_EXT_TEARDOWN__();
    } catch (e) {}
    try {
      delete window.__RH_LIVE_SOURCE__;
    } catch (e) {
      window.__RH_LIVE_SOURCE__ = null;
    }
  }
  window.__RH_SCRIPT_BOOT_OK__ = true; // handshake: we started

  function hostReady() {
    var h = location.hostname || "";
    return (
      /(^|\.)runninghub\.ai$/i.test(h) || h === "localhost" || h === "127.0.0.1"
    );
  }

  /* The URL is not always committed when WebView2 runs us. Never bail out
   * silently — retry until the host resolves (~20s), then stop. */
  var hostTries = 0;
  (function waitForHost() {
    if (hostReady()) {
      start();
      return;
    }
    if (++hostTries > 66) return;
    setTimeout(waitForHost, 300);
  })();

  function start() {
    try {
      main();
    } catch (err) {
      window.__RH_EXT_INITIALIZED__ = false;
      try {
        console.error("[RH] FATAL init error:", err);
      } catch (_) {}
      try {
        fatalToast(
          "RH script failed to start: " +
            (err && err.message ? err.message : err),
        );
      } catch (_) {}
    }
  }
  /* A failure must never be silent — there is no console in release builds. */
  function fatalToast(msg) {
    var d = document.body || document.documentElement;
    if (!d) return;
    var el = document.createElement("div");
    el.textContent = "⚠️ " + msg;
    el.style.cssText =
      "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);" +
      "z-index:2147483647;background:#3a1416;border:1px solid #a33;color:#ffb4b4;" +
      "padding:10px 16px;border-radius:8px;font:600 12px/1.4 monospace;max-width:80vw;";
    d.appendChild(el);
    setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 15000);
  }

  function main() {
    var TAG = "[RH Ext]";
    var cleanups = [];
    var destroyed = false;
    var DBG = false; // set from config below
    function log() {
      if (!DBG) return;
      try {
        console.info.apply(console, [TAG].concat([].slice.call(arguments)));
      } catch (_) {}
    }
    function warn() {
      if (!DBG) return;
      try {
        console.warn.apply(console, [TAG].concat([].slice.call(arguments)));
      } catch (_) {}
    }

    /* ---- roles: placement only, never "should I run" ---------------------- */
    function topDoc() {
      try {
        if (window.top && window.top.document && window.top.document.body)
          return window.top.document;
      } catch (_) {}
      return document;
    }
    function isTopDocument() {
      try {
        return document === window.top.document;
      } catch (_) {
        return false;
      }
    }
    var IS_TOP = isTopDocument();
    var IS_POPUP = !!(window.opener && window.opener !== window);
    var IS_COMFY_DOC = /comfyui\.html/i.test(location.pathname);
    var IS_WORKFLOW_PAGE =
      /\/workflow\/\d+/.test(location.pathname) || IS_COMFY_DOC;
    var IS_WORKFLOW_WINDOW = IS_WORKFLOW_PAGE || IS_POPUP;
    var SHOW_UI = IS_TOP; // gear/HUD/nav only in the top document
    var SHOULD_LOCK_TITLE = IS_TOP && !IS_WORKFLOW_WINDOW;
    var IS_BASE_WINDOW = IS_TOP && !IS_WORKFLOW_WINDOW;
    /* ======================= 1. utilities ======================= */
    function safeParse(key, fallback) {
      try {
        var raw = localStorage.getItem(key);
        if (raw == null) return fallback;
        var val = JSON.parse(raw);
        return val == null ? fallback : val;
      } catch (e) {
        try {
          localStorage.removeItem(key);
        } catch (_) {}
        return fallback;
      }
    }
    function lsGet(k) {
      try {
        return localStorage.getItem(k);
      } catch (_) {
        return null;
      }
    }
    function lsSet(k, v) {
      try {
        localStorage.setItem(k, v);
        return true;
      } catch (_) {
        return false;
      }
    }
    function esc(s) {
      return String(s).replace(/[&<>"']/g, function (c) {
        return {
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        }[c];
      });
    }
    function fmtDur(ms) {
      var s = Math.max(0, Math.floor(ms / 1000));
      if (s < 60) return s + "s";
      return Math.floor(s / 60) + "m " + String(s % 60).padStart(2, "0") + "s";
    }
    function nameFromUrl(u) {
      try {
        var q = new URL(u, location.href);
        var f = q.searchParams.get("filename");
        if (f) return f.split("/").pop();
        var p = q.pathname.split("/").pop();
        return p || "rh-" + Date.now();
      } catch (_) {
        return "rh-" + Date.now();
      }
    }
    function absUrl(u, win) {
      try {
        return new URL(
          u,
          win && win.location ? win.location.href : location.href,
        ).href;
      } catch (_) {
        return u;
      }
    }

    /* Toasts always render in the TOP document so they are never buried inside
     * the ComfyUI iframe. */
    function rhToast(msg, ms) {
      try {
        var d = topDoc();
        var host = d.getElementById("rh-toast-host");
        if (!host || !host.isConnected) {
          host = d.createElement("div");
          host.id = "rh-toast-host";
          host.style.cssText =
            "position:fixed;bottom:70px;left:50%;transform:translateX(-50%);" +
            "z-index:1000000;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none;";
          (d.body || d.documentElement).appendChild(host);
        }
        var el = d.createElement("div");
        el.textContent = msg;
        el.style.cssText =
          "background:rgba(18,18,22,0.96);border:1px solid rgba(0,255,102,0.5);" +
          "color:#00FF66;border-radius:8px;padding:8px 16px;font:600 13px/1.4 monospace;" +
          "box-shadow:0 4px 16px rgba(0,0,0,0.7);opacity:0;transition:opacity .18s ease;";
        host.appendChild(el);
        requestAnimationFrame(function () {
          el.style.opacity = "1";
        });
        setTimeout(function () {
          el.style.opacity = "0";
          setTimeout(function () {
            if (el.parentNode) el.parentNode.removeChild(el);
          }, 240);
        }, ms || 2600);
      } catch (e) {
        warn("toast failed", e);
      }
    }
    /* prefill (4th arg, optional): typed into the box as real text and
     * selected, so it can be kept as-is or retyped over in one keystroke. */
    function openPasteModal(title, placeholder, onSubmit, prefill) {
      try {
        var d = topDoc();
        if (d.getElementById("rh-modal-overlay")) return;
        var ov = d.createElement("div");
        ov.id = "rh-modal-overlay";
        ov.style.cssText =
          "position:fixed;inset:0;z-index:1000001;background:rgba(0,0,0,.55);" +
          "display:flex;align-items:center;justify-content:center;";
        ov.innerHTML =
          '<div style="width:440px;max-width:92vw;background:#16161a;border:1px solid #333;border-radius:8px;padding:14px;color:#ddd;font-family:monospace;box-shadow:0 12px 40px rgba(0,0,0,.8);">' +
          '<div style="font-weight:bold;margin-bottom:8px;font-size:13px;">' +
          esc(title) +
          "</div>" +
          '<textarea id="rh-modal-text" rows="8" placeholder="' +
          esc(placeholder) +
          '" ' +
          'style="width:100%;box-sizing:border-box;background:#0e0e12;border:1px solid #333;color:#00FF66;padding:6px;border-radius:4px;font-family:monospace;font-size:11px;resize:vertical;"></textarea>' +
          '<div style="display:flex;gap:8px;margin-top:10px;">' +
          '<button id="rh-modal-ok" style="flex:1;padding:6px;background:#00AA55;border:none;color:#fff;border-radius:4px;font-weight:bold;cursor:pointer;">Import</button>' +
          '<button id="rh-modal-cancel" style="flex:1;padding:6px;background:#2b2b36;border:1px solid #444;color:#ccc;border-radius:4px;cursor:pointer;">Cancel</button>' +
          "</div></div>";
        d.body.appendChild(ov);
        var close = function () {
          if (ov.parentNode) ov.parentNode.removeChild(ov);
        };
        ov.querySelector("#rh-modal-cancel").addEventListener("click", close);
        ov.querySelector("#rh-modal-ok").addEventListener("click", function () {
          var v = ov.querySelector("#rh-modal-text").value;
          close();
          if (v && v.trim()) onSubmit(v.trim());
        });
        var ta = ov.querySelector("#rh-modal-text");
        if (prefill) ta.value = prefill;
        ta.addEventListener("keydown", function (e) {
          if (e.key === "Escape") close();
        });
        ta.focus();
        if (ta.value) ta.select();
      } catch (e) {
        warn("modal failed", e);
      }
    }

    /* ======================= 2. config ======================= */
    var CONFIG_KEY = "RH_QOL_CONFIG";
    var CUSTOM_SCRIPTS_KEY = "RH_CUSTOM_SCRIPTS_LIST";
    var SCRIPT_OVERRIDE_KEY = "RH_MAIN_SCRIPT_OVERRIDE";
    var SCRIPT_CACHE_KEY = "RH_LAST_GOOD_SCRIPT";
    var BOOKMARK_KEY = "RH_BOOKMARKS";
    var LINKMODE_KEY = "RH_LINK_MODE";
    var EXT_PREV_KEY = "RH_EXT_PREV_DISABLED";
    var BUNDLE_KEY = "RH_COMFY_BUNDLE";
    var POS_KEY = "RH_FLOATING_POS";

    var DEFAULT_CONFIG = {
      blockTelemetry: true,
      quietConsole: true, // privacy: no identifiable console output
      fpsOptimization: true,
      vectorNodeIndicator: true,
      nodeProgressBar: true,
      enhancedWires: true,
      darkerGrid: true,
      breakpointSolid: true, // solid heavy outline vs thick dashed
      autoCenterRunningNode: false,
      autoCancelBreakpoints: true,
      closeGuard: true,
      popupTitleStatus: true,
      expandTaskPanel: true,
      prefetchWorkflow: true,
      reuseWorkflowWindow: false,
      trimExtensions: false, // one switch, conservative list, reversible
      sameWindowWorkflows: false,
    };
    var CANVAS_BG = "#101012";
    var WIRE_WIDTH = 4;
    var config = Object.assign({}, DEFAULT_CONFIG, safeParse(CONFIG_KEY, {}));
    DBG = !config.quietConsole;
    function saveConfig() {
      lsSet(CONFIG_KEY, JSON.stringify(config));
    }

    var customScripts = [];
    try {
      var rawScripts = safeParse(CUSTOM_SCRIPTS_KEY, []);
      if (Array.isArray(rawScripts)) {
        customScripts = rawScripts.filter(function (s) {
          return (
            s &&
            s.code &&
            s.code.indexOf("RH_QOL_CONFIG") === -1 &&
            s.code.indexOf("createFloatingMenu") === -1
          );
        });
        if (rawScripts.length !== customScripts.length)
          lsSet(CUSTOM_SCRIPTS_KEY, JSON.stringify(customScripts));
      }
    } catch (e) {
      customScripts = [];
    }
    function saveCustomScripts() {
      lsSet(CUSTOM_SCRIPTS_KEY, JSON.stringify(customScripts));
    }
    customScripts.forEach(function (s) {
      if (s.enabled && s.code && s.code.trim()) {
        try {
          new Function(s.code)();
        } catch (e) {
          rhToast('⚠️ UserScript "' + s.name + '" failed');
        }
      }
    });

    /* ======================= 3. cookie JSON login ======================= */
    window.importCookiesFromJSON = function (jsonInput) {
      try {
        var cookies =
          typeof jsonInput === "string" ? JSON.parse(jsonInput) : jsonInput;
        if (!Array.isArray(cookies)) {
          rhToast("❌ Expected a JSON array of cookies");
          return false;
        }
        cookies.forEach(function (c) {
          if (!c.name || c.value === undefined) return;
          var str =
            encodeURIComponent(String(c.name).trim()) +
            "=" +
            encodeURIComponent(String(c.value).trim()) +
            "; path=/; max-age=31536000; SameSite=Lax";
          if (location.hostname.indexOf("runninghub") !== -1)
            str += "; domain=.runninghub.ai";
          document.cookie = str;
          var k = String(c.name).toLowerCase();
          if (
            k.indexOf("token") !== -1 ||
            k.indexOf("auth") !== -1 ||
            k.indexOf("session") !== -1
          ) {
            try {
              localStorage.setItem(c.name, c.value);
              sessionStorage.setItem(c.name, c.value);
            } catch (_) {}
          }
        });
        rhToast("✅ Imported " + cookies.length + " cookie(s) — reloading…");
        setTimeout(function () {
          location.href = "https://www.runninghub.ai/";
        }, 600);
        return true;
      } catch (err) {
        rhToast("❌ Cookie JSON parse failed: " + err.message);
        return false;
      }
    };
    function pasteAndImportCookies() {
      var go = function (text) {
        if (text && text.trim().charAt(0) === "[")
          window.importCookiesFromJSON(text);
        else
          openPasteModal(
            "Paste Cookie JSON",
            '[{"name":"...","value":"..."}]',
            window.importCookiesFromJSON,
          );
      };
      try {
        if (navigator.clipboard && navigator.clipboard.readText) {
          navigator.clipboard
            .readText()
            .then(go)
            .catch(function () {
              go("");
            });
          return;
        }
      } catch (_) {}
      go("");
    }
    /* ======================= 4. hotkeys, title, window.open ============== */
    function onKey(e) {
      var t = e.target;
      if (
        t &&
        (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
      )
        return;
      if (!e.ctrlKey || !e.shiftKey) return;
      if (e.code === "KeyE") {
        e.preventDefault();
        try {
          openScriptEditor();
        } catch (err) {
          warn(err);
        }
      } else if (e.code === "KeyV") {
        e.preventDefault();
        pasteAndImportCookies();
      }
    }
    window.addEventListener("keydown", onKey);
    cleanups.push(function () {
      window.removeEventListener("keydown", onKey);
    });

    if (SHOULD_LOCK_TITLE) {
      try {
        document.title = "RunningHub";
        Object.defineProperty(document, "title", {
          configurable: true,
          get: function () {
            return "RunningHub";
          },
          set: function () {},
        });
      } catch (e) {
        warn("title lock failed", e);
      }
    }

    function isWorkflowUrl(url) {
      if (typeof url !== "string" || !url) return false;
      try {
        var u = new URL(url, location.href);
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
      var orig = w.open.bind(w);
      try {
        w.open = function (url, target, features) {
          try {
            if (isWorkflowUrl(url)) {
              if (config.sameWindowWorkflows) {
                location.href = absUrl(url, w);
                return null;
              }
              // Reusing one named window keeps ComfyUI's bundle warm in that
              // webview, which is the biggest available load-time win.
              var name = config.reuseWorkflowWindow ? "rhWorkflow" : target;
              return orig(
                url,
                name,
                "width=1400,height=900,resizable=yes,scrollbars=yes",
              );
            }
          } catch (e) {
            warn("open patch", e);
          }
          return orig(url, target, features);
        };
      } catch (e) {
        warn("cannot patch window.open", e);
      }
    }
    patchWindowOpen(window);

    /* ======================= 5. third-party telemetry only ============== */
    if (config.blockTelemetry) {
      var blocked = [
        "google-analytics.com",
        "googletagmanager.com",
        "hm.baidu.com",
        "clarity.ms",
        "sentry.io",
        "analytics.google.com",
      ];
      var origFetch = window.fetch.bind(window);
      window.fetch = function (input, init) {
        try {
          var u =
            typeof input === "string" ? input : (input && input.url) || "";
          // Never block first-party runninghub.ai traffic — gaps there would be
          // anomalous; third-party gaps look like any ad-blocker.
          if (
            u &&
            u.indexOf("runninghub.ai") === -1 &&
            blocked.some(function (h) {
              return u.indexOf(h) !== -1;
            })
          ) {
            return Promise.resolve(
              new Response(null, { status: 204, statusText: "No Content" }),
            );
          }
        } catch (e) {}
        return origFetch(input, init);
      };
    }
    /* ======================= 6. breakpoints + cancel ===================== */
    var stopNodeIds = new Set();
    function isStopId(id) {
      return stopNodeIds.has(String(id));
    }
    function toggleStopId(id) {
      var k = String(id);
      if (stopNodeIds.has(k)) {
        stopNodeIds.delete(k);
        return false;
      }
      stopNodeIds.add(k);
      return true;
    }
    function isVisible(el) {
      try {
        if (!el || el.disabled) return false;
        var r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        var w = el.ownerDocument.defaultView;
        var cs = w.getComputedStyle(el);
        return cs.display !== "none" && cs.visibility !== "hidden";
      } catch (_) {
        return false;
      }
    }

    function expandTaskPanel() {
      try {
        var d = topDoc();
        var wrap = d.querySelector("[class*='workflow-result-wrap']");
        if (!wrap || !/(^|\s)hide(\s|$)/.test(wrap.className || ""))
          return false;
        var btn =
          wrap.querySelector(".hide-btn") || d.querySelector(".hide-btn");
        if (btn) {
          btn.click();
          return true;
        }
        wrap.classList.remove("hide");
        return true;
      } catch (_) {
        return false;
      }
    }

    /* Verified: the cancel control is a DIV in the TOP document and measures
     * 0x0 while the panel is collapsed — so the selector path must NOT be
     * size-gated. Rect checks apply only to the loose text scan. */
    function findCancelButton() {
      var docs = [topDoc()];
      if (document !== docs[0]) docs.push(document);
      if (
        engineTarget &&
        engineTarget.doc &&
        docs.indexOf(engineTarget.doc) === -1
      )
        docs.push(engineTarget.doc);
      for (var i = 0; i < docs.length; i++) {
        var d = docs[i];
        var btn =
          d.querySelector(".rh-task-item .rh-cancel-btn") ||
          d.querySelector(".rh-task-item .history-top-info .rh-cancel-btn") ||
          d.querySelector("[class*='workflow-result-wrap'] .rh-cancel-btn") ||
          d.querySelector(".rh-cancel-btn");
        if (btn) return { el: btn, how: "selector" };
      }
      var best = null,
        bestArea = Infinity;
      for (var j = 0; j < docs.length; j++) {
        var all;
        try {
          all = docs[j].querySelectorAll(
            "button, div, span, a, [role='button']",
          );
        } catch (_) {
          continue;
        }
        for (var k = 0; k < all.length; k++) {
          var el = all[k],
            txt = (el.textContent || "").trim();
          if (
            !txt ||
            txt.length > 12 ||
            !/^(cancel|取消)$/i.test(txt) ||
            !isVisible(el)
          )
            continue;
          var r = el.getBoundingClientRect(),
            a = r.width * r.height;
          if (a < bestArea) {
            best = el;
            bestArea = a;
          }
        }
      }
      return best ? { el: best, how: "text" } : null;
    }
    function cancelDiagnostics() {
      var d = topDoc();
      var wrap = d.querySelector("[class*='workflow-result-wrap']");
      var idEl = d.querySelector(".rh-task-id");
      var st = d.querySelector(".rh-task-item [class*='task-status-']");
      return [
        "panel:" +
          (wrap
            ? /(^|\s)hide(\s|$)/.test(wrap.className || "")
              ? "collapsed"
              : "open"
            : "MISSING"),
        "task-item:" + (d.querySelector(".rh-task-item") ? "yes" : "NO"),
        "cancel-btn:" + (d.querySelector(".rh-cancel-btn") ? "yes" : "NO"),
        "status:" + ((st && st.textContent) || "-").trim().slice(0, 18),
        "taskid:" +
          ((idEl && idEl.textContent) || "-")
            .replace(/[^0-9]/g, "")
            .slice(0, 20),
        "engine:" +
          (engineTarget ? (engineTarget.host ? "iframe" : "self") : "none"),
      ].join(" ");
    }

    function triggerRHInterrupt(t) {
      var iWin = t && t.win ? t.win : window;
      rhToast("🛑 Breakpoint hit — sending cancel…");
      var attempts = 0,
        announced = false,
        confirmed = false,
        MAX = 8;
      if (config.expandTaskPanel) expandTaskPanel();

      var successRX = /cancel|取消|success|成功/i;
      var watch = setInterval(function () {
        if (confirmed) {
          clearInterval(watch);
          return;
        }
        try {
          var d = topDoc();
          var root =
            d.querySelector("#rh-message-root") ||
            d.querySelector(".ant-message") ||
            d.querySelector(".ant-notification");
          if (root && successRX.test(root.textContent || "")) {
            confirmed = true;
            clearInterval(watch);
            rhToast("✅ Task cancelled — confirmed by RunningHub");
          }
        } catch (_) {}
      }, 200);
      setTimeout(function () {
        clearInterval(watch);
      }, 12000);

      (function tick() {
        if (confirmed) return;
        attempts++;
        var hit = findCancelButton();
        // Secondary nudge; harmless if the backend ignores it.
        try {
          if (iWin.api && typeof iWin.api.interrupt === "function")
            iWin.api.interrupt();
        } catch (e) {}
        if (hit) {
          try {
            hit.el.click();
            if (!announced) {
              announced = true;
              rhToast("🛑 Cancel clicked (" + hit.how + ")");
            }
          } catch (e) {
            warn("cancel click", e);
          }
        }
        if (attempts < MAX) setTimeout(tick, 800);
        else if (!confirmed) {
          rhToast("⚠️ Cancel not confirmed → " + cancelDiagnostics(), 9000);
          clearInterval(watch);
        }
      })();
    }
    /* ======================= 7. engine frame resolution ================== */
    var engineTarget = null;

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
      }
    }
    function engineTargetAlive() {
      if (!engineTarget) return false;
      if (engineTarget.host && !engineTarget.host.isConnected) return false;
      return frameHasLiveCanvas(engineTarget.win);
    }
    // Depth-limited search so a wrapper frame can never strand the engine.
    function scanFrames(doc, host, depth) {
      if (!doc || depth > 3) return null;
      var frames;
      try {
        frames = doc.querySelectorAll("iframe, frame");
      } catch (_) {
        return null;
      }
      for (var i = 0; i < frames.length; i++) {
        var f = frames[i],
          w = null,
          d = null;
        try {
          w = f.contentWindow;
          d = f.contentDocument || (w && w.document);
        } catch (_) {
          continue;
        }
        if (frameHasLiveCanvas(w)) return { win: w, doc: d, host: f };
        var deeper = d ? scanFrames(d, f, depth + 1) : null;
        if (deeper) return deeper;
      }
      return null;
    }
    function resolveEngineTarget() {
      if (engineTargetAlive()) return engineTarget;
      engineTarget = null;
      if (frameHasLiveCanvas(window)) {
        // we ARE the ComfyUI document
        engineTarget = { win: window, doc: document, host: null };
        return engineTarget;
      }
      engineTarget = scanFrames(document, null, 0);
      return engineTarget;
    }

    function getLgc(t) {
      if (!t) return null;
      var w = t.win,
        cv = null;
      try {
        cv = w.app && w.app.canvas;
      } catch (_) {}
      if (!cv) {
        try {
          cv = w.LGraphCanvas && w.LGraphCanvas.active_canvas;
        } catch (_) {}
      }
      if (!cv) {
        try {
          var g = (w.app && w.app.graph) || w.graph;
          if (g && g.list_of_graphcanvas && g.list_of_graphcanvas.length)
            cv = g.list_of_graphcanvas[0];
        } catch (_) {}
      }
      try {
        if (cv && cv.ds && cv.canvas) return cv;
      } catch (_) {}
      return null;
    }
    function getGraph(t) {
      var cv = getLgc(t);
      try {
        if (cv && cv.graph) return cv.graph;
      } catch (_) {}
      try {
        return (t.win.app && t.win.app.graph) || t.win.graph || null;
      } catch (_) {
        return null;
      }
    }
    function getApp(t) {
      try {
        return (
          (t &&
            t.win &&
            (t.win.app ||
              (t.win.comfyAPI &&
                t.win.comfyAPI.app &&
                t.win.comfyAPI.app.app))) ||
          null
        );
      } catch (_) {
        return null;
      }
    }
    /* ======================= 8. canvas look & link styles ================ */
    var LINK_MODES = [
      { v: 2, name: "Spline" },
      { v: 1, name: "Linear" },
      { v: 0, name: "Straight" },
      { v: 3, name: "Hidden" },
    ];
    function currentLinkMode() {
      var v = parseInt(lsGet(LINKMODE_KEY), 10);
      return v === 0 || v === 1 || v === 2 || v === 3 ? v : 2;
    }
    function linkModeName(v) {
      for (var i = 0; i < LINK_MODES.length; i++)
        if (LINK_MODES[i].v === v) return LINK_MODES[i].name;
      return "Spline";
    }
    function applyLinkMode(v) {
      lsSet(LINKMODE_KEY, String(v));
      var t = engineTarget,
        cv = getLgc(t),
        app = getApp(t);
      // Prefer the frontend's own setting so RH's UI stays in sync.
      try {
        if (app && app.ui && app.ui.settings && app.ui.settings.setSettingValue)
          app.ui.settings.setSettingValue("Comfy.LinkRenderMode", v);
      } catch (_) {}
      try {
        if (
          app &&
          app.extensionManager &&
          app.extensionManager.setting &&
          app.extensionManager.setting.set
        )
          app.extensionManager.setting.set("Comfy.LinkRenderMode", v);
      } catch (_) {}
      try {
        if (cv) {
          if (cv.links_render_mode !== undefined) cv.links_render_mode = v;
          if (cv.link_render_mode !== undefined) cv.link_render_mode = v;
          redraw(cv);
        }
      } catch (_) {}
      rhToast("🔗 Link style: " + linkModeName(v));
    }
    function cycleLinkMode() {
      var cur = currentLinkMode(),
        idx = 0;
      for (var i = 0; i < LINK_MODES.length; i++)
        if (LINK_MODES[i].v === cur) idx = i;
      applyLinkMode(LINK_MODES[(idx + 1) % LINK_MODES.length].v);
    }

    function redraw(cv) {
      try {
        cv.setDirty(true, true);
      } catch (_) {}
    }

    function enforceInstanceSettings(cv) {
      try {
        if (
          config.darkerGrid &&
          typeof cv.clear_background_color === "string" &&
          cv.clear_background_color !== CANVAS_BG
        ) {
          cv.clear_background_color = CANVAS_BG;
          if (cv.clear_background === false) cv.clear_background = true;
          redraw(cv);
        }
        if (config.enhancedWires) {
          var want = currentLinkMode();
          if (
            cv.links_render_mode !== undefined &&
            cv.links_render_mode !== want
          )
            cv.links_render_mode = want;
          if (cv.link_render_mode !== undefined && cv.link_render_mode !== want)
            cv.link_render_mode = want;
          if (
            cv.connections_width !== undefined &&
            cv.connections_width < WIRE_WIDTH
          ) {
            cv.connections_width = WIRE_WIDTH;
            redraw(cv);
          }
          if (cv.link_width !== undefined && cv.link_width < 2)
            cv.link_width = 2;
        }
        if (config.fpsOptimization) {
          if (cv.render_shadows) cv.render_shadows = false;
          if (!config.enhancedWires && cv.render_connections_border)
            cv.render_connections_border = false;
        }
      } catch (_) {}
    }
    function injectCanvasCSS(t) {
      if (!config.darkerGrid) return;
      try {
        var d = t.doc;
        if (d.getElementById("rh-canvas-perf-style")) return;
        var st = d.createElement("style");
        st.id = "rh-canvas-perf-style";
        st.textContent =
          "body,html{background-color:" +
          CANVAS_BG +
          " !important;}" +
          "canvas#graph-canvas,canvas.lgraphcanvas,.graph-canvas-container canvas{" +
          "background-color:" +
          CANVAS_BG +
          " !important;}" +
          "canvas#graph-canvas{touch-action:none !important;}";
        (d.head || d.documentElement).appendChild(st);
      } catch (e) {
        warn("canvas css", e);
      }
    }

    /* Remember ComfyUI's hashed main bundle so the base window can prefetch it. */
    function rememberBundle(t) {
      try {
        var s = t.doc.querySelector(
          'script[src*="index-"],script[type="module"][src]',
        );
        if (s && s.src) lsSet(BUNDLE_KEY, absUrl(s.src, t.win));
      } catch (_) {}
    }

    /* ======================= 9. engine attach ============================
     * Prototype hooks ONLY for the node context menu. Never drawNode/draw. */
    function attachEngine(t) {
      var win = t.win,
        P = null;
      try {
        P = win.LGraphCanvas && win.LGraphCanvas.prototype;
      } catch (_) {}
      if (!P) return;
      try {
        if (win.__RH_ENGINE_OWNER__ && win.__RH_ENGINE_OWNER__ !== window)
          return;
        win.__RH_ENGINE_OWNER__ = window;
      } catch (_) {}

      if (!P.__rh_menu_attached) {
        P.__rh_menu_attached = true;
        var origMenu = P.getNodeMenuOptions;
        P.getNodeMenuOptions = function (node) {
          var options = origMenu ? origMenu.apply(this, arguments) : [];
          try {
            if (!Array.isArray(options)) return options;
            var already = options.some(function (o) {
              return (
                o &&
                o.content &&
                (String(o.content).indexOf("Auto-Cancel") !== -1 ||
                  String(o.content).indexOf("Stop Breakpoint") !== -1 ||
                  String(o.content).indexOf("Save output") !== -1)
              );
            });
            if (already) return options;
            var self = this;
            var head = [];
            head.push({
              content: isStopId(node && node.id)
                ? "🛑 Remove Stop Breakpoint"
                : "🛑 Set Auto-Cancel Breakpoint",
              callback: function () {
                var on = toggleStopId(node.id);
                rhToast(
                  on
                    ? "🛑 Breakpoint SET on node " + node.id
                    : "Breakpoint removed from node " + node.id,
                );
                redraw(self);
              },
            });
            if (outputsOf(node, win).length) {
              head.push({
                content: "💾 Save output",
                callback: function () {
                  saveOutputs(outputsOf(node, win));
                },
              });
            }
            head.push(null); // separator
            options.unshift.apply(options, head); // top of the menu
          } catch (e) {
            warn("menu override", e);
          }
          return options;
        };
        if (!win.__rh_engine_toast__) {
          win.__rh_engine_toast__ = true;
          rhToast("✅ RH engine attached" + (t.host ? " (iframe)" : ""));
        }
      }
      /* api events: identity-checked so an api swap re-hooks. RH does NOT
       * forward execution_success, so the authoritative end-of-run signal is
       * "executing" with a null node. status + DOM act as backstops. */
      var api = null;
      try {
        api = win.api;
      } catch (_) {}
      if (api && win.__rh_hooked_api !== api) {
        win.__rh_hooked_api = api;
        var endRun = function (label) {
          if (!win.__rh_run_active) return;
          win.__rh_run_active = false;
          win.__rh_running = null;
          win.__rh_prog = null;
          win.__rh_run_end = Date.now();
          win.__rh_last_done_str = win.__rh_run_start
            ? label + " in " + fmtDur(Date.now() - win.__rh_run_start)
            : label;
          log("run ended:", label);
        };
        win.__rh_endRun = endRun;
        try {
          api.addEventListener("executing", function (e) {
            try {
              var d = e && e.detail;
              var raw =
                d && typeof d === "object"
                  ? d.node != null
                    ? d.node
                    : d.display_node != null
                      ? d.display_node
                      : null
                  : d;
              if (raw == null) {
                win.__rh_running = null;
                endRun("✅ Done");
                return;
              }
              if (!win.__rh_run_active) {
                // recover a run already going
                win.__rh_run_active = true;
                win.__rh_run_start = win.__rh_run_start || Date.now();
              }
              win.__rh_running = { num: Number(raw), str: String(raw) };
              win.__rh_prog = null;
              if (config.autoCenterRunningNode) {
                try {
                  var cv = getLgc(t),
                    g = getGraph(t);
                  if (cv && g && typeof cv.centerOnNode === "function") {
                    var n = g.getNodeById(Number(raw)) || g.getNodeById(raw);
                    if (n) cv.centerOnNode(n);
                  }
                } catch (_) {}
              }
              if (config.autoCancelBreakpoints && isStopId(raw))
                triggerRHInterrupt({ win: win, doc: t.doc });
            } catch (err) {
              warn("executing handler", err);
            }
          });
          api.addEventListener("execution_start", function () {
            win.__rh_run_start = Date.now();
            win.__rh_run_active = true;
            win.__rh_running = null;
            win.__rh_prog = null;
            win.__rh_last_done_str = "";
            win.__rh_title_base = null;
          });
          api.addEventListener("progress", function (e) {
            try {
              var d = e && e.detail;
              if (!d) return;
              win.__rh_prog = {
                v: Number(d.value) || 0,
                max: Number(d.max) || 0,
              };
            } catch (_) {}
          });
          api.addEventListener("status", function (e) {
            try {
              var d = e && e.detail;
              var q = d && d.exec_info && d.exec_info.queue_remaining;
              if (q === 0) endRun("✅ Done");
            } catch (_) {}
          });
          api.addEventListener("execution_error", function () {
            endRun("❌ Error");
          });
          api.addEventListener("execution_interrupted", function () {
            endRun("⏸ Cancelled");
          });
          api.addEventListener("execution_success", function () {
            endRun("✅ Done");
          });
        } catch (e) {
          warn("api hook failed", e);
        }
      }
    }
    /* ======================= 10. overlay canvas ==========================
     * Our own canvas inside the ENGINE document. Idle frames touch nothing at
     * all, so this costs zero while you are not running anything. */
    var ov = { cv: null, ctx: null, w: 0, h: 0, dpr: 1, dirty: false };

    function ensureOverlay(t) {
      try {
        var d = t.doc;
        var cv = d.getElementById("rh-graph-overlay");
        if (!cv || !cv.isConnected) {
          cv = d.createElement("canvas");
          cv.id = "rh-graph-overlay";
          cv.style.cssText =
            "position:fixed;left:0;top:0;width:100vw;height:100vh;" +
            "pointer-events:none;z-index:999997;";
          (d.body || d.documentElement).appendChild(cv);
          ov.ctx = null;
        }
        ov.cv = cv;
        if (!ov.ctx) ov.ctx = cv.getContext("2d");
      } catch (e) {
        ov.cv = null;
        ov.ctx = null;
      }
    }
    function syncOverlaySize() {
      var dv = ov.cv.ownerDocument.defaultView;
      var w = dv.innerWidth,
        h = dv.innerHeight;
      var dpr = Math.max(1, dv.devicePixelRatio || 1);
      if (ov.w !== w || ov.h !== h || ov.dpr !== dpr) {
        ov.w = w;
        ov.h = h;
        ov.dpr = dpr;
        ov.cv.width = Math.round(w * dpr);
        ov.cv.height = Math.round(h * dpr);
      }
    }

    /* The canvas backing store can disagree with its CSS box (observed live),
     * in which case the browser stretches the bitmap and raw canvas coords are
     * wrong. Measured from the DOM only; the LiteGraph context is never read. */
    function viewportFactor(lgc, win) {
      try {
        var el = lgc.canvas,
          base = el.getBoundingClientRect();
        if (!el.width || !base.width) return 1;
        var dpr = Math.max(1, (win && win.devicePixelRatio) || 1);
        if (Math.abs(el.width - base.width * dpr) <= 2) return 1;
        var f = base.width / el.width;
        return f > 0.2 && f < 5 ? f : 1;
      } catch (_) {
        return 1;
      }
    }

    function nodeScreenRect(lgc, node) {
      try {
        var el = lgc.canvas;
        if (!el || !lgc.ds || !node || !node.pos || !node.size) return null;
        var base = el.getBoundingClientRect();
        if (base.width <= 0 || base.height <= 0) return null;
        var s = lgc.ds.scale || 1;
        var win = el.ownerDocument && el.ownerDocument.defaultView;
        var f = viewportFactor(lgc, win);
        var cx,
          cy,
          conv = null;
        if (typeof lgc.convertOffsetToCanvas === "function")
          conv = lgc.convertOffsetToCanvas.bind(lgc);
        else if (lgc.ds && typeof lgc.ds.convertOffsetToCanvas === "function")
          conv = lgc.ds.convertOffsetToCanvas.bind(lgc.ds);
        if (conv) {
          var p = conv([node.pos[0], node.pos[1]]);
          cx = p[0];
          cy = p[1];
        } else {
          var off = lgc.ds.offset || [0, 0];
          var oxx = Array.isArray(off) ? off[0] : off.x || 0;
          var oyy = Array.isArray(off) ? off[1] : off.y || 0;
          cx = (node.pos[0] + oxx) * s;
          cy = (node.pos[1] + oyy) * s;
        }
        var titleH = 30;
        try {
          var LG =
            engineTarget && engineTarget.win && engineTarget.win.LiteGraph;
          if (LG && LG.NODE_TITLE_HEIGHT) titleH = LG.NODE_TITLE_HEIGHT;
        } catch (_) {}
        var collapsed = !!(node.flags && node.flags.collapsed);
        var gw = collapsed ? node._collapsed_width || 80 : node.size[0];
        var gh = collapsed ? 0 : node.size[1];
        return {
          x: base.left + cx * f,
          y: base.top + (cy - titleH * s) * f,
          w: gw * s * f,
          h: (gh + titleH) * s * f,
        };
      } catch (_) {
        return null;
      }
    }
    function onScreen(r) {
      return !!(
        r &&
        r.x < ov.w &&
        r.y < ov.h &&
        r.x + r.w > 0 &&
        r.y + r.h > 0
      );
    }
    function drawBreakpointBox(ctx, r) {
      var solid = !!config.breakpointSolid;
      var pad = solid ? 4 : 3;
      var x = r.x - pad,
        y = r.y - pad,
        w = r.w + pad * 2,
        h = r.h + pad * 2;
      ctx.save();
      ctx.strokeStyle = "#FF3344";
      if (solid) {
        ctx.lineWidth = 5;
        ctx.setLineDash([]);
      } else {
        ctx.lineWidth = 3.5;
        ctx.setLineDash([9, 5]);
      }
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);
      ctx.font = "bold 12px monospace";
      ctx.fillStyle = "#FF3344";
      ctx.textBaseline = "bottom";
      ctx.fillText("🛑 AUTO-CANCEL STOP", x, y - 5);
      ctx.restore();
    }
    function drawRunning(ctx, r, phase, prog) {
      var pad = 6;
      var x = r.x - pad,
        y = r.y - pad,
        w = r.w + pad * 2,
        h = r.h + pad * 2;
      var len = Math.max(10, Math.min(20, Math.min(w, h) * 0.28));
      var pulse = 0.55 + 0.45 * Math.sin(phase / 260); // free: one sine per frame
      ctx.save();
      ctx.lineWidth = 6;
      ctx.strokeStyle =
        "rgba(0,255,102," + (0.1 + 0.14 * pulse).toFixed(3) + ")";
      ctx.strokeRect(x - 3, y - 3, w + 6, h + 6);
      ctx.lineWidth = 3.5;
      ctx.strokeStyle =
        "rgba(0,255,102," + (0.55 + 0.45 * pulse).toFixed(3) + ")";
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
      if (config.nodeProgressBar && prog && prog.max > 0) {
        var pct = Math.max(0, Math.min(1, prog.v / prog.max));
        var by = y + h + 5,
          bh = 4;
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        ctx.fillRect(x, by, w, bh);
        ctx.fillStyle = "#00FF66";
        ctx.fillRect(x, by, w * pct, bh);
        ctx.font = "bold 10px monospace";
        ctx.fillStyle = "#8affc0";
        ctx.textBaseline = "top";
        ctx.fillText(Math.round(pct * 100) + "%", x + w + 6, by - 3);
      }
      ctx.restore();
    }

    function overlayLoop() {
      if (destroyed) return;
      requestAnimationFrame(overlayLoop);
      try {
        var t = engineTarget;
        if (!t || !ov.cv || !ov.ctx || ov.cv.ownerDocument !== t.doc) return;
        // Both frames run in v2.6, so only the copy that owns the engine draws —
        // otherwise two rAF loops would clear each other's frame.
        try {
          if (t.win.__RH_ENGINE_OWNER__ && t.win.__RH_ENGINE_OWNER__ !== window)
            return;
        } catch (_) {
          return;
        }
        var win = t.win;
        var showBp = config.autoCancelBreakpoints && stopNodeIds.size > 0;
        var running = config.vectorNodeIndicator && win.__rh_running;
        if (!showBp && !running) {
          if (ov.dirty) {
            // one final clear, then go idle
            ov.ctx.setTransform(ov.dpr, 0, 0, ov.dpr, 0, 0);
            ov.ctx.clearRect(0, 0, ov.w, ov.h);
            ov.dirty = false;
          }
          return; // idle frames do nothing at all
        }
        var lgc = getLgc(t),
          graph = lgc && lgc.graph;
        if (!lgc || !graph || !lgc.canvas || !lgc.ds) return;
        syncOverlaySize();
        var ctx = ov.ctx;
        ctx.setTransform(ov.dpr, 0, 0, ov.dpr, 0, 0);
        ctx.clearRect(0, 0, ov.w, ov.h);
        ov.dirty = true;
        if (showBp) {
          stopNodeIds.forEach(function (id) {
            var n = graph.getNodeById(Number(id));
            if (!n) return;
            var r = nodeScreenRect(lgc, n);
            if (onScreen(r)) drawBreakpointBox(ctx, r);
          });
        }
        if (running) {
          var rn = graph.getNodeById(win.__rh_running.num);
          if (rn) {
            var rr = nodeScreenRect(lgc, rn);
            if (onScreen(rr))
              drawRunning(ctx, rr, performance.now(), win.__rh_prog);
          }
        }
      } catch (_) {
        /* overlay errors must never reach the page */
      }
    }
    requestAnimationFrame(overlayLoop);
    /* ======================= 11. title status + close guard ============== */
    function engineWin() {
      return engineTarget ? engineTarget.win : window;
    }

    function titleTick() {
      try {
        if (!IS_TOP || !IS_WORKFLOW_WINDOW || !config.popupTitleStatus) return;
        var w = engineWin();
        var base = w.__rh_title_base;
        if (!base) {
          base =
            (document.title || "RunningHub")
              .replace(/\s*[·▶✅❌⏸][\s\S]*$/, "")
              .trim() || "RunningHub";
          w.__rh_title_base = base;
        }
        if (w.__rh_run_active && w.__rh_run_start) {
          document.title =
            base +
            " · ▶ " +
            fmtDur(Date.now() - w.__rh_run_start) +
            " · Running";
        } else if (
          w.__rh_last_done_str &&
          w.__rh_run_end &&
          Date.now() - w.__rh_run_end < 20000
        ) {
          document.title = base + " · " + w.__rh_last_done_str;
        } else if (document.title !== base) {
          document.title = base;
        }
      } catch (_) {}
    }
    var titleTimer = setInterval(titleTick, 1000);
    cleanups.push(function () {
      clearInterval(titleTimer);
    });

    window.addEventListener("beforeunload", function (e) {
      try {
        if (destroyed || !config.closeGuard || !IS_TOP || !IS_WORKFLOW_WINDOW)
          return;
        var w = engineWin();
        if (w && (w.__rh_run_active || w.__rh_running)) {
          e.preventDefault();
          e.returnValue = "";
        }
      } catch (_) {}
    });

    /* ======================= 12. run HUD ================================
     * Driven by our own run state, with a DOM backstop: if RH's live task row
     * disappears for three consecutive ticks the run is over, even when no api
     * end-event ever arrives. */
    var noTaskRowTicks = 0;
    function ensureHUD() {
      if (!SHOW_UI) return;
      if (document.getElementById("rh-timer-hud")) return;
      if (!document.body) return;
      var hud = document.createElement("div");
      hud.id = "rh-timer-hud";
      hud.innerHTML =
        '<span style="font-size:14px;">⏱️</span><span id="rh-hud-time">0s</span>';
      hud.style.cssText =
        "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);" +
        "z-index:999998;background:rgba(18,18,22,0.9);border:1px solid rgba(0,255,102,0.5);" +
        "border-radius:20px;padding:6px 18px;display:none;align-items:center;gap:8px;" +
        "font-family:monospace;font-size:15px;font-weight:700;color:#00FF66;" +
        "box-shadow:0 4px 16px rgba(0,0,0,0.7);pointer-events:none;user-select:none;";
      document.body.appendChild(hud);
    }
    function updateHUD() {
      var hud = document.getElementById("rh-timer-hud");
      if (!hud) return;
      try {
        var w = engineWin();
        var disp = hud.querySelector("#rh-hud-time");
        var d = topDoc();
        if (w && w.__rh_run_active) {
          var row = d.querySelector(".rh-task-item");
          if (!row) {
            if (++noTaskRowTicks >= 3 && typeof w.__rh_endRun === "function")
              w.__rh_endRun("✅ Done");
          } else noTaskRowTicks = 0;
        } else noTaskRowTicks = 0;

        if (w && w.__rh_run_active) {
          var own = w.__rh_run_start
            ? fmtDur(Date.now() - w.__rh_run_start)
            : "…";
          var label = own;
          var st =
            d.querySelector(".rh-task-item [class*='task-status-']") ||
            d.querySelector(".rh-task-item .rh-task-status");
          if (st) {
            var txt = (st.innerText || "").trim().replace(/\s+/g, " ");
            if (txt && txt.length <= 28) label = own + "  ·  " + txt;
          }
          if (disp && disp.textContent !== label) disp.textContent = label;
          if (hud.style.display !== "flex") hud.style.display = "flex";
          return;
        }
        if (
          w &&
          w.__rh_last_done_str &&
          w.__rh_run_end &&
          Date.now() - w.__rh_run_end < 8000
        ) {
          if (disp && disp.textContent !== w.__rh_last_done_str)
            disp.textContent = w.__rh_last_done_str;
          if (hud.style.display !== "flex") hud.style.display = "flex";
          return;
        }
        if (hud.style.display !== "none") hud.style.display = "none"; // never sticks
      } catch (_) {}
    }
    /* ======================= 13. downloads ===============================
     * ComfyUI draws outputs on the canvas, so there is no <img> for Pake's
     * context menu to catch, and Pake treats bare image URLs as "previewable"
     * rather than downloadable. So we resolve the real URL ourselves and try
     * three channels in order, reporting what happened at each step. */
    function outputsOf(node, win) {
      var list = [];
      try {
        var app = win.app;
        var no = app && app.nodeOutputs && node && app.nodeOutputs[node.id];
        if (no) {
          ["images", "videos", "gifs", "audio", "files"].forEach(function (k) {
            var arr = no[k];
            if (!arr || !arr.length) return;
            for (var i = 0; i < arr.length; i++) {
              var it = arr[i];
              if (!it) continue;
              if (typeof it === "string") list.push({ url: it });
              else if (it.filename) list.push({ q: it });
              else if (it.url) list.push({ url: it.url });
            }
          });
        }
      } catch (_) {}
      try {
        if (!list.length && node && node.imgs && node.imgs.length) {
          for (var j = 0; j < node.imgs.length; j++) {
            if (node.imgs[j] && node.imgs[j].src)
              list.push({ url: node.imgs[j].src });
          }
        }
      } catch (_) {}
      return list.map(function (o) {
        if (o.url) return { url: absUrl(o.url, win), name: nameFromUrl(o.url) };
        var q = o.q;
        var path =
          "/view?filename=" +
          encodeURIComponent(q.filename || "") +
          "&type=" +
          encodeURIComponent(q.type || "output") +
          "&subfolder=" +
          encodeURIComponent(q.subfolder || "");
        var u = path;
        try {
          if (win.api && typeof win.api.apiURL === "function")
            u = win.api.apiURL(path);
        } catch (_) {}
        return {
          url: absUrl(u, win),
          name: (q.filename || nameFromUrl(u)).split("/").pop(),
        };
      });
    }

    function tauriInvoke() {
      // The bridge may only exist on the top window; both are worth trying.
      var wins = [];
      try {
        wins.push(window);
      } catch (_) {}
      try {
        if (window.top && window.top !== window) wins.push(window.top);
      } catch (_) {}
      for (var i = 0; i < wins.length; i++) {
        try {
          var T = wins[i].__TAURI__;
          if (!T) continue;
          if (T.core && typeof T.core.invoke === "function")
            return T.core.invoke.bind(T.core);
          if (typeof T.invoke === "function") return T.invoke.bind(T);
        } catch (_) {}
      }
      return null;
    }
    function saveOne(item, quiet) {
      if (!item || !item.url) return false;
      var name = item.name || nameFromUrl(item.url);
      var inv = tauriInvoke();
      if (inv) {
        try {
          inv("download_file", {
            params: { url: item.url, filename: name, language: "en" },
          });
          if (!quiet) rhToast("⬇️ Saving " + name + " → Downloads");
          return true;
        } catch (e) {
          warn("tauri download failed", e);
        }
      }
      try {
        // a real <a download> in the DOM
        var d = topDoc();
        var a = d.createElement("a");
        a.href = item.url;
        a.download = name;
        a.style.cssText = "position:fixed;left:-9999px;";
        (d.body || d.documentElement).appendChild(a);
        a.click();
        setTimeout(function () {
          if (a.parentNode) a.parentNode.removeChild(a);
        }, 2000);
        if (!quiet) rhToast("⬇️ " + name + " → Downloads folder");
        return true;
      } catch (e) {
        warn("anchor download failed", e);
      }
      try {
        window.open(item.url, "_blank");
        rhToast("↗️ Opened " + name + " — save it from there", 4000);
        return true;
      } catch (e) {
        rhToast("❌ Could not save " + name);
        return false;
      }
    }
    function saveOutputs(items) {
      if (!items || !items.length) {
        rhToast("No outputs on this node yet");
        return;
      }
      if (items.length === 1) {
        saveOne(items[0]);
        return;
      }
      rhToast("⬇️ Saving " + items.length + " files → Downloads");
      items.forEach(function (it, i) {
        setTimeout(function () {
          saveOne(it, true);
        }, i * 400);
      });
    }
    function saveAllRunOutputs() {
      var t = engineTarget,
        g = getGraph(t),
        app = getApp(t);
      if (!t || !g || !app || !app.nodeOutputs) {
        rhToast("No outputs to save yet");
        return;
      }
      var all = [];
      try {
        Object.keys(app.nodeOutputs).forEach(function (id) {
          var n = g.getNodeById(Number(id));
          if (n) all = all.concat(outputsOf(n, t.win));
        });
      } catch (_) {}
      saveOutputs(all);
    }
    /* ======================= 14. extension trimming (one switch) =========
     * Conservative, reversible, and self-verifying: it only acts if the
     * frontend really exposes a disabled-extensions setting, only matches
     * cosmetic/QoL extension names, and remembers the previous list so turning
     * the switch off restores exactly what RH had. */
    var TRIM_PATTERNS = [
      /favicon/i,
      /\.locking$/i,
      /snaptogrid/i,
      /guide/i,
      /tutorial/i,
      /imagefeed/i,
      /image[_-]?feed/i,
      /analytics/i,
      /telemetry/i,
      /\.tips?$/i,
      /wechat/i,
      /qrcode/i,
      /banner/i,
      /promo/i,
      /announce/i,
      /changelog/i,
      /whatsnew/i,
    ];
    var EXT_SETTING = "Comfy.Extension.Disabled";
    function extSettingApi(app) {
      try {
        if (
          app &&
          app.extensionManager &&
          app.extensionManager.setting &&
          typeof app.extensionManager.setting.get === "function" &&
          typeof app.extensionManager.setting.set === "function"
        ) {
          return {
            get: function () {
              return app.extensionManager.setting.get(EXT_SETTING);
            },
            set: function (v) {
              return app.extensionManager.setting.set(EXT_SETTING, v);
            },
          };
        }
        if (
          app &&
          app.ui &&
          app.ui.settings &&
          typeof app.ui.settings.getSettingValue === "function" &&
          typeof app.ui.settings.setSettingValue === "function"
        ) {
          return {
            get: function () {
              return app.ui.settings.getSettingValue(EXT_SETTING);
            },
            set: function (v) {
              return app.ui.settings.setSettingValue(EXT_SETTING, v);
            },
          };
        }
      } catch (_) {}
      return null;
    }
    function extensionNames(app) {
      var names = [];
      try {
        var ex =
          app &&
          (app.extensions ||
            (app.extensionManager && app.extensionManager.extensions));
        if (ex && ex.length) {
          for (var i = 0; i < ex.length; i++) {
            var n = ex[i] && (ex[i].name || ex[i].id);
            if (n) names.push(String(n));
          }
        }
      } catch (_) {}
      return names;
    }
    function applyExtensionTrim(on) {
      var t = engineTarget,
        app = getApp(t);
      var api = extSettingApi(app);
      if (!api) {
        rhToast(
          "⚠️ This ComfyUI build has no extension setting — trim skipped",
          5000,
        );
        return false;
      }
      var cur = [];
      try {
        var v = api.get();
        if (Array.isArray(v)) cur = v.slice();
      } catch (_) {}
      if (on) {
        if (lsGet(EXT_PREV_KEY) == null)
          lsSet(EXT_PREV_KEY, JSON.stringify(cur));
        var names = extensionNames(app);
        var add = names.filter(function (n) {
          return (
            cur.indexOf(n) === -1 &&
            TRIM_PATTERNS.some(function (rx) {
              return rx.test(n);
            })
          );
        });
        log("extensions seen:", names);
        if (!add.length) {
          rhToast(
            "Nothing safe to trim (" + names.length + " extensions seen)",
            4000,
          );
          return false;
        }
        try {
          api.set(cur.concat(add));
        } catch (e) {
          rhToast("⚠️ Could not write the setting");
          return false;
        }
        rhToast(
          "✂️ Trimmed " + add.length + " cosmetic extensions — reload to apply",
          6000,
        );
        return true;
      }
      var prev = safeParse(EXT_PREV_KEY, null);
      try {
        api.set(Array.isArray(prev) ? prev : []);
      } catch (_) {}
      try {
        localStorage.removeItem(EXT_PREV_KEY);
      } catch (_) {}
      rhToast("↩️ Extension trim off — reload to apply", 5000);
      return true;
    }
    /* ======================= 15. storage report + cleanup ================
     * Shows sizes before deleting anything, and hard-protects the script copies
     * and any auth material (the cookie login writes tokens into localStorage). */
    var PROTECTED_RX =
      /^(RH_MAIN_SCRIPT_OVERRIDE|RH_LAST_GOOD_SCRIPT|RH_QOL_CONFIG|RH_BOOKMARKS|RH_FLOATING_POS|RH_LINK_MODE|RH_EXT_PREV_DISABLED|RH_COMFY_BUNDLE|RH_CUSTOM_SCRIPTS_LIST)$|token|auth|session|user|login|jwt/i;
    function storageReport() {
      var groups = { comfy: 0, rh: 0, ours: 0, other: 0 },
        counts = { comfy: 0, rh: 0, ours: 0, other: 0 };
      try {
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          var v = localStorage.getItem(k) || "";
          var size = (k.length + v.length) * 2; // UTF-16 bytes
          var g = /^Comfy\.|^workflow|^litegraph|^Comfy_/i.test(k)
            ? "comfy"
            : /^RH_/.test(k)
              ? "ours"
              : /runninghub|rh[-_]/i.test(k)
                ? "rh"
                : "other";
          groups[g] += size;
          counts[g]++;
        }
      } catch (_) {}
      return { groups: groups, counts: counts };
    }
    function fmtBytes(n) {
      if (n < 1024) return n + " B";
      if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
      return (n / 1048576).toFixed(2) + " MB";
    }
    function freePreviewMemory() {
      var t = engineTarget,
        app = getApp(t);
      var freed = 0;
      try {
        freed =
          app && app.nodeOutputs ? Object.keys(app.nodeOutputs).length : 0;
      } catch (_) {}
      try {
        if (app && typeof app.clean === "function") {
          app.clean();
          rhToast("🧹 Freed preview memory (" + freed + " nodes)");
          return;
        }
        if (app) {
          app.nodeOutputs = {};
          app.nodePreviewImages = {};
          rhToast("🧹 Cleared cached outputs");
          return;
        }
        rhToast("Engine not attached — nothing to free");
      } catch (e) {
        rhToast("⚠️ Could not free memory: " + e.message);
      }
    }
    function clearComfyCacheKeys() {
      var removed = 0,
        freed = 0;
      try {
        var kill = [];
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (!k || PROTECTED_RX.test(k)) continue;
          if (
            /^Comfy\.PreviousWorkflow|^workflow$|^litegraph|clipboard|_cache$|Comfy\.NodeLibrary\.Bookmarks\.cache/i.test(
              k,
            )
          )
            kill.push(k);
        }
        kill.forEach(function (k) {
          var v = localStorage.getItem(k) || "";
          freed += (k.length + v.length) * 2;
          try {
            localStorage.removeItem(k);
            removed++;
          } catch (_) {}
        });
      } catch (_) {}
      rhToast(
        removed
          ? "🧹 Removed " + removed + " cache keys (" + fmtBytes(freed) + ")"
          : "Nothing to remove",
      );
    }
    function openCachePanel() {
      var d = topDoc();
      if (d.getElementById("rh-cache-overlay")) return;
      var rep = storageReport();
      var ovl = d.createElement("div");
      ovl.id = "rh-cache-overlay";
      ovl.style.cssText =
        "position:fixed;inset:0;z-index:1000002;background:rgba(0,0,0,.6);" +
        "display:flex;align-items:center;justify-content:center;font-family:monospace;";
      ovl.innerHTML =
        '<div style="width:min(560px,94vw);background:#16161a;border:1px solid #333;border-radius:8px;padding:16px;color:#ddd;box-shadow:0 12px 40px rgba(0,0,0,.8);">' +
        '<div style="font-weight:bold;font-size:14px;margin-bottom:10px;">🧹 Storage &amp; cache</div>' +
        '<div style="font-size:11px;line-height:1.9;color:#bbb;margin-bottom:12px;">' +
        "ComfyUI keys: <b>" +
        fmtBytes(rep.groups.comfy) +
        "</b> (" +
        rep.counts.comfy +
        ")<br>" +
        "RunningHub keys: <b>" +
        fmtBytes(rep.groups.rh) +
        "</b> (" +
        rep.counts.rh +
        ")<br>" +
        "Our keys (protected): <b>" +
        fmtBytes(rep.groups.ours) +
        "</b> (" +
        rep.counts.ours +
        ")<br>" +
        "Other: <b>" +
        fmtBytes(rep.groups.other) +
        "</b> (" +
        rep.counts.other +
        ")" +
        "</div>" +
        '<div style="display:flex;flex-direction:column;gap:8px;">' +
        '<button id="rh-cache-mem" style="padding:8px;background:#223344;border:1px solid #335577;color:#88ccff;border-radius:4px;cursor:pointer;font-size:11px;">🧠 Free preview memory (outputs stay on RH servers)</button>' +
        '<button id="rh-cache-keys" style="padding:8px;background:#2b2b36;border:1px solid #555;color:#ddd;border-radius:4px;cursor:pointer;font-size:11px;">🗑️ Clear ComfyUI cache keys (keeps settings, login, scripts)</button>' +
        "</div>" +
        '<div style="font-size:10px;color:#777;margin-top:12px;line-height:1.6;">' +
        "The webview's own disk cache is the biggest consumer and cannot be cleared from a page. " +
        "Close the app and delete the <b>EBWebView</b> folder inside<br>%LOCALAPPDATA%\\com.pake.weekly\\ (or the app's data folder) to reclaim it." +
        "</div>" +
        '<div style="text-align:right;margin-top:12px;"><button id="rh-cache-close" style="padding:6px 16px;background:#2b2b36;border:1px solid #444;color:#ccc;border-radius:4px;cursor:pointer;font-size:11px;">Close</button></div>' +
        "</div>";
      d.body.appendChild(ovl);
      var close = function () {
        if (ovl.parentNode) ovl.parentNode.removeChild(ovl);
      };
      ovl.querySelector("#rh-cache-close").onclick = close;
      ovl.querySelector("#rh-cache-mem").onclick = function () {
        freePreviewMemory();
        close();
      };
      ovl.querySelector("#rh-cache-keys").onclick = function () {
        clearComfyCacheKeys();
        close();
      };
    }

    /* ======================= 16. bookmarks + nav (base window) =========== */
    function getBookmarks() {
      var b = safeParse(BOOKMARK_KEY, []);
      return Array.isArray(b) ? b : [];
    }
    function saveBookmarks(b) {
      lsSet(BOOKMARK_KEY, JSON.stringify(b.slice(0, 60)));
    }
    function openBookmarkPanel() {
      var d = topDoc();
      var old = d.getElementById("rh-bm-panel");
      if (old) {
        old.parentNode.removeChild(old);
        return;
      }
      var list = getBookmarks();
      var p = d.createElement("div");
      p.id = "rh-bm-panel";
      p.style.cssText =
        "position:fixed;left:14px;bottom:52px;z-index:1000001;width:300px;max-height:50vh;" +
        "overflow:auto;background:#16161a;border:1px solid #333;border-radius:8px;padding:10px;" +
        "color:#ddd;font:12px monospace;box-shadow:0 10px 30px rgba(0,0,0,.7);";
      var rows =
        list
          .map(function (b, i) {
            return (
              '<div style="display:flex;gap:6px;align-items:center;margin:4px 0;">' +
              '<span data-go="' +
              i +
              '" style="flex:1;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' +
              esc(b.url) +
              '">' +
              esc(b.title || b.url) +
              "</span>" +
              '<span data-ren="' +
              i +
              '" style="cursor:pointer;color:#88c;">✎</span>' +
              '<span data-del="' +
              i +
              '" style="cursor:pointer;color:#f66;">✕</span></div>'
            );
          })
          .join("") ||
        '<div style="color:#666;font-style:italic;">No bookmarks yet</div>';
      p.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' +
        '<b>⭐ Bookmarks</b><button id="rh-bm-add" style="padding:3px 8px;background:#00AA55;border:0;color:#fff;border-radius:4px;cursor:pointer;font-size:10px;">+ Add this page</button></div>' +
        rows;
      d.body.appendChild(p);
      p.querySelector("#rh-bm-add").onclick = function () {
        var b = getBookmarks();
        var u = location.href;
        // title is locked to "RunningHub" on this window — default from the URL
        var deflt = "";
        try {
          var seg = new URL(u).pathname.replace(/\/+$/, "").split("/");
          deflt = decodeURIComponent(seg[seg.length - 1] || "") || "RunningHub";
        } catch (e) {
          deflt = "RunningHub";
        }
        openPasteModal(
          "Name this bookmark",
          "type a name…",
          function (name) {
            b.unshift({ title: (name || deflt).slice(0, 60), url: u });
            saveBookmarks(b);
            var pnl = topDoc().getElementById("rh-bm-panel");
            if (pnl) pnl.parentNode.removeChild(pnl);
            openBookmarkPanel();
          },
          deflt,
        );
      };
      p.addEventListener("click", function (e) {
        var go = e.target.getAttribute && e.target.getAttribute("data-go");
        var del = e.target.getAttribute && e.target.getAttribute("data-del");
        var ren = e.target.getAttribute && e.target.getAttribute("data-ren");
        if (go != null) {
          var b1 = getBookmarks()[Number(go)];
          if (b1) location.href = b1.url;
        } else if (ren != null) {
          var idx = Number(ren),
            br = getBookmarks()[idx];
          if (br)
            openPasteModal(
              "Rename bookmark",
              "type a name…",
              function (name) {
                var all = getBookmarks();
                all[idx] = {
                  title: (name || "").slice(0, 60) || br.title,
                  url: br.url,
                };
                saveBookmarks(all);
                var pnl = topDoc().getElementById("rh-bm-panel");
                if (pnl) pnl.parentNode.removeChild(pnl);
                openBookmarkPanel();
              },
              br.title || br.url,
            );
        } else if (del != null) {
          var b2 = getBookmarks();
          b2.splice(Number(del), 1);
          saveBookmarks(b2);
          p.parentNode.removeChild(p);
          openBookmarkPanel();
        }
      });
    }
    function createNavBar() {
      if (!IS_BASE_WINDOW) return; // never inside a workflow window
      if (document.getElementById("rh-navbar")) return;
      if (!document.body) return;
      var bar = document.createElement("div");
      bar.id = "rh-navbar";
      bar.style.cssText =
        "position:fixed;left:12px;bottom:12px;z-index:999999;display:flex;gap:4px;" +
        "opacity:.45;transition:opacity .15s;font-family:monospace;";
      bar.onmouseenter = function () {
        bar.style.opacity = "1";
      };
      bar.onmouseleave = function () {
        bar.style.opacity = ".45";
      };
      var mk = function (txt, title) {
        var b = document.createElement("div");
        b.textContent = txt;
        b.title = title;
        b.style.cssText =
          "width:24px;height:24px;border-radius:6px;background:rgba(22,22,26,.9);" +
          "border:1px solid #3a3a44;color:#ccc;display:flex;align-items:center;justify-content:center;" +
          "cursor:pointer;font-size:13px;user-select:none;";
        return b;
      };
      var back = mk("‹", "Back"),
        fwd = mk("›", "Forward"),
        bm = mk("★", "Bookmarks");
      back.onclick = function () {
        try {
          history.back();
        } catch (_) {}
      };
      fwd.onclick = function () {
        try {
          history.forward();
        } catch (_) {}
      };
      bm.onclick = function () {
        openBookmarkPanel();
      };
      bar.appendChild(back);
      bar.appendChild(fwd);
      bar.appendChild(bm);
      document.body.appendChild(bar);
    }

    /* ======================= 17. prefetch the ComfyUI bundle ============== */
    var prefetched = false;
    function prefetchComfy() {
      if (prefetched || !config.prefetchWorkflow || !IS_BASE_WINDOW) return;
      prefetched = true;
      var run = function () {
        try {
          var urls = ["/comfyUI.html"];
          var b = lsGet(BUNDLE_KEY);
          if (b) urls.push(b);
          urls.forEach(function (u) {
            var l = document.createElement("link");
            l.rel = "prefetch";
            l.href = u;
            document.head.appendChild(l);
          });
          log("prefetched", urls);
        } catch (_) {}
      };
      if (window.requestIdleCallback)
        window.requestIdleCallback(run, { timeout: 8000 });
      else setTimeout(run, 4000);
    }
    /* ======================= 18. gear menu ============================== */
    var CORE_LABELS = {
      blockTelemetry: "Block third-party telemetry",
      quietConsole: "Quiet console (privacy)",
      fpsOptimization: "FPS optimisation",
      vectorNodeIndicator: "Highlight running node",
      nodeProgressBar: "Show node progress bar",
      enhancedWires: "Thicker wires",
      darkerGrid: "Dark canvas",
      breakpointSolid: "Breakpoint: solid outline",
      autoCenterRunningNode: "Auto-centre running node",
      autoCancelBreakpoints: "Auto-cancel at breakpoints",
      closeGuard: "Warn when closing mid-run",
      popupTitleStatus: "Run status in title bar",
      expandTaskPanel: "Open Task List when cancelling",
      prefetchWorkflow: "Prefetch workflow bundle",
      reuseWorkflowWindow: "Reuse one workflow window",
      trimExtensions: "Trim unused ComfyUI extensions",
      sameWindowWorkflows: "Open workflows in same window",
    };

    function createFloatingMenu() {
      if (!SHOW_UI) return;
      if (document.getElementById("rh-floating-root")) return;
      if (!document.body) return;

      if (!document.getElementById("rh-floating-style")) {
        var st = document.createElement("style");
        st.id = "rh-floating-style";
        st.textContent =
          "#rh-floating-root{position:fixed;z-index:999999;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;touch-action:none;}" +
          "#rh-toggle-btn{width:38px;height:38px;background:#1e1e24;border:1px solid #444;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:grab;font-size:17px;box-shadow:0 4px 12px rgba(0,0,0,.5);user-select:none;}" +
          "#rh-toggle-btn:active{cursor:grabbing;transform:scale(.95);border-color:#00FF66;}" +
          "#rh-settings-panel{position:absolute;bottom:46px;left:0;width:320px;max-height:70vh;overflow-y:auto;background:#16161a;border:1px solid #333;border-radius:8px;padding:12px;color:#ddd;box-shadow:0 8px 24px rgba(0,0,0,.7);}" +
          "#rh-settings-panel button{font-family:monospace;}";
        document.head.appendChild(st);
      }

      var raw = safeParse(POS_KEY, {});
      // Clamp into THIS window — a position saved on a wide window used to put
      // the gear off-screen in a narrower one.
      var pos = {
        x: Math.max(
          8,
          Math.min(Number.isFinite(raw.x) ? raw.x : 20, window.innerWidth - 46),
        ),
        y: Math.max(
          8,
          Math.min(
            Number.isFinite(raw.y) ? raw.y : 20,
            window.innerHeight - 46,
          ),
        ),
      };

      var toggles = Object.keys(DEFAULT_CONFIG)
        .map(function (k) {
          return (
            '<label style="display:flex;justify-content:space-between;align-items:center;margin:5px 0;font-size:11px;cursor:pointer;gap:8px;">' +
            "<span>" +
            esc(CORE_LABELS[k] || k) +
            "</span>" +
            '<input type="checkbox" data-core-key="' +
            esc(k) +
            '"' +
            (config[k] ? " checked" : "") +
            ' style="cursor:pointer;"></label>'
          );
        })
        .join("");
      var box = document.createElement("div");
      box.id = "rh-floating-root";
      box.innerHTML =
        '<div id="rh-toggle-btn" title="Drag to move / click for settings">⚙️</div>' +
        '<div id="rh-settings-panel" style="display:none;">' +
        '<div style="font-weight:bold;font-size:13px;border-bottom:1px solid #333;padding-bottom:4px;display:flex;justify-content:space-between;align-items:center;">' +
        '<span>QoL &amp; Script Manager</span><span id="rh-close-btn" style="cursor:pointer;color:#777;font-size:16px;">✕</span></div>' +
        '<div id="rh-live-source" style="font-size:10px;color:#666;margin:6px 0 8px;"></div>' +
        '<div style="display:flex;gap:6px;margin-bottom:8px;">' +
        '<button id="rh-edit-script-btn" style="flex:1;padding:6px;background:#2b2b36;border:1px solid #00FF66;color:#00FF66;border-radius:4px;cursor:pointer;font-size:11px;font-weight:bold;">📝 Edit Script</button>' +
        '<button id="rh-reload-btn" title="Reload" style="padding:6px 10px;background:#2b2b36;border:1px solid #444;color:#ccc;border-radius:4px;cursor:pointer;font-size:11px;">🔄</button></div>' +
        '<button id="rh-import-cookies-btn" style="width:100%;margin-bottom:6px;padding:6px;background:#2b2b36;border:1px solid #00FF66;color:#00FF66;border-radius:4px;cursor:pointer;font-size:11px;font-weight:bold;">📋 Paste Cookies (JSON)</button>' +
        '<button id="rh-linkmode-btn" style="width:100%;margin-bottom:6px;padding:6px;background:#2b2b36;border:1px solid #555;color:#ddd;border-radius:4px;cursor:pointer;font-size:11px;">🔗 Link style: ' +
        linkModeName(currentLinkMode()) +
        "</button>" +
        '<button id="rh-saveall-btn" style="width:100%;margin-bottom:6px;padding:6px;background:#223344;border:1px solid #335577;color:#88ccff;border-radius:4px;cursor:pointer;font-size:11px;">💾 Save all outputs of this run</button>' +
        '<button id="rh-cache-btn" style="width:100%;margin-bottom:10px;padding:6px;background:#2b2b36;border:1px solid #555;color:#ddd;border-radius:4px;cursor:pointer;font-size:11px;">🧹 Storage &amp; cache…</button>' +
        '<div style="font-size:11px;color:#888;font-weight:bold;margin-bottom:4px;text-transform:uppercase;">Features</div>' +
        '<div id="rh-core-toggles" style="margin-bottom:8px;">' +
        toggles +
        "</div>" +
        '<div style="font-size:11px;color:#888;font-weight:bold;margin:8px 0 4px;border-top:1px solid #333;padding-top:6px;text-transform:uppercase;">Custom UserScripts</div>' +
        '<div id="rh-user-script-list" style="max-height:80px;overflow-y:auto;margin-bottom:6px;"></div>' +
        '<input id="rh-new-script-name" type="text" placeholder="Script name" style="width:100%;box-sizing:border-box;background:#0e0e12;border:1px solid #333;color:#fff;padding:4px;font-size:10px;border-radius:4px;margin-bottom:4px;">' +
        '<textarea id="rh-new-script-code" rows="3" placeholder="// custom JS…" style="width:100%;box-sizing:border-box;background:#0e0e12;border:1px solid #333;color:#00FF66;font-family:monospace;font-size:10px;padding:4px;border-radius:4px;resize:vertical;"></textarea>' +
        '<button id="rh-add-script-btn" style="width:100%;margin-top:4px;padding:4px;background:#223344;border:1px solid #335577;color:#88ccff;border-radius:4px;cursor:pointer;font-size:10px;">➕ Add script</button>' +
        '<button id="rh-save-apply-btn" style="width:100%;margin-top:10px;padding:6px;background:#00AA55;border:none;color:#fff;border-radius:4px;cursor:pointer;font-size:12px;font-weight:bold;">Save &amp; Reload</button>' +
        "</div>";
      document.body.appendChild(box);
      box.style.left = pos.x + "px";
      box.style.top = pos.y + "px";

      var srcEl = box.querySelector("#rh-live-source");
      var src = window.__RH_LIVE_SOURCE__;
      srcEl.textContent =
        "v" +
        VERSION +
        " · live copy: " +
        (src === "cache"
          ? "LAST-GOOD CACHE"
          : src === "override"
            ? "OVERRIDE"
            : "BUNDLED") +
        (IS_WORKFLOW_WINDOW ? " · workflow window" : " · base window");

      var toggleBtn = box.querySelector("#rh-toggle-btn");
      var panel = box.querySelector("#rh-settings-panel");
      function placePanel() {
        var r = box.getBoundingClientRect();
        if (r.top < 340) {
          panel.style.bottom = "auto";
          panel.style.top = "46px";
        } else {
          panel.style.top = "auto";
          panel.style.bottom = "46px";
        }
        if (r.left > window.innerWidth - 330) {
          panel.style.left = "auto";
          panel.style.right = "0";
        } else {
          panel.style.right = "auto";
          panel.style.left = "0";
        }
      }
      var dragging = false,
        sx = 0,
        sy = 0,
        ix = 0,
        iy = 0,
        moved = 0;
      function onMove(e) {
        if (!dragging) return;
        var dx = e.clientX - sx,
          dy = e.clientY - sy;
        moved = Math.hypot(dx, dy);
        box.style.left =
          Math.max(8, Math.min(ix + dx, window.innerWidth - 46)) + "px";
        box.style.top =
          Math.max(8, Math.min(iy + dy, window.innerHeight - 46)) + "px";
      }
      function endDrag() {
        if (!dragging) return;
        dragging = false;
        toggleBtn.removeEventListener("pointermove", onMove);
        toggleBtn.removeEventListener("pointerup", endDrag);
        toggleBtn.removeEventListener("pointercancel", endDrag);
        var r = box.getBoundingClientRect();
        lsSet(
          POS_KEY,
          JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) }),
        );
        placePanel();
      }
      toggleBtn.addEventListener("pointerdown", function (e) {
        if (e.button !== 0) return;
        dragging = true;
        sx = e.clientX;
        sy = e.clientY;
        moved = 0;
        var r = box.getBoundingClientRect();
        ix = r.left;
        iy = r.top;
        try {
          toggleBtn.setPointerCapture(e.pointerId);
        } catch (_) {}
        toggleBtn.addEventListener("pointermove", onMove);
        toggleBtn.addEventListener("pointerup", endDrag);
        toggleBtn.addEventListener("pointercancel", endDrag);
        e.preventDefault();
      });
      toggleBtn.addEventListener("click", function () {
        if (moved > 5) return;
        placePanel();
        panel.style.display = panel.style.display === "none" ? "block" : "none";
      });

      var listEl = box.querySelector("#rh-user-script-list");
      function renderScripts() {
        if (!customScripts.length) {
          listEl.innerHTML =
            '<div style="font-size:10px;color:#666;font-style:italic;">None added.</div>';
          return;
        }
        listEl.innerHTML = customScripts
          .map(function (s, i) {
            return (
              '<div style="display:flex;justify-content:space-between;align-items:center;margin:4px 0;background:#101014;padding:3px 6px;border-radius:4px;font-size:11px;">' +
              '<label style="cursor:pointer;display:flex;align-items:center;gap:6px;">' +
              '<input type="checkbox" data-script-idx="' +
              i +
              '"' +
              (s.enabled ? " checked" : "") +
              ">" +
              '<span style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
              esc(s.name) +
              "</span></label>" +
              '<span data-del-idx="' +
              i +
              '" style="cursor:pointer;color:#f66;font-size:12px;">🗑️</span></div>'
            );
          })
          .join("");
      }
      renderScripts();
      listEl.addEventListener("click", function (e) {
        var i = e.target.getAttribute && e.target.getAttribute("data-del-idx");
        if (i == null) return;
        customScripts.splice(Number(i), 1);
        renderScripts();
      });

      box.querySelector("#rh-close-btn").onclick = function () {
        panel.style.display = "none";
      };
      box.querySelector("#rh-reload-btn").onclick = function () {
        location.reload();
      };
      box.querySelector("#rh-edit-script-btn").onclick = function () {
        panel.style.display = "none";
        openScriptEditor();
      };
      box.querySelector("#rh-import-cookies-btn").onclick = function () {
        pasteAndImportCookies();
      };
      box.querySelector("#rh-cache-btn").onclick = function () {
        panel.style.display = "none";
        openCachePanel();
      };
      box.querySelector("#rh-saveall-btn").onclick = function () {
        panel.style.display = "none";
        saveAllRunOutputs();
      };
      box.querySelector("#rh-linkmode-btn").onclick = function (e) {
        cycleLinkMode();
        e.target.textContent =
          "🔗 Link style: " + linkModeName(currentLinkMode());
      };
      box.querySelector("#rh-add-script-btn").onclick = function () {
        var nameEl = box.querySelector("#rh-new-script-name"),
          codeEl = box.querySelector("#rh-new-script-code");
        var code = codeEl.value.trim();
        if (!code) {
          rhToast("⚠️ Enter some code first");
          return;
        }
        try {
          new Function(code);
        } catch (err) {
          rhToast("❌ Syntax error: " + err.message);
          return;
        }
        customScripts.push({
          id: Date.now(),
          name: nameEl.value.trim() || "Script #" + (customScripts.length + 1),
          code: code,
          enabled: true,
        });
        nameEl.value = "";
        codeEl.value = "";
        renderScripts();
      };
      box.querySelector("#rh-save-apply-btn").onclick = function () {
        try {
          var trimWas = !!config.trimExtensions;
          box.querySelectorAll("input[data-core-key]").forEach(function (inp) {
            config[inp.getAttribute("data-core-key")] = inp.checked;
          });
          saveConfig();
          box
            .querySelectorAll("input[data-script-idx]")
            .forEach(function (inp) {
              var i = Number(inp.getAttribute("data-script-idx"));
              if (customScripts[i]) customScripts[i].enabled = inp.checked;
            });
          saveCustomScripts();
          if (!!config.trimExtensions !== trimWas)
            applyExtensionTrim(!!config.trimExtensions);
          setTimeout(function () {
            location.reload();
          }, 600);
        } catch (e) {
          rhToast("❌ Save failed: " + e.message);
        }
      };
    }

    /* ======================= 19. script editor ========================== */
    function openScriptEditor() {
      var d = topDoc();
      if (d.getElementById("rh-edit-overlay")) return;
      var overrideSrc = lsGet(SCRIPT_OVERRIDE_KEY),
        cacheSrc = lsGet(SCRIPT_CACHE_KEY);
      var src = window.__RH_LIVE_SOURCE__;
      var label =
        src === "override" || overrideSrc != null
          ? "OVERRIDE (your edited copy is live)"
          : src === "cache"
            ? "LAST-GOOD CACHE (saving creates an override)"
            : "BUNDLED v" +
              VERSION +
              " (compiled in — saving creates an override)";
      var prefill =
        overrideSrc != null
          ? overrideSrc
          : cacheSrc != null
            ? cacheSrc
            : "// The live copy is the one BUNDLED into this build.\n" +
              "// Paste a complete custom_r.js here to override it.\n";
      var o = d.createElement("div");
      o.id = "rh-edit-overlay";
      o.style.cssText =
        "position:fixed;inset:0;z-index:1000002;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;";
      o.innerHTML =
        '<div style="width:min(920px,94vw);height:min(80vh,720px);background:#16161a;border:1px solid #333;border-radius:8px;display:flex;flex-direction:column;overflow:hidden;font-family:monospace;color:#ddd;box-shadow:0 12px 40px rgba(0,0,0,.8);">' +
        '<div style="padding:10px 14px;border-bottom:1px solid #333;display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;">' +
        '<div style="font-weight:bold;font-size:13px;">📝 Edit Script — custom_r.js v' +
        VERSION +
        "</div>" +
        '<div style="font-size:10px;color:#00FF66;">LIVE: ' +
        esc(label) +
        "</div></div>" +
        '<textarea id="rh-edit-code" spellcheck="false" style="flex:1;width:100%;box-sizing:border-box;background:#0e0e12;border:none;color:#00FF66;padding:10px;font-family:monospace;font-size:11px;resize:none;outline:none;"></textarea>' +
        '<div style="padding:10px 14px;display:flex;gap:8px;justify-content:flex-end;align-items:center;">' +
        '<div style="margin-right:auto;font-size:9px;color:#666;">Syntax-checked before saving · the last-good cache only updates after a clean boot</div>' +
        '<button id="rh-edit-remove" style="padding:6px 14px;background:#552222;border:1px solid #883333;color:#ffbbbb;border-radius:4px;cursor:pointer;font-size:11px;">Remove Override</button>' +
        '<button id="rh-edit-cancel" style="padding:6px 14px;background:#2b2b36;border:1px solid #444;color:#ccc;border-radius:4px;cursor:pointer;font-size:11px;">Cancel</button>' +
        '<button id="rh-edit-save" style="padding:6px 18px;background:#00AA55;border:none;color:#fff;border-radius:4px;cursor:pointer;font-weight:bold;font-size:11px;">Save &amp; Reload</button>' +
        "</div></div>";
      d.body.appendChild(o);
      var ta = o.querySelector("#rh-edit-code");
      ta.value = prefill;
      var close = function () {
        if (o.parentNode) o.parentNode.removeChild(o);
      };
      o.querySelector("#rh-edit-cancel").onclick = close;
      ta.addEventListener("keydown", function (e) {
        if (e.key === "Escape") close();
      });
      o.querySelector("#rh-edit-remove").onclick = function () {
        try {
          localStorage.removeItem(SCRIPT_OVERRIDE_KEY);
        } catch (_) {}
        location.reload();
      };
      o.querySelector("#rh-edit-save").onclick = function () {
        var code = ta.value;
        if (!code || !code.trim()) {
          rhToast("⚠️ Refusing to save an empty script");
          return;
        }
        try {
          new Function(code);
        } catch (err) {
          rhToast("❌ Syntax error: " + err.message, 6000);
          return;
        }
        if (code.indexOf("__RH_SCRIPT_BOOT_OK__") === -1) {
          rhToast(
            "❌ Not a full custom_r.js (no boot handshake) — not saved",
            7000,
          );
          return;
        }
        if (!lsSet(SCRIPT_OVERRIDE_KEY, code)) {
          rhToast("❌ Save failed (storage blocked)");
          return;
        }
        rhToast("✅ Saved — reloading…");
        setTimeout(function () {
          location.reload();
        }, 400);
      };
      ta.focus();
    }
    /* ======================= 20. poller ================================= */
    var engineReady = false,
      engineMisses = 0,
      warnedNoEngine = false;
    function pollTick() {
      if (destroyed) return;
      try {
        if (SHOULD_LOCK_TITLE) {
          var tEl = document.querySelector("title");
          if (tEl && tEl.textContent !== "RunningHub")
            tEl.textContent = "RunningHub";
        }
      } catch (_) {}

      try {
        if (SHOW_UI && document.body) {
          if (!document.getElementById("rh-floating-root"))
            createFloatingMenu();
          createNavBar();
          ensureHUD();
        }
      } catch (e) {
        warn("ui tick", e);
      }

      try {
        var t = resolveEngineTarget();
        if (t) {
          injectCanvasCSS(t);
          attachEngine(t);
          ensureOverlay(t);
          rememberBundle(t);
          var cv = getLgc(t);
          if (cv) {
            enforceInstanceSettings(cv);
            if (!engineReady) {
              engineReady = true;
              log(
                "engine ready",
                t.host ? "iframe" : "self",
                cv.ds && cv.ds.scale,
              );
            }
          }
        } else if (IS_WORKFLOW_WINDOW && !engineReady) {
          engineMisses++;
          if (engineMisses === 20 && !warnedNoEngine) {
            // ~12s
            warnedNoEngine = true;
            rhToast(
              "⚠️ ComfyUI engine not found — canvas features are off (frames:" +
                document.querySelectorAll("iframe").length +
                ")",
              8000,
            );
          }
        }
      } catch (e) {
        warn("engine tick", e);
      }

      try {
        updateHUD();
      } catch (_) {}
    }
    var pollTimer = setInterval(pollTick, 600);
    cleanups.push(function () {
      clearInterval(pollTimer);
    });
    pollTick();
    prefetchComfy();

    /* ======================= 21. teardown + debug ======================= */
    window.__RH_EXT_TEARDOWN__ = function () {
      destroyed = true;
      cleanups.forEach(function (fn) {
        try {
          fn();
        } catch (_) {}
      });
      [
        "rh-floating-root",
        "rh-floating-style",
        "rh-timer-hud",
        "rh-toast-host",
        "rh-navbar",
        "rh-bm-panel",
        "rh-modal-overlay",
        "rh-edit-overlay",
        "rh-cache-overlay",
        "rh-firstrun-overlay",
      ].forEach(function (id) {
        var el = document.getElementById(id);
        if (el && el.parentNode) el.parentNode.removeChild(el);
        try {
          var e2 = topDoc().getElementById(id);
          if (e2 && e2.parentNode) e2.parentNode.removeChild(e2);
        } catch (_) {}
      });
      try {
        if (engineTarget && engineTarget.doc) {
          ["rh-graph-overlay", "rh-canvas-perf-style"].forEach(function (id) {
            var el = engineTarget.doc.getElementById(id);
            if (el && el.parentNode) el.parentNode.removeChild(el);
          });
        }
      } catch (_) {}
      window.__RH_EXT_INITIALIZED__ = false;
    };

    window.__RH_DEBUG__ = {
      version: VERSION,
      config: config,
      stopNodeIds: stopNodeIds,
      engine: function () {
        return engineTarget;
      },
      lgc: function () {
        return getLgc(engineTarget);
      },
      app: function () {
        return getApp(engineTarget);
      },
      outputs: function () {
        return saveAllRunOutputs;
      },
      cancelDom: function () {
        return cancelDiagnostics();
      },
      cancel: function () {
        return triggerRHInterrupt(
          engineTarget || { win: window, doc: document },
        );
      },
      linkMode: cycleLinkMode,
      teardown: function () {
        return window.__RH_EXT_TEARDOWN__();
      },
    };

    if (!window.__RH_LIVE_SOURCE__) window.__RH_LIVE_SOURCE__ = "bundled";
    window.__RH_SCRIPT_VERSION__ = VERSION; // lets a newer copy supersede us
    window.__RH_EXT_INITIALIZED__ = true; // MUST be last
    log("v" + VERSION + " initialized", {
      top: IS_TOP,
      workflow: IS_WORKFLOW_WINDOW,
      comfyDoc: IS_COMFY_DOC,
      source: window.__RH_LIVE_SOURCE__,
    });
  } /* end main() */
})();
