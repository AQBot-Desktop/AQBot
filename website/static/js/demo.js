/* Home page app preview: scene tabs, streamed answers, agent approval and
   gateway log. Runs only when the preview exists on the page. */
(function () {
  "use strict";

  var AQ = window.AQ;
  var demo = AQ && AQ.$("[data-demo]");
  if (!demo) return;
  var $ = AQ.$, $$ = AQ.$$;
  var INTERVAL = 9000;
  var timers = [];
  var autoTimer = null;
  var userTook = false;
  var inView = true;
  var hovering = false;

  function later(fn, ms) { var id = setTimeout(fn, ms); timers.push(id); return id; }
  function clearTimers() { timers.forEach(clearTimeout); timers = []; }

  /* Stream text into elements word by word (or per character for CJK). */
  function stream(el, delay) {
    var full = el.dataset.full || el.textContent;
    el.dataset.full = full;
    if (AQ.reduceMotion) { el.textContent = full; return; }
    var cjk = /[぀-ヿ㐀-鿿가-힯]/.test(full);
    var parts = cjk ? Array.from(full) : full.split(/(\s+)/);
    var i = 0;
    el.textContent = "";
    el.classList.add("is-streaming");
    function tick() {
      if (i >= parts.length) { el.classList.remove("is-streaming"); return; }
      el.textContent += parts[i++];
      later(tick, cjk ? 28 : 45);
    }
    later(tick, delay || 0);
  }

  /* ── Scenes ─────────────────────────────────────────────────────── */

  var scenes = {
    chat: function (panel) {
      $$("[data-stream]", panel).forEach(function (el, i) { stream(el, 350 + i * 250); });
    },
    agent: function (panel) {
      var step = $("[data-agent-step]", panel);
      var state = $("[data-agent-state]", panel);
      var permission = $("[data-agent-permission]", panel);
      var output = $("[data-agent-output]", panel);
      var done = $("[data-agent-done]", panel);
      var denied = $("[data-agent-denied]", panel);
      var reset = $("[data-agent-reset]", panel);
      step.className = "step is-pending";
      state.innerHTML = "";
      permission.hidden = false;
      output.hidden = true;
      done.hidden = true;
      denied.hidden = true;
      reset.hidden = true;
      if (!panel._wired) {
        panel._wired = true;
        $$("[data-agent-choice]", panel).forEach(function (btn) {
          btn.addEventListener("click", function () {
            stopAuto();
            permission.hidden = true;
            if (btn.dataset.agentChoice === "deny") {
              step.className = "step is-denied";
              state.textContent = "×";
              denied.hidden = false;
            } else {
              output.hidden = false;
              later(function () {
                step.className = "step is-done";
                state.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
                done.hidden = false;
              }, AQ.reduceMotion ? 0 : 700);
            }
            later(function () { reset.hidden = false; }, 900);
          });
        });
        reset.addEventListener("click", function () { scenes.agent(panel); });
      }
      // While auto-playing, approve on the visitor's behalf after a pause.
      if (demo.classList.contains("is-auto")) {
        later(function () {
          if (!permission.hidden && demo.classList.contains("is-auto")) $('[data-agent-choice="once"]', panel).click();
          demo.classList.add("is-auto");
          scheduleAuto();
        }, 3600);
      }
    },
    knowledge: function (panel) {
      $$("[data-stream]", panel).forEach(function (el) { stream(el, 900); });
    },
    gateway: function (panel) {
      var body = $("[data-gw-log] tbody", panel);
      var count = $("[data-gw-count]", panel);
      var rows = [
        ["claude-code", "claude-sonnet", "1.1s"],
        ["opencode", "deepseek-chat", "0.8s"],
        ["codex", "gpt-5.5", "1.3s"],
        ["cursor", "qwen-plus", "0.7s"],
        ["gemini-cli", "gemini-pro", "1.0s"],
      ];
      var n = 0;
      function addRow() {
        var r = rows[n++ % rows.length];
        var tr = document.createElement("tr");
        tr.className = "is-new";
        r.forEach(function (v, i) {
          var td = document.createElement("td");
          td.textContent = v;
          tr.appendChild(td);
          if (i === 1) {
            var ok = document.createElement("td");
            ok.className = "ok";
            ok.textContent = "200";
            tr.appendChild(ok);
          }
        });
        body.insertBefore(tr, body.firstChild);
        while (body.children.length > 4) body.removeChild(body.lastChild);
        count.textContent = String(parseInt(count.textContent, 10) + 1);
        if (!AQ.reduceMotion) later(addRow, 1600);
      }
      later(addRow, 600);
    },
  };

  var ids = Object.keys(scenes);
  var ctl = AQ.initTabs(demo, {
    tab: "[data-demo-tab]",
    onChange: function (index, tab, panel) {
      clearTimers();
      var id = tab.dataset.demoTab;
      $$("[data-rail]", demo).forEach(function (r) { r.classList.toggle("is-active", r.dataset.rail === id); });
      $$("[data-session]", demo).forEach(function (s) { s.classList.toggle("is-active", s.dataset.session === id); });
      scenes[id](panel);
      scheduleAuto();
    },
    onUser: function () { userTook = true; stopAuto(); },
  });

  /* ── Auto-advance until the visitor interacts ───────────────────── */

  function current() { return ctl.tabs.findIndex(function (t) { return t.getAttribute("aria-selected") === "true"; }); }
  function stopAuto() {
    demo.classList.remove("is-auto");
    clearTimeout(autoTimer);
  }
  function scheduleAuto() {
    clearTimeout(autoTimer);
    if (userTook || AQ.reduceMotion) return;
    demo.classList.add("is-auto");
    demo.style.setProperty("--demo-interval", INTERVAL + "ms");
    // Restart the CSS progress animation.
    var active = ctl.tabs[current()];
    active.style.animation = "none";
    void active.offsetWidth;
    active.style.animation = "";
    autoTimer = setTimeout(function tickAuto() {
      if (!inView || hovering || document.hidden) { autoTimer = setTimeout(tickAuto, 800); return; }
      ctl.select((current() + 1) % ids.length, false);
    }, INTERVAL);
  }
  demo.addEventListener("mouseenter", function () { hovering = true; demo.classList.add("is-paused"); });
  demo.addEventListener("mouseleave", function () { hovering = false; demo.classList.remove("is-paused"); });
  demo.addEventListener("focusin", function () { hovering = true; demo.classList.add("is-paused"); });
  demo.addEventListener("focusout", function () { hovering = false; demo.classList.remove("is-paused"); });
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(function (entries) {
      inView = entries[0].isIntersecting;
      demo.classList.toggle("is-paused", !inView || hovering);
    }).observe(demo);
  }

  ctl.select(0, false);
})();
