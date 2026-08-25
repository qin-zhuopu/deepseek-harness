// fit-resize — keep the Xvnc desktop matched to this viewport (debounced).
//
// Installed next to noVNC's vnc.html by the aio entrypoint and referenced
// from it via <script src="fit-resize.js">. noVNC itself runs resize=scale
// (smooth, never flickers); this script is the single writer of the desktop
// size: on load and after viewport changes settle for 250ms it asks the
// vnc-resize-sidecar to set the Xvnc desktop to exactly this viewport, so
// the scaled picture fills the frame with no letterboxing. Only one viewer
// should be open at a time.
//
// The sidecar endpoint is configurable: the entrypoint generates
// vnc-config.js (loaded just before this script) setting
// window.__DSH_RESIZE_ENDPOINT__ when RESIZE_ENDPOINT is given, which is what
// a reverse-proxy deployment needs — the browser cannot reach the container's
// port 6081 directly, so the proxy exposes it as a same-origin path. Without
// that global the endpoint falls back to this page's host on port 6081, the
// direct-port-publishing default.
window.__fitResizeRan = 1;
(function () {
  // Hide noVNC's collapsed left-edge control bar (connection/settings/expand
  // tabs) — the preview column doesn't need it and it eats frame width.
  try {
    var st = document.createElement('style');
    st.textContent = '#noVNC_control_bar_anchor{display:none !important}';
    document.head.appendChild(st);
  } catch (e) { /* cosmetic only */ }
  // Configured endpoint (absolute URL or same-origin path) or the direct
  // port-6081 default on this page's host.
  function endpoint() {
    var configured = window.__DSH_RESIZE_ENDPOINT__;
    if (typeof configured === 'string' && configured.length > 0) return configured;
    return 'http://' + location.hostname + ':6081/resize';
  }
  var t = null;
  function go() {
    t = null;
    try {
      var w = Math.max(200, Math.floor(window.innerWidth));
      var h = Math.max(200, Math.floor(window.innerHeight));
      var base = endpoint();
      fetch(base + (base.indexOf('?') >= 0 ? '&' : '?') + 'w=' + w + '&h=' + h,
            { mode: 'no-cors' }).catch(function () {});
    } catch (e) { /* never break noVNC */ }
  }
  function ping() { clearTimeout(t); t = setTimeout(go, 250); }
  window.addEventListener('resize', ping);
  window.addEventListener('load', ping);
  ping();
})();
