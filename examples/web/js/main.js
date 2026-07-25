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
        "TON: a local TUI orchestrator for long-running, auditable coding-agent sessions. Clarify → Plan → Execute → Verify ⇄ Repair → Summarize.",
      "nav.docs": "Docs",
      "nav.menu": "Menu",
      "nav.install": "Install",
      "nav.loop": "Session loop",
      "lang.aria": "Language",
      "banner.aria": "Announcement",
      "banner.cta": "Get started",
      "hero.subtitle":
        "AI Engineering Session — a local TUI orchestrator that folds long-running coding agents<br />into an auditable session loop: align faster, finish steadier",
      "install.go": "Go (add PATH)",
      "install.curl": "Linux / macOS",
      "install.ps1": "Windows",
      "install.build": "From source",
      "install.setup": "Configure LLM key",
      "install.copy": "Copy command",
      "install.hint":
        "After install, open a new terminal and run <code>ton doctor</code>. The curl/Windows installers put <code>ton</code> on your user PATH; plain <code>go install</code> does not unless you add <code>$(go env GOPATH)/bin</code>.",
      "cta.start": "Get started",
      "cta.guide": "User guide",
      "features.title": "One session model, many drivers",
      "terminal.aria": "TON TUI preview",
      "terminal.prompt": "Make the login page dark-mode friendly and accessible",
      "terminal.response":
        "Requirements card ready. Confirm Ready, then /start to enter Plan → Execute → Verify.",
      "terminal.f1": "🎯 Clarify + Ready gate — keep the agent on rails",
      "terminal.f2": "📋 Milestone TUI + full audit trail under .ton/",
      "terminal.f3": "🔁 Verify ⇄ Repair — exhaustible, recoverable failure policy",
      "terminal.f4": "🔌 Pluggable drivers: OpenCode / Claude / Cursor / fake",
      "drivers.body":
        "One session state machine, swappable backends. CI uses the built-in <code>fake</code> driver for orchestration coverage; wire OpenCode / Claude Code / Cursor CLI locally for real runs.",
      "drivers.opencode": "Default candidate scan — local headless agents",
      "drivers.claude": "Official Claude CLI — long-context friendly",
      "drivers.cursor": "Cursor CLI / agent channel — IDE ecosystem bridge",
      "loop.title": "Every session follows the same closed loop",
      "loop.sub":
        "Humans step in at gates when needed; TON runs the agent locally and persists everything.",
      "loop.clarify": "Goals & constraints",
      "loop.ready": "Human confirm gate",
      "loop.plan": "Milestone breakdown",
      "loop.execute": "Unattended run",
      "loop.verify": "Acceptance gate",
      "loop.repair": "Failure repair loop",
      "loop.summarize": "Session summary",
      "footer.tag":
        "AI Engineering Session — local TUI orchestrator for auditable agent runs.",
      "footer.product": "Product",
      "footer.resources": "Resources",
      "footer.config": "Configuration",
      "footer.commands": "Commands",
    },
    zh: {
      "meta.title": "TON — AI Engineering Session",
      "meta.description":
        "TON：本地 TUI 编排器，驱动长跑、可审计的 coding-agent 会话。Clarify → Plan → Execute → Verify ⇄ Repair → Summarize。",
      "nav.docs": "文档",
      "nav.menu": "菜单",
      "nav.install": "安装",
      "nav.loop": "会话循环",
      "lang.aria": "语言",
      "banner.aria": "公告",
      "banner.cta": "立即开始",
      "hero.subtitle":
        "AI Engineering Session —— 本地 TUI 编排器，把长跑 coding agent<br />收进可审计的会话循环：更快对齐目标，更稳完成任务",
      "install.go": "Go（需加 PATH）",
      "install.curl": "Linux / macOS",
      "install.ps1": "Windows",
      "install.build": "从源码安装",
      "install.setup": "配置 LLM Key",
      "install.copy": "复制命令",
      "install.hint":
        "安装后请<strong>新开终端</strong>，再执行 <code>ton doctor</code>。curl / Windows 安装脚本会写入用户 PATH；单独 <code>go install</code> 默认只进 <code>$(go env GOPATH)/bin</code>，多数环境找不到命令。",
      "cta.start": "开始使用",
      "cta.guide": "使用指南",
      "features.title": "一套会话模型，多驱动畅跑",
      "terminal.aria": "TON TUI 预览",
      "terminal.prompt": "把登录页改成无障碍友好的暗色主题",
      "terminal.response":
        "已整理需求卡片。确认 Ready 后执行 /start，将进入 Plan → Execute → Verify。",
      "terminal.f1": "🎯 Clarify + Ready 闸门，避免 agent 跑偏",
      "terminal.f2": "📋 Milestone TUI + .ton/ 全量审计轨迹",
      "terminal.f3": "🔁 Verify ⇄ Repair，失败策略可耗尽可恢复",
      "terminal.f4": "🔌 可插拔驱动：OpenCode / Claude / Cursor / fake",
      "drivers.body":
        "一套会话状态机，后端可换。CI 用内置 <code>fake</code> 驱动覆盖编排；本机接上 OpenCode / Claude Code / Cursor CLI 即可实战。",
      "drivers.opencode": "默认扫描候选，适合本地 headless agent",
      "drivers.claude": "官方 Claude CLI，长上下文任务友好",
      "drivers.cursor": "Cursor CLI / agent 通道，IDE 生态衔接",
      "loop.title": "会话始终走同一条闭环",
      "loop.sub": "人类偶尔介入闸门；其余由 TON 在本地把 agent 跑完并落盘。",
      "loop.clarify": "澄清目标与约束",
      "loop.ready": "人工确认闸门",
      "loop.plan": "里程碑拆解",
      "loop.execute": "无人值守执行",
      "loop.verify": "验收门禁",
      "loop.repair": "失败修复环",
      "loop.summarize": "会话摘要",
      "footer.tag":
        "AI Engineering Session — 本地 TUI 编排器，驱动可审计的 agent 会话。",
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
