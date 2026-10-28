/* AQBot website interactions. No dependencies; every feature degrades to
   plain HTML when this file fails to load. */
(function () {
  "use strict";

  var root = document.documentElement;
  var DATA = {};
  try { DATA = JSON.parse(document.getElementById("aq-data").textContent); } catch (e) { DATA = {}; }
  var S = DATA.strings || {};
  var isRTL = root.dir === "rtl";
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function $(sel, ctx) { return (ctx || document).querySelector(sel); }
  function $$(sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); }
  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, value);
    } catch (e) { return null; }
  }
  window.AQ = { $: $, $$: $$, reduceMotion: reduceMotion, isRTL: isRTL, data: DATA };

  /* ── Theme: auto / light / dark ─────────────────────────────────── */

  var media = window.matchMedia("(prefers-color-scheme: dark)");
  function applyTheme(pref) {
    var dark = pref === "dark" || (pref === "auto" && media.matches);
    root.dataset.theme = dark ? "dark" : "light";
    root.dataset.themePref = pref;
    $$("[data-theme-value]").forEach(function (btn) {
      btn.setAttribute("aria-checked", String(btn.dataset.themeValue === pref));
      btn.tabIndex = btn.dataset.themeValue === pref ? 0 : -1;
    });
  }
  applyTheme(root.dataset.themePref || "auto");
  $$("[data-theme-switch]").forEach(function (group) {
    var buttons = $$("[data-theme-value]", group);
    buttons.forEach(function (btn, i) {
      btn.addEventListener("click", function () {
        store("aq-theme", btn.dataset.themeValue);
        applyTheme(btn.dataset.themeValue);
      });
      btn.addEventListener("keydown", function (e) {
        var step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
        if (!step) return;
        if (isRTL && (e.key === "ArrowRight" || e.key === "ArrowLeft")) step = -step;
        e.preventDefault();
        var next = buttons[(i + step + buttons.length) % buttons.length];
        next.click();
        next.focus();
      });
    });
  });
  media.addEventListener("change", function () {
    if ((root.dataset.themePref || "auto") === "auto") applyTheme("auto");
  });

  /* ── Header: scrolled state + mobile menu ───────────────────────── */

  var header = $("[data-header]");
  function onScroll() { if (header) header.classList.toggle("is-scrolled", window.scrollY > 4); }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  var toggle = $("[data-menu-toggle]");
  var mobileNav = $("[data-mobile-nav]");
  function setMenu(open) {
    if (!toggle || !mobileNav) return;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? toggle.dataset.labelClose : toggle.dataset.labelOpen);
    mobileNav.hidden = !open;
    header.classList.toggle("is-open", open);
    document.body.style.overflow = open ? "hidden" : "";
  }
  if (toggle) {
    toggle.addEventListener("click", function () { setMenu(toggle.getAttribute("aria-expanded") !== "true"); });
    window.addEventListener("resize", function () { if (window.innerWidth > 900) setMenu(false); });
  }

  /* ── Popovers built on <details> ────────────────────────────────── */

  $$("[data-popover]").forEach(function (details) {
    document.addEventListener("click", function (e) {
      if (details.open && !details.contains(e.target)) details.open = false;
    });
    details.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && details.open) {
        details.open = false;
        $("summary", details).focus();
      }
    });
  });

  /* Remember an explicit language choice so the suggestion banner stays quiet. */
  $$("[data-lang-link]").forEach(function (a) {
    a.addEventListener("click", function () { store("aq-lang", a.dataset.langLink); });
  });

  /* ── Language suggestion banner (never redirects) ───────────────── */

  function matchLocale(tag) {
    tag = (tag || "").toLowerCase();
    if (/^zh-(tw|hk|mo)|^zh-hant/.test(tag)) return "zh-tw";
    var base = tag.split("-")[0];
    var codes = Object.keys(DATA.banner || {});
    return codes.indexOf(base) >= 0 ? base : null;
  }
  (function suggestLanguage() {
    var banner = $("[data-lang-banner]");
    if (!banner || !DATA.banner || store("aq-lang") || store("aq-lang-dismissed")) return;
    var langs = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language];
    var target = null;
    for (var i = 0; i < langs.length && !target; i++) target = matchLocale(langs[i]);
    if (!target || target === DATA.locale) return;
    var info = DATA.banner[target];
    var link = $('link[rel="alternate"][hreflang="' + info.hreflang + '"]');
    if (!link) return;
    banner.lang = info.hreflang;
    banner.dir = info.dir;
    $("[data-lang-banner-text]", banner).textContent = info.text;
    var go = $("[data-lang-banner-go]", banner);
    go.textContent = info.action;
    go.href = new URL(link.href).pathname + location.hash;
    go.addEventListener("click", function () { store("aq-lang", target); });
    var dismiss = $("[data-lang-banner-dismiss]", banner);
    dismiss.textContent = info.dismiss;
    dismiss.addEventListener("click", function () { store("aq-lang-dismissed", "1"); banner.hidden = true; });
    setTimeout(function () { banner.hidden = false; }, 900);
  })();

  /* ── Platform detection for download buttons ────────────────────── */

  function detectPlatform() {
    var ua = navigator.userAgent;
    var platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
    var os = null;
    if (/Android|iPhone|iPad|iPod/i.test(ua)) os = null;
    else if (/Win/i.test(platform) || /Windows/i.test(ua)) os = "windows";
    else if (/Mac/i.test(platform) || /Macintosh/i.test(ua)) os = "macos";
    else if (/Linux/i.test(platform) || /Linux|X11/i.test(ua)) os = "linux";
    var guess = { os: os, arch: "x64" };
    if (os === "macos") {
      guess.arch = "arm64";
      try {
        var gl = document.createElement("canvas").getContext("webgl");
        var ext = gl && gl.getExtension("WEBGL_debug_renderer_info");
        var renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "";
        if (/Intel|AMD|Radeon/i.test(renderer)) guess.arch = "x64";
      } catch (e) { /* keep Apple Silicon default */ }
    }
    if (os === "linux" && /aarch64|arm64/i.test(ua)) guess.arch = "arm64";
    if (os === "windows" && /ARM64|aarch64/i.test(ua)) guess.arch = "arm64";
    var hints = navigator.userAgentData && navigator.userAgentData.getHighEntropyValues
      ? navigator.userAgentData.getHighEntropyValues(["architecture", "bitness"]).then(function (v) {
          if (os !== "macos" && v.architecture === "arm") guess.arch = "arm64";
          if (os === "macos" && v.architecture === "x86") guess.arch = "x64";
          return guess;
        }).catch(function () { return guess; })
      : Promise.resolve(guess);
    return hints;
  }

  function preferredAsset(p) {
    if (!p.os || !DATA.assets) return null;
    var order = {
      macos: ["mac-" + p.arch, "mac-arm64", "mac-x64"],
      windows: ["win-" + p.arch + "-setup", "win-x64-setup"],
      linux: ["linux-" + p.arch + "-appimage", "linux-" + p.arch + "-deb", "linux-x64-appimage"],
    }[p.os];
    for (var i = 0; i < order.length; i++) if (DATA.assets[order[i]]) return DATA.assets[order[i]];
    return null;
  }

  detectPlatform().then(function (p) {
    var asset = preferredAsset(p);
    if (!asset) return;
    var osName = (S.os || {})[p.os] || p.os;
    $$("[data-smart-download]").forEach(function (btn) {
      btn.href = asset.url;
      btn.setAttribute("rel", "nofollow");
      var text = $("[data-smart-download-text]", btn);
      if (text) text.textContent = (S.ctaOs || "{os}").replace("{os}", osName);
      btn.title = asset.name;
    });
    var rec = $("[data-recommend]");
    if (rec) {
      $("[data-recommend-label]", rec).textContent = (S.detected || "{os}").replace("{os}", osName);
      $("[data-recommend-link]", rec).href = asset.url;
      $("[data-recommend-text]", rec).textContent = asset.label;
      $("[data-recommend-file]", rec).textContent = asset.name;
      $("[data-recommend-size]", rec).textContent = asset.size || "";
      rec.hidden = false;
    }
    window.dispatchEvent(new CustomEvent("aq:platform", { detail: p }));
  });

  /* ── Generic accessible tabs ────────────────────────────────────── */

  function initTabs(container, opts) {
    var tabs = $$(opts.tab, container);
    var panels = tabs.map(function (t) { return document.getElementById(t.getAttribute("aria-controls")); });
    var vertical = opts.vertical;
    function select(index, focus) {
      tabs.forEach(function (t, i) {
        var on = i === index;
        t.setAttribute("aria-selected", String(on));
        t.tabIndex = on ? 0 : -1;
        if (panels[i]) {
          if (opts.activeClass) panels[i].classList.toggle(opts.activeClass, on);
          else panels[i].hidden = !on;
        }
      });
      if (focus) tabs[index].focus();
      if (opts.onChange) opts.onChange(index, tabs[index], panels[index]);
    }
    tabs.forEach(function (t, i) {
      t.addEventListener("click", function () { select(i, false); if (opts.onUser) opts.onUser(i); });
      t.addEventListener("keydown", function (e) {
        var keys = vertical ? { ArrowDown: 1, ArrowUp: -1 } : { ArrowRight: 1, ArrowLeft: -1 };
        var step = keys[e.key];
        if (e.key === "Home") step = -i;
        if (e.key === "End") step = tabs.length - 1 - i;
        if (step === undefined) return;
        if (!vertical && isRTL && (e.key === "ArrowRight" || e.key === "ArrowLeft")) step = -step;
        e.preventDefault();
        var next = (i + step + tabs.length) % tabs.length;
        select(next, true);
        if (opts.onUser) opts.onUser(next);
      });
    });
    return { select: select, tabs: tabs, panels: panels };
  }
  window.AQ.initTabs = initTabs;

  $$("[data-code-tabs]").forEach(function (c) { initTabs(c, { tab: "[data-code-tab]" }); });

  var osTabs = $("[data-os-tabs]");
  if (osTabs) {
    var osCtl = initTabs(osTabs, { tab: "[data-os-tab]", activeClass: "is-active" });
    osCtl.select(0, false);
    window.addEventListener("aq:platform", function (e) {
      var idx = osCtl.tabs.findIndex(function (t) { return t.dataset.osTab === e.detail.os; });
      if (idx >= 0) osCtl.select(idx, false);
    });
  }

  /* ── Gallery + lightbox ─────────────────────────────────────────── */

  var lightbox = $("[data-lightbox]");
  var items = [];
  var current = 0;
  if (lightbox) {
    try { items = JSON.parse($("[data-lightbox-items]", lightbox).textContent); } catch (e) { items = []; }
  }
  function show(index) {
    if (!items.length) return;
    current = (index + items.length) % items.length;
    var img = $("[data-lightbox-img]", lightbox);
    img.src = items[current].src;
    img.alt = items[current].caption;
    $("[data-lightbox-caption]", lightbox).textContent = items[current].caption + "  ·  " + (current + 1) + " / " + items.length;
  }
  function openLightbox(index, opener) {
    if (!lightbox || typeof lightbox.showModal !== "function") return;
    show(index);
    lightbox._opener = opener;
    lightbox.showModal();
  }
  if (lightbox) {
    $("[data-lightbox-close]", lightbox).addEventListener("click", function () { lightbox.close(); });
    $("[data-lightbox-prev]", lightbox).addEventListener("click", function () { show(current - 1); });
    $("[data-lightbox-next]", lightbox).addEventListener("click", function () { show(current + 1); });
    lightbox.addEventListener("click", function (e) { if (e.target === lightbox || e.target.classList.contains("lightbox-inner")) lightbox.close(); });
    lightbox.addEventListener("keydown", function (e) {
      if (e.key === "ArrowRight") show(current + (isRTL ? -1 : 1));
      if (e.key === "ArrowLeft") show(current + (isRTL ? 1 : -1));
    });
    lightbox.addEventListener("close", function () { if (lightbox._opener) lightbox._opener.focus(); });
    var touchX = null;
    lightbox.addEventListener("touchstart", function (e) { touchX = e.touches[0].clientX; }, { passive: true });
    lightbox.addEventListener("touchend", function (e) {
      if (touchX === null) return;
      var dx = e.changedTouches[0].clientX - touchX;
      if (Math.abs(dx) > 50) show(current + ((dx < 0) !== isRTL ? 1 : -1));
      touchX = null;
    });
  }
  $$("[data-lightbox-open]").forEach(function (btn) {
    btn.addEventListener("click", function () { openLightbox(parseInt(btn.dataset.lightboxOpen, 10), btn); });
  });
  $$("[data-gallery]").forEach(function (g) {
    initTabs(g, { tab: "[data-gallery-tab]", vertical: window.matchMedia("(min-width: 901px)").matches });
  });

  /* ── Copy buttons for code blocks ───────────────────────────────── */

  var COPY_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
  var CHECK_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
  $$(".code").forEach(function (block) {
    var bar = $(".code-bar", block);
    var code = $("pre code", block);
    if (!bar || !code || !navigator.clipboard) return;
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "copy-btn";
    btn.innerHTML = COPY_ICON + "<span>" + (S.copy || "Copy") + "</span>";
    btn.addEventListener("click", function () {
      navigator.clipboard.writeText(code.innerText.replace(/\n$/, "")).then(function () {
        btn.classList.add("is-copied");
        btn.innerHTML = CHECK_ICON + "<span>" + (S.copied || "Copied") + "</span>";
        setTimeout(function () {
          btn.classList.remove("is-copied");
          btn.innerHTML = COPY_ICON + "<span>" + (S.copy || "Copy") + "</span>";
        }, 1600);
      });
    });
    bar.appendChild(btn);
  });

  /* ── Scrollspy for tables of contents ───────────────────────────── */

  $$("[data-scrollspy]").forEach(function (nav) {
    var links = $$('a[href^="#"]', nav);
    var targets = links.map(function (a) { return document.getElementById(decodeURIComponent(a.hash.slice(1))); }).filter(Boolean);
    if (!targets.length || !("IntersectionObserver" in window)) return;
    var visible = new Map();
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { visible.set(en.target.id, en.isIntersecting); });
      var active = null;
      for (var i = 0; i < targets.length; i++) if (visible.get(targets[i].id)) { active = targets[i].id; break; }
      if (!active) return;
      links.forEach(function (a) { a.classList.toggle("is-active", decodeURIComponent(a.hash.slice(1)) === active); });
    }, { rootMargin: "-80px 0px -60% 0px" });
    targets.forEach(function (t) { io.observe(t); });
  });

  /* ── Reveal on scroll ───────────────────────────────────────────── */

  var reveals = $$(".reveal");
  if (reduceMotion || !("IntersectionObserver" in window)) {
    reveals.forEach(function (el) { el.classList.add("is-visible"); });
  } else {
    var ro = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        en.target.classList.add("is-visible");
        ro.unobserve(en.target);
      });
    }, { rootMargin: "0px 0px -8% 0px" });
    reveals.forEach(function (el, i) {
      el.style.transitionDelay = Math.min(i % 3, 2) * 70 + "ms";
      ro.observe(el);
    });
  }
})();
