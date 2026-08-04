/**
 * TON product site — install picker, copy, tabs, mobile menu, i18n (en/zh).
 * Default locale: English. Preference persisted in localStorage.
 */

(() => {
  "use strict";

  const STORAGE_KEY = "ton-web-lang";

  // —— i18n dictionaries ——
  // Keys mirror data-i18n / data-i18n-html / data-i18n-aria-label / data-i18n-title / data-i18n-content
  const I18N = {
    en: {
      "meta.title": "TON — AI Engineering Session",
      "meta.description":
        "Local TUI for auditable coding-agent sessions. Clarify → Plan → Execute → Verify ⇄ Repair → Summarize.",
      "nav.docs": "Docs",
      "nav.menu": "Menu",
      "nav.install": "Install",
      "nav.loop": "Loop",
      "lang.aria": "Language",
      "banner.aria": "Announcement",
      "banner.text": "v1.0 · open source · MIT",
      "banner.cta": "Install",
      "hero.eyebrow": "Local · auditable · unattended",
      "hero.subtitle": "Local TUI for auditable coding-agent sessions.",
      "install.go": "Go (add PATH)",
      "install.curl": "Linux / macOS",
      "install.ps1": "Windows",
      "install.build": "From source",
      "install.setup": "Configure LLM key",
      "install.copy": "Copy",
      "cta.start": "Install",
      "cta.guide": "Guide",
      "features.title": "One loop. Many drivers.",
      "terminal.aria": "TON TUI preview",
      "terminal.phase": "Clarify",
      "terminal.you1": "Build a static login page with dark mode",
      "terminal.ton1":
        "Got it — static HTML/CSS login with prefers-color-scheme. Light or dark default?",
      "terminal.oq": "Open questions (defaults on /start)",
      "terminal.oq1": "- Which page opens after login?",
      "drivers.body":
        "One state machine; swap backends. <code>fake</code> for CI; OpenCode / Claude / Cursor for real runs.",
      "drivers.opencode": "Default · local headless",
      "drivers.claude": "Claude CLI · long context",
      "drivers.cursor": "Cursor CLI · IDE bridge",
      "loop.title": "One closed loop",
      "loop.sub": "Gates when needed. Agent runs locally. Everything persisted.",
      "loop.clarify": "Goals & constraints",
      "loop.ready": "Confirm",
      "loop.plan": "Milestones",
      "loop.execute": "Unattended",
      "loop.verify": "Accept",
      "loop.repair": "Repair",
      "loop.summarize": "Summary",
      "footer.tag": "Local TUI · auditable agent sessions.",
      "footer.product": "Product",
      "footer.resources": "Resources",
      "footer.config": "Config",
      "footer.commands": "Commands",
    },
    zh: {
      "meta.title": "TON — AI Engineering Session",
      "meta.description":
        "本地 TUI，编排可审计的 coding-agent 会话。Clarify → Plan → Execute → Verify ⇄ Repair → Summarize。",
      "nav.docs": "文档",
      "nav.menu": "菜单",
      "nav.install": "安装",
      "nav.loop": "闭环",
      "lang.aria": "语言",
      "banner.aria": "公告",
      "banner.text": "v1.0 · 开源 · MIT",
      "banner.cta": "安装",
      "hero.eyebrow": "本地 · 可审计 · 无人值守",
      "hero.subtitle": "本地 TUI，编排可审计的 coding-agent 会话。",
      "install.go": "Go（加 PATH）",
      "install.curl": "Linux / macOS",
      "install.ps1": "Windows",
      "install.build": "源码安装",
      "install.setup": "配置 LLM Key",
      "install.copy": "复制",
      "cta.start": "安装",
      "cta.guide": "指南",
      "features.title": "一套闭环，多种驱动",
      "terminal.aria": "TON TUI 预览",
      "terminal.phase": "Clarify",
      "terminal.you1": "做一个带暗色模式的静态登录页",
      "terminal.ton1": "收到 — 静态 HTML/CSS 登录页，支持 prefers-color-scheme。默认亮色还是暗色？",
      "terminal.oq": "Open questions（/start 时用默认值）",
      "terminal.oq1": "- 登录成功后打开哪一页？",
      "drivers.body":
        "一套状态机，后端可换。CI 用 <code>fake</code>；实战接 OpenCode / Claude / Cursor。",
      "drivers.opencode": "默认 · 本地 headless",
      "drivers.claude": "Claude CLI · 长上下文",
      "drivers.cursor": "Cursor CLI · IDE 衔接",
      "loop.title": "同一条闭环",
      "loop.sub": "闸门按需介入。Agent 本地跑完。全程落盘。",
      "loop.clarify": "目标与约束",
      "loop.ready": "确认",
      "loop.plan": "里程碑",
      "loop.execute": "无人值守",
      "loop.verify": "验收",
      "loop.repair": "修复",
      "loop.summarize": "摘要",
      "footer.tag": "本地 TUI · 可审计 agent 会话。",
      "footer.product": "产品",
      "footer.resources": "资源",
      "footer.config": "配置",
      "footer.commands": "命令",
    },
  };

  const COMMANDS = {
    curl: "curl -fsSL https://raw.githubusercontent.com/toninfo/ton/main/install.sh | bash",
    ps1: "irm https://raw.githubusercontent.com/toninfo/ton/main/install.ps1 | iex",
    go: "go install github.com/toninfo/ton/cmd/ton@latest && export PATH=\"$(go env GOPATH)/bin:$PATH\"",
    build: "git clone https://github.com/toninfo/ton.git && cd ton && make install",
    setup: "ton setup --api-key <YOUR_KEY>",
  };

  let currentLang = "en";
  let currentCmd = "curl";

  function t(key) {
    return I18N[currentLang]?.[key] ?? I18N.en[key] ?? key;
  }

  function installLabel(key) {
    return t(`install.${key}`);
  }

  /** Apply dictionary to all marked nodes; keep install picker label in sync. */
  function applyI18n(lang) {
    if (!I18N[lang]) return;
    currentLang = lang;
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";

    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.getAttribute("data-i18n");
      const val = t(key);
      if (val != null) el.textContent = val;
    });

    document.querySelectorAll("[data-i18n-html]").forEach((el) => {
      const key = el.getAttribute("data-i18n-html");
      const val = t(key);
      if (val != null) el.innerHTML = val;
    });

    document.querySelectorAll("[data-i18n-aria-label]").forEach((el) => {
      const key = el.getAttribute("data-i18n-aria-label");
      const val = t(key);
      if (val != null) el.setAttribute("aria-label", val);
    });

    document.querySelectorAll("[data-i18n-title]").forEach((el) => {
      const key = el.getAttribute("data-i18n-title");
      const val = t(key);
      if (val != null) el.setAttribute("title", val);
    });

    document.querySelectorAll("[data-i18n-content]").forEach((el) => {
      const key = el.getAttribute("data-i18n-content");
      const val = t(key);
      if (val != null) el.setAttribute("content", val);
    });

    // <title> may use data-i18n; also set document.title explicitly
    document.title = t("meta.title");

    // Lang menu checkmarks
    document.querySelectorAll("#langMenu [data-lang]").forEach((btn) => {
      const on = btn.dataset.lang === lang;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });

    // Re-sync install select label after locale swap
    if (labelEl) labelEl.textContent = installLabel(currentCmd);
    menu?.querySelectorAll("button[data-cmd]").forEach((b) => {
      const k = b.dataset.cmd;
      b.textContent = installLabel(k);
      b.classList.toggle("active", k === currentCmd);
    });

    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      /* private mode / blocked storage — ignore */
    }
  }

  // —— Install select ——
  const selectBtn = document.getElementById("installSelect");
  const menu = document.getElementById("installMenu");
  const labelEl = document.getElementById("installLabel");
  const commandEl = document.getElementById("commandText");
  const copyBtn = document.getElementById("copyBtn");

  function setCommand(key) {
    if (!COMMANDS[key]) return;
    currentCmd = key;
    if (commandEl) commandEl.textContent = COMMANDS[key];
    if (labelEl) labelEl.textContent = installLabel(key);
    menu?.querySelectorAll("button[data-cmd]").forEach((b) => {
      b.classList.toggle("active", b.dataset.cmd === key);
    });
  }

  selectBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    closeLangMenu();
    const open = menu?.classList.toggle("open");
    if (menu) menu.hidden = !open;
    selectBtn.setAttribute("aria-expanded", open ? "true" : "false");
  });

  menu?.querySelectorAll("button[data-cmd]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      setCommand(btn.dataset.cmd);
      menu.classList.remove("open");
      menu.hidden = true;
      selectBtn?.setAttribute("aria-expanded", "false");
    });
  });

  async function copyText(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    if (btn) {
      btn.classList.add("copied");
      setTimeout(() => btn.classList.remove("copied"), 1200);
    }
  }

  copyBtn?.addEventListener("click", () => {
    copyText(COMMANDS[currentCmd] || commandEl?.textContent || "", copyBtn);
  });

  document.querySelectorAll("[data-copy-static]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const code = btn.closest(".command-display")?.querySelector(".command-text");
      copyText(code?.textContent?.trim() || COMMANDS.go, btn);
    });
  });

  // —— Language switcher ——
  const langBtn = document.getElementById("langBtn");
  const langMenu = document.getElementById("langMenu");

  function closeLangMenu() {
    langMenu?.classList.remove("open");
    if (langMenu) langMenu.hidden = true;
    langBtn?.setAttribute("aria-expanded", "false");
  }

  langBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    menu?.classList.remove("open");
    if (menu) menu.hidden = true;
    selectBtn?.setAttribute("aria-expanded", "false");
    const open = langMenu?.classList.toggle("open");
    if (langMenu) langMenu.hidden = !open;
    langBtn.setAttribute("aria-expanded", open ? "true" : "false");
  });

  langMenu?.querySelectorAll("[data-lang]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      applyI18n(btn.dataset.lang);
      closeLangMenu();
    });
  });

  langMenu?.addEventListener("click", (e) => e.stopPropagation());

  // —— Feature tabs ——
  const tabs = document.querySelectorAll(".tab-item");
  const panels = document.querySelectorAll("[data-panel]");

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const id = tab.dataset.tab;
      tabs.forEach((t) => {
        t.classList.toggle("active", t === tab);
        t.setAttribute("aria-selected", t === tab ? "true" : "false");
      });
      panels.forEach((p) => {
        const on = p.dataset.panel === id;
        p.classList.toggle("active", on);
      });
    });
  });

  // —— Mobile menu ——
  const menuBtn = document.getElementById("menuBtn");
  const mobilePanel = document.getElementById("mobilePanel");

  menuBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    closeLangMenu();
    const open = mobilePanel?.classList.toggle("open");
    if (mobilePanel) mobilePanel.hidden = !open;
    menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
  });

  document.addEventListener("click", () => {
    menu?.classList.remove("open");
    if (menu) menu.hidden = true;
    selectBtn?.setAttribute("aria-expanded", "false");
    closeLangMenu();
    mobilePanel?.classList.remove("open");
    if (mobilePanel) mobilePanel.hidden = true;
    menuBtn?.setAttribute("aria-expanded", "false");
  });

  mobilePanel?.addEventListener("click", (e) => e.stopPropagation());

  // Boot: stored preference → else English
  let initial = "en";
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "zh" || saved === "en") initial = saved;
  } catch {
    /* ignore */
  }
  applyI18n(initial);
})();
