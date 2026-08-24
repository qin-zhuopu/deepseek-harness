// fit-resize — keep the Xvnc desktop matched to this viewport (debounced).
//
// Installed next to noVNC's vnc.html by the aio entrypoint and referenced
// from it via <script src="fit-resize.js">. noVNC itself runs resize=scale
// (smooth, never flickers); this script is the single writer of the desktop
// size: on load and after viewport changes settle for 250ms it asks the
// vnc-resize-sidecar (same host, port 6081) to set the Xvnc desktop to
// exactly this viewport, so the scaled picture fills the frame with no
// letterboxing. Only one viewer should be open at a time.
window.__fitResizeRan = 1;
(function () {
  // Hide noVNC's collapsed left-edge control bar (connection/settings/expand
  // tabs) — the preview column doesn't need it and it eats frame width.
  try {
    var st = document.createElement('style');
    st.textContent = '#noVNC_control_bar_anchor{display:none !important}';
    document.head.appendChild(st);
  } catch (e) { /* cosmetic only */ }
  var t = null;
  function go() {
    t = null;
    try {
      var w = Math.max(200, Math.floor(window.innerWidth));
      var h = Math.max(200, Math.floor(window.innerHeight));
      fetch('http://' + location.hostname + ':6081/resize?w=' + w + '&h=' + h,
            { mode: 'no-cors' }).catch(function () {});
    } catch (e) { /* never break noVNC */ }
  }
  function ping() { clearTimeout(t); t = setTimeout(go, 250); }
  window.addEventListener('resize', ping);
  window.addEventListener('load', ping);
  ping();
})();
