/* ==========================================================================
   bili-open-mcp · 站点交互
   零依赖。主题切换 / 全站搜索 / 代码复制 / 标签页 / 列表筛选 / 目录高亮。
   ========================================================================== */
(function () {
  "use strict";

  var ROOT = window.__ROOT__ || "";
  var doc = document;
  var $ = function (s, r) { return (r || doc).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || doc).querySelectorAll(s)); };

  /* ---------------------------------------------------------------- 主题 */
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  };

  function applyTheme(t) {
    doc.documentElement.setAttribute("data-theme", t);
    var btn = $(".theme-toggle");
    if (btn) {
      btn.textContent = t === "dark" ? "☾" : "☀";
      btn.setAttribute("aria-label", t === "dark" ? "切换到浅色主题" : "切换到深色主题");
      btn.title = t === "dark" ? "浅色主题" : "深色主题";
    }
  }

  (function initTheme() {
    var saved = store.get("bili-theme");
    var prefersLight = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;
    applyTheme(saved || (prefersLight ? "light" : "dark"));
  })();

  function wireTheme() {
    var btn = $(".theme-toggle");
    if (!btn) return;
    btn.addEventListener("click", function () {
      var next = doc.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
      applyTheme(next);
      store.set("bili-theme", next);
    });
  }

  /* -------------------------------------------------------------- 复制 */
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var ta = doc.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      doc.body.appendChild(ta);
      ta.select();
      try { doc.execCommand("copy"); resolve(); } catch (e) { reject(e); }
      doc.body.removeChild(ta);
    });
  }

  function flash(btn, okText, failText) {
    var old = btn.getAttribute("data-label") || btn.textContent;
    btn.setAttribute("data-label", old);
    btn.textContent = okText;
    btn.classList.add("done");
    setTimeout(function () { btn.textContent = old; btn.classList.remove("done"); }, 1400);
  }

  function wireCopy() {
    doc.addEventListener("click", function (e) {
      var btn = e.target.closest && e.target.closest(".code-copy, [data-copy]");
      if (!btn) return;
      e.preventDefault();
      var text = "";
      if (btn.hasAttribute("data-copy")) {
        text = btn.getAttribute("data-copy");
      } else {
        var box = btn.closest(".code");
        var pre = box && $("pre", box);
        text = pre ? pre.innerText : "";
      }
      copyText(text).then(
        function () { flash(btn, "已复制", "复制"); },
        function () { flash(btn, "失败", "复制"); }
      );
    });
  }

  /* ----------------------------------------------------------- 标签页 */
  function wireTabs() {
    $$(".tabs").forEach(function (tabs) {
      var btns = $$(".tab", tabs);
      btns.forEach(function (btn) {
        btn.addEventListener("click", function () {
          var id = btn.getAttribute("aria-controls");
          btns.forEach(function (b) {
            var on = b === btn;
            b.setAttribute("aria-selected", on ? "true" : "false");
            b.tabIndex = on ? 0 : -1;
            var panel = doc.getElementById(b.getAttribute("aria-controls"));
            if (panel) panel.hidden = !on;
          });
          if (id) {
            var p = doc.getElementById(id);
            if (p) p.hidden = false;
          }
        });
      });
    });
  }

  /* ---------------------------------------------------- 列表筛选通用 */
  function normalize(s) {
    return (s || "").toString().toLowerCase();
  }

  function wireFilters() {
    var lists = $$("[data-filter-scope]");
    lists.forEach(function (scope) {
      var input = $("[data-filter-input]", scope);
      var select = $("[data-filter-select]", scope);
      var chips = $$("[data-filter-chip]", scope);
      var items = $$("[data-item]", scope);
      var count = $("[data-filter-count]", scope);
      var empty = $("[data-filter-empty]", scope);
      var activeChip = "all";

      function run() {
        var q = normalize(input ? input.value.trim() : "");
        var sel = select ? normalize(select.value) : "";
        var shown = 0;
        items.forEach(function (it) {
          var hay = normalize(it.getAttribute("data-search") || it.textContent);
          var okQ = !q || hay.indexOf(q) !== -1;
          var okC = activeChip === "all" || (it.getAttribute("data-group") || "") === activeChip;
          var okS = !sel || (it.getAttribute("data-select") || "") === sel;
          var on = okQ && okC && okS;
          it.hidden = !on;
          if (on) shown++;
        });
        if (count) count.textContent = shown + " / " + items.length;
        if (empty) empty.hidden = shown !== 0;
      }

      if (input) input.addEventListener("input", run);
      if (select) select.addEventListener("change", run);
      chips.forEach(function (c) {
        c.addEventListener("click", function () {
          activeChip = c.getAttribute("data-filter-chip");
          chips.forEach(function (x) {
            x.setAttribute("aria-pressed", x === c ? "true" : "false");
          });
          run();
        });
      });
      run();
    });
  }

  /* ------------------------------------------------------------- 搜索 */
  var searchIndex = null;
  var sel = 0;
  var results = [];

  function loadIndex() {
    if (searchIndex) return Promise.resolve(searchIndex);
    return fetch(ROOT + "assets/search-index.json")
      .then(function (r) { return r.json(); })
      .then(function (j) { searchIndex = j; return j; })
      .catch(function () { searchIndex = []; return searchIndex; });
  }

  function score(item, q) {
    var t = normalize(item.t);
    var d = normalize(item.d || "");
    var f = normalize(item.k || "");
    if (t === q) return 1000;
    if (t.indexOf(q) === 0) return 600 - t.length;
    if (t.indexOf(q) !== -1) return 400 - t.length;
    if (d.indexOf(q) !== -1) return 200;
    if (f.indexOf(q) !== -1) return 80;
    // 逐字模糊：query 的字符按顺序出现在 title 里
    var i = 0;
    for (var k = 0; k < t.length && i < q.length; k++) if (t[k] === q[i]) i++;
    if (i === q.length && q.length > 2) return 60;
    return 0;
  }

  function mark(text, q) {
    var safe = String(text).replace(/[&<>]/g, function (c) {
      return c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;";
    });
    if (!q) return safe;
    var idx = normalize(safe).indexOf(q);
    if (idx === -1) return safe;
    return safe.slice(0, idx) + "<mark>" + safe.slice(idx, idx + q.length) + "</mark>" + safe.slice(idx + q.length);
  }

  function renderResults(q) {
    var box = $(".modal-results");
    if (!box) return;
    var ql = normalize(q);
    if (!ql) {
      results = (searchIndex || []).slice(0, 12);
    } else {
      results = (searchIndex || [])
        .map(function (it) { return { it: it, s: score(it, ql) }; })
        .filter(function (x) { return x.s > 0; })
        .sort(function (a, b) { return b.s - a.s; })
        .slice(0, 20)
        .map(function (x) { return x.it; });
    }
    sel = 0;
    if (!results.length) {
      box.innerHTML = '<div class="empty" style="margin:8px">没有匹配结果</div>';
      return;
    }
    box.innerHTML = results.map(function (it, i) {
      return '<a class="sr" href="' + ROOT + it.u + '" data-i="' + i + '" aria-selected="' + (i === 0) + '">' +
        '<span class="sr-kind">' + (it.k || "") + "</span>" +
        '<div class="sr-title">' + mark(it.t, ql) + "</div>" +
        (it.d ? '<div class="sr-desc">' + mark(it.d, ql) + "</div>" : "") +
        "</a>";
    }).join("");
  }

  function moveSel(d) {
    var nodes = $$(".sr");
    if (!nodes.length) return;
    sel = (sel + d + nodes.length) % nodes.length;
    nodes.forEach(function (n, i) { n.setAttribute("aria-selected", i === sel ? "true" : "false"); });
    nodes[sel].scrollIntoView({ block: "nearest" });
  }

  function openSearch() {
    var m = $(".modal");
    if (!m) return;
    m.hidden = false;
    doc.body.style.overflow = "hidden";
    loadIndex().then(function () { renderResults(""); });
    var inp = $(".modal-input");
    if (inp) { inp.value = ""; setTimeout(function () { inp.focus(); }, 20); }
  }

  function closeSearch() {
    var m = $(".modal");
    if (!m) return;
    m.hidden = true;
    doc.body.style.overflow = "";
  }

  function wireSearch() {
    var m = $(".modal");
    if (!m) return;
    var inp = $(".modal-input");
    $$(".search-trigger").forEach(function (b) {
      b.addEventListener("click", function (e) { e.preventDefault(); openSearch(); });
    });
    m.addEventListener("mousedown", function (e) { if (e.target === m) closeSearch(); });
    var closeBtn = $(".modal-close");
    if (closeBtn) closeBtn.addEventListener("click", closeSearch);
    if (inp) inp.addEventListener("input", function () { renderResults(inp.value.trim()); });

    doc.addEventListener("keydown", function (e) {
      var isOpen = !m.hidden;
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault(); isOpen ? closeSearch() : openSearch(); return;
      }
      if (e.key === "/" && !isOpen) {
        var tag = (e.target.tagName || "").toLowerCase();
        if (tag === "input" || tag === "textarea" || tag === "select") return;
        e.preventDefault(); openSearch(); return;
      }
      if (!isOpen) return;
      if (e.key === "Escape") { e.preventDefault(); closeSearch(); }
      else if (e.key === "ArrowDown") { e.preventDefault(); moveSel(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); moveSel(-1); }
      else if (e.key === "Enter") {
        e.preventDefault();
        if (results[sel]) window.location.href = ROOT + results[sel].u;
      }
    });
  }

  /* --------------------------------------------------- 侧边栏 / 移动端 */
  function wireSidebar() {
    var sidebar = $(".sidebar");
    var scrim = $(".scrim");
    var btn = $(".menu-btn");
    if (!btn || !sidebar) return;

    var scrimEl = scrim;
    if (!scrimEl) {
      scrimEl = doc.createElement("div");
      scrimEl.className = "scrim";
      scrimEl.hidden = true;
      doc.body.appendChild(scrimEl);
    }
    function toggle(open) {
      sidebar.classList.toggle("open", open);
      scrimEl.hidden = !open;
      doc.body.style.overflow = open ? "hidden" : "";
    }
    btn.addEventListener("click", function () { toggle(!sidebar.classList.contains("open")); });
    scrimEl.addEventListener("click", function () { toggle(false); });
    doc.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && sidebar.classList.contains("open")) toggle(false);
    });
  }

  /* ------------------------------------------- 目录高亮 / 进度 / 回顶 */
  function wireToc() {
    var links = $$(".toc a, .sidebar a[href^='#']");
    if (!links.length) return;
    var targets = links.map(function (a) {
      var id = decodeURIComponent(a.getAttribute("href").slice(1));
      return { a: a, el: doc.getElementById(id) };
    }).filter(function (x) { return x.el; });
    if (!targets.length) return;

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        targets.forEach(function (t) {
          if (t.el === en.target) t.a.classList.add("is-active");
          else t.a.classList.remove("is-active");
        });
      });
    }, { rootMargin: "-72px 0px -75% 0px", threshold: 0 });
    targets.forEach(function (t) { io.observe(t.el); });
  }

  function wireScroll() {
    var bar = $(".progress");
    var top = $(".to-top");
    function onScroll() {
      var h = doc.documentElement.scrollHeight - window.innerHeight;
      var p = h > 0 ? (window.scrollY / h) * 100 : 0;
      if (bar) bar.style.width = p + "%";
      if (top) top.classList.toggle("show", window.scrollY > 600);
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    if (top) top.addEventListener("click", function () {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  /* 侧边栏「开放能力 · N 个接口」里的模块链接形如 endpoints.html#直播能力。
     落到列表页后要把这个模块的筛选取上，否则页面只是停在原地 —— 看上去像"点了没反应"。 */
  function wireHashFilter() {
    var scope = $("[data-filter-scope]");
    if (!scope) return;
    function apply() {
      var raw = location.hash.slice(1);
      if (!raw) return;
      var key;
      try { key = decodeURIComponent(raw); } catch (e) { key = raw; }
      var chip = doc.getElementById(key);
      if (!chip || !scope.contains(chip) || !chip.hasAttribute("data-filter-chip")) return;
      chip.click();
      chip.classList.add("is-target");
      setTimeout(function () { chip.classList.remove("is-target"); }, 1200);
      chip.scrollIntoView({ block: "center", behavior: "smooth" });
    }
    window.addEventListener("hashchange", apply);
    apply();
  }

  /* ------------------------------------------------------------ 启动 */
  function boot() {
    wireTheme();
    wireCopy();
    wireTabs();
    wireFilters();
    wireHashFilter();
    wireSearch();
    wireSidebar();
    wireToc();
    wireScroll();
  }

  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
