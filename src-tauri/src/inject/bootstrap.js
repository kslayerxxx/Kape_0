/* ==========================================================================
 * RunningHub bootstrap loader — src-tauri/src/inject/bootstrap.js
 * --------------------------------------------------------------------------
 * IMPORTANT: this is a RENAME of the old inject/custom.js content.
 * Pake's CLI empties inject/custom.js on EVERY build when --inject is not
 * passed (injectCustomCode(): `fsExtra.writeFile(injectFilePath, '')`) —
 * that silently wiped the bootstrap out of previous builds. bootstrap.js is
 * a filename the CLI does not manage, so it survives builds. It is injected
 * by an explicit line in src-tauri/src/app/window.rs:
 *   .initialization_script(include_str!("../inject/bootstrap.js"))
 *
 * Job (zero network, zero page assumptions):
 *   1. localStorage RH_MAIN_SCRIPT_OVERRIDE (written by the in-app editor)
 *   2. → fallback localStorage RH_LAST_GOOD_SCRIPT (auto-cache)
 *   3. → else the BUNDLED inject/custom_r.js (injected right after this file)
 *        initialises itself; the paste panel only appears if 3s later nothing
 *        has initialised at all.
 * Never shows the panel inside the ComfyUI iframe — that copy stands down by
 * design and the top frame owns all UI.
 *
 * Handshake with custom_r.js (v2.4+):
 *   - script sets __RH_SCRIPT_BOOT_OK__ immediately on entry (even on
 *     non-RH pages) → counts as installed, no panel
 *   - script sets __RH_EXT_INITIALIZED__ LAST, only after a fully
 *     successful init → only then is the last-good cache refreshed, so a
 *     broken edit degrades to last-good instead of bricking
 *
 * Also defines __RH_HOT_RELOAD__() — teardown + reload (console).
 * ========================================================================== */
(function () {
  "use strict";
  var KEY_OVERRIDE = "RH_MAIN_SCRIPT_OVERRIDE";
  var KEY_CACHE = "RH_LAST_GOOD_SCRIPT";
  if (window.__RH_BOOTSTRAP_RAN__) return;
  window.__RH_BOOTSTRAP_RAN__ = true;

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  window.__RH_HOT_RELOAD__ = function () {
    try {
      if (typeof window.__RH_EXT_TEARDOWN__ === "function") window.__RH_EXT_TEARDOWN__();
    } catch (e) {}
    location.reload();
  };

  function install(src, label) {
    try {
      try { delete window.__RH_SCRIPT_BOOT_OK__; } catch (e) {}
      try { delete window.__RH_EXT_INITIALIZED__; } catch (e) {}
      (window.eval)(src);
      if (window.__RH_SCRIPT_BOOT_OK__ !== true) {
        console.error("[RH bootstrap] " + label + " copy did not signal boot (v2.3 or older lacks the handshake — install v2.4)");
        return false;
      }
      window.__RH_LIVE_SOURCE__ = label;
      if (window.__RH_EXT_INITIALIZED__ === true) lsSet(KEY_CACHE, src);
      return true;
    } catch (err) {
      console.error("[RH bootstrap] " + label + " copy threw during load:", err);
      return false;
    }
  }

  var override = lsGet(KEY_OVERRIDE);
  var cache = lsGet(KEY_CACHE);
  var ok = false;
  if (override && override.trim()) ok = install(override, "override");
  if (!ok && cache && cache.trim()) ok = install(cache, "cache");

  // Nothing in localStorage. A BUNDLED copy (inject/custom_r.js) is injected
  // right after this script and will initialise on its own, so do not show the
  // paste panel yet — wait and see whether anything came up. Also never show
  // it inside the ComfyUI iframe: that copy deliberately stands down and the
  // top frame owns the UI.
  if (!ok) {
    var inStandDownFrame = false;
    try {
      inStandDownFrame = window.self !== window.top &&
        !!(window.top && window.top.document && window.top.document.body);
    } catch (e) { inStandDownFrame = false; }
    if (!inStandDownFrame) {
      setTimeout(function () {
        if (window.__RH_EXT_INITIALIZED__ !== true) showFirstRunPanel();
      }, 3000);
    }
  }

  function showFirstRunPanel() {
    var render = function () {
      if (!document.body) { setTimeout(render, 100); return; }
      if (document.getElementById("rh-firstrun-overlay")) return;
      var ov = document.createElement("div");
      ov.id = "rh-firstrun-overlay";
      ov.style.cssText =
        "position:fixed;inset:0;z-index:2147483647;background:rgba(9,10,12,.96);" +
        "display:flex;align-items:center;justify-content:center;font-family:Consolas,Menlo,monospace;";
      ov.innerHTML =
        '<div style="width:min(880px,94vw);padding:22px;background:#141519;border:1px solid #333;border-radius:8px;box-shadow:0 16px 60px rgba(0,0,0,.6);color:#ddd;">' +
          '<div style="font-size:15px;font-weight:bold;margin-bottom:6px;color:#00FF66;">RH custom script \u2014 no working copy loaded</div>' +
          '<div style="font-size:12px;color:#999;margin-bottom:12px;line-height:1.6;">' +
            "Neither your edited copy, the last-good cache, nor the copy bundled into this build initialised.<br>" +
            "Paste a known-good custom_r.js below and press Install. Normally you never see this panel \u2014<br>" +
            "updates go through the gear menu \u2192 \uD83D\uDCDD Edit Script (or Ctrl+Shift+E)." +
          "</div>" +
          '<textarea id="rh-firstrun-code" spellcheck="false" placeholder="// paste custom_r.js here" ' +
            'style="width:100%;height:44vh;box-sizing:border-box;background:#0e0e12;border:1px solid #333;color:#00FF66;padding:10px;border-radius:4px;font:12px Consolas,Menlo,monospace;resize:vertical;"></textarea>' +
          '<div style="margin-top:12px;">' +
            '<button id="rh-firstrun-save" style="padding:9px 20px;background:#00AA55;border:none;color:#fff;border-radius:4px;font:bold 13px monospace;cursor:pointer;">Install &amp; Reload</button>' +
          "</div>" +
        "</div>";
      document.body.appendChild(ov);
      var btn = document.querySelector("#rh-firstrun-save");
      var ta = document.querySelector("#rh-firstrun-code");
      if (btn) btn.addEventListener("click", function () {
        var v = ta ? ta.value : "";
        if (!v || !v.trim()) { if (ta) ta.focus(); return; }
        lsSet(KEY_OVERRIDE, v);
        lsSet(KEY_CACHE, v);
        location.reload();
      });
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", render, { once: true });
    } else {
      render();
    }
  }
})();
