/* ==========================================================================
 * RunningHub bootstrap loader — src-tauri/src/inject/bootstrap.js   (v2.6)
 * --------------------------------------------------------------------------
 * Injected by an explicit line in src-tauri/src/app/window.rs:
 *   .initialization_script(include_str!("../inject/bootstrap.js"))
 * followed by the bundled script:
 *   .initialization_script(include_str!("../inject/custom_r.js"))
 * (Do NOT put this in inject/custom.js — Pake's CLI truncates that exact
 * filename on every build when --inject is absent.)
 *
 * Load order: RH_MAIN_SCRIPT_OVERRIDE → RH_LAST_GOOD_SCRIPT → the bundled
 * copy that runs right after this file.
 *
 * v2.6 rule change (this is what stopped the silent deaths): a copy counts as
 * installed only once it reports __RH_EXT_INITIALIZED__ === true. Merely
 * signalling boot is no longer enough, because a copy that starts and then
 * returns early looked like success and suppressed every fallback. The check
 * is deferred, so a script that waits for its URL to commit still counts.
 * ========================================================================== */
(function () {
  "use strict";
  var KEY_OVERRIDE = "RH_MAIN_SCRIPT_OVERRIDE";
  var KEY_CACHE = "RH_LAST_GOOD_SCRIPT";
  var GRACE_MS = 8000;
  if (window.__RH_BOOTSTRAP_RAN__) return;
  window.__RH_BOOTSTRAP_RAN__ = true;

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function isTopDoc() {
    try { return document === window.top.document; } catch (e) { return false; }
  }

  window.__RH_HOT_RELOAD__ = function () {
    try { if (typeof window.__RH_EXT_TEARDOWN__ === "function") window.__RH_EXT_TEARDOWN__(); } catch (e) {}
    location.reload();
  };

  function install(src, label) {
    try {
      try { delete window.__RH_SCRIPT_BOOT_OK__; } catch (e) {}
      try { delete window.__RH_EXT_INITIALIZED__; } catch (e) {}
      (window.eval)(src);
      if (window.__RH_SCRIPT_BOOT_OK__ !== true) {
        if (window.console) console.error("[RH bootstrap] " + label + " copy never signalled boot");
        return false;
      }
      window.__RH_LIVE_SOURCE__ = label;
      return true;
    } catch (err) {
      if (window.console) console.error("[RH bootstrap] " + label + " copy threw:", err);
      return false;
    }
  }

  var override = lsGet(KEY_OVERRIDE);
  var cache = lsGet(KEY_CACHE);
  var installed = null;
  if (override && override.trim() && install(override, "override")) installed = override;
  if (!installed && cache && cache.trim() && install(cache, "cache")) installed = cache;

  /* Decide nothing now. After the grace period: if anything reached a full
   * init, refresh the last-good cache; if nothing did, offer the paste panel
   * (top document only — the ComfyUI frame has no room for it). */
  setTimeout(function () {
    if (window.__RH_EXT_INITIALIZED__ === true) {
      if (installed) lsSet(KEY_CACHE, installed);
      return;
    }
    if (isTopDoc()) showFirstRunPanel();
  }, GRACE_MS);


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
