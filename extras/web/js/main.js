/**
 * TON.REN site — hub + ton.
 * Install/download picker, copy, tabs, mobile menu, i18n (en/zh).
 * Default locale: navigator.language（zh* → 中文），否则 English。Preference in localStorage.
 */

(() => {
  "use strict";

  const STORAGE_KEY = "ton-web-lang";
  const page = document.body?.dataset?.page || "hub";

  // —— i18n dictionaries ——
  const I18N = {
    en: {
      "hub.meta.title": "TON.REN — Local AI with personal corpus",
      "hub.meta.description":
        "ton — local-first terminal assistant. Finish work and search notes, WeChat, email in one loop.",
      "hub.lede": "Your work. Your corpus. On your machine.",
      "hub.sub": "One product on TON.REN — ton.",
      "hub.ta.when": "Use when · right now",
      "hub.ta.desc":
        "Finish the job in your terminal — and search notes, WeChat, email in the same loop.",
      "hub.open": "Open →",
      "ta.meta.title": "ton — local work + personal knowledge",
      "ta.meta.description":
        "Local-first TUI: finish jobs, search notes/WeChat/email in-session. No MCP. No cloud upload first.",
      "ta.nav.install": "Install",
      "ta.nav.app": "TUI",
      "ta.eyebrow": "CLI · TUI · local-first · MIT",
      "ta.hero.subtitle":
        "Finish the job in your terminal. Your notes, WeChat, and email join the same agent loop — no MCP, no cloud upload first.",
      "ta.hero.see": "Why ton →",
      "ta.why.title": "Not another coding agent",
      "ta.why.sub":
        "Most terminal agents work on a repo. ton wires your personal corpus into the same loop — searchable, local, first-class.",
      "ta.why.kb.t": "KB is first-class",
      "ta.why.kb.d":
        "ton kb plus in-session kb_search / kb_read — not another MCP you hope the model remembers.",
      "ta.why.conn.t": "WeChat & email",
      "ta.why.conn.d":
        "Connect local archives once. Cloud agents rarely do this; many users need it every day.",
      "ta.why.fts.t": "Search first",
      "ta.why.fts.d":
        "FTS always on. Vectors (LanceDB) only when your machine can host them — useful before fancy.",
      "ta.why.split.t": "Memory ≠ knowledge",
      "ta.why.split.d":
        "Short preferences stay in memory; long notes and chats stay in KB so context stays sane.",
      "ta.showcase.title": "Same loop: files and your corpus",
      "ta.showcase.sub":
        "Edit code, then pull a fact from notes or WeChat — without leaving the TUI or uploading an archive.",
      "ta.terminal.aria": "ton TUI preview",
      "ta.ui.you1":
        "Fix the import in src/index.ts, then check my WeChat notes for the nebula coffee supplier.",
      "ta.ui.editOut": "Fixed import path · 1 hunk",
      "ta.ui.kbOut":
        "[wechat] 2024-01-01.md — supplier thread on nebula coffee · score 0.91",
      "ta.ui.ta1":
        "Import fixed. From your WeChat archive: supplier thread on nebula coffee — want me to open that file?",
      "ta.features.title": "Built for the job and the corpus",
      "ta.f.tools.t": "Local tools",
      "ta.f.tools.d":
        "read / write / edit / bash — plus skills. Finish file and terminal work without leaving the TUI.",
      "ta.f.memory.t": "Light memory",
      "ta.f.memory.d":
        "Short preferences in ~/.ton/agent/memory — separate from the long KB corpus.",
      "ta.f.kb.t": "Personal knowledge base",
      "ta.f.kb.d":
        "Notes, PDF/DOCX, WeChat and email — indexed locally. FTS always; LanceDB hybrid when embedding is on.",
      "ta.f.ext.t": "Extensions & skills",
      "ta.f.ext.d":
        "TypeScript extensions, skills, prompt templates, and themes — project-scoped under .ton/.",
      "ta.f.modes.t": "Four modes",
      "ta.f.modes.d":
        "Interactive TUI, print/JSON, RPC, and SDK embedding — same agent loop, different surfaces.",
      "ta.f.models.t": "Bring your model",
      "ta.f.models.d":
        "Anthropic, OpenAI, Gemini, DeepSeek, OpenRouter, Ollama-compatible — keys stay on your machine.",
      "ta.install.title": "Install",
      "ta.install.sub": "One-liner from GitHub Releases. Then run ton.",
      "ta.install.unix": "macOS / Linux",
      "ta.install.win": "Windows",
      "ta.install.run": "Start",
      "ta.install.source": "From source",
      "install.copy": "Copy",
      "ta.privacy.title": "Your data stays local",
      "ta.privacy.body":
        "Sessions, settings, memory, KB index, and model keys live under ~/.ton. Controllable work surface — not a cloud corpus.",
      "ta.footer.tag": "Local work · personal corpus · finished jobs.",
      "ta.footer.kb": "Knowledge base",
      "nav.docs": "Docs",
      "nav.menu": "Menu",
      "nav.install": "Install",
      "lang.aria": "Language",
      "footer.product": "Product",
      "footer.resources": "Resources",
    },
    zh: {
      "hub.meta.title": "TON.REN — 本地工作面 · 个人语料",
      "hub.meta.description":
        "ton — 本地优先终端助理：办完眼前事，笔记/微信/邮件同环可搜。",
      "hub.lede": "眼前的事。自己的语料。都在本机。",
      "hub.sub": "TON.REN 上的产品：ton。",
      "hub.ta.when": "适合 · 眼前这件事",
      "hub.ta.desc":
        "终端里办完眼前事——笔记、微信、邮件进同一条会话检索。",
      "hub.open": "进入 →",
      "ta.meta.title": "ton — 本地办完事 · 个人知识库",
      "ta.meta.description":
        "本地优先 TUI：办完工作，会话内搜笔记/微信/邮件。不靠 MCP，不先上传云端。",
      "ta.nav.install": "安装",
      "ta.nav.app": "TUI",
      "ta.eyebrow": "CLI · TUI · 本地优先 · MIT",
      "ta.hero.subtitle":
        "终端里把眼前事办完；笔记、微信、邮件进同一条 agent loop——不靠 MCP，不先上传云端。",
      "ta.hero.see": "为什么选 ton →",
      "ta.why.title": "不是又一个 coding agent",
      "ta.why.sub":
        "多数终端 Agent 只会对着仓库干活。ton 多一层：把个人长语料接进同一条会话——可搜、本地、一等公民。",
      "ta.why.kb.t": "知识库是一等公民",
      "ta.why.kb.d":
        "ton kb + 会话内 kb_search / kb_read——不是再装一层 MCP 祈祷模型会用。",
      "ta.why.conn.t": "微信与邮箱",
      "ta.why.conn.d":
        "一次连接本地归档。云端 Agent 很少认真做；很多人每天都需要。",
      "ta.why.fts.t": "先能搜",
      "ta.why.fts.d":
        "FTS 常开。本机资源够再上向量（LanceDB）——能用优先于炫技。",
      "ta.why.split.t": "记忆 ≠ 知识库",
      "ta.why.split.d":
        "短偏好进 memory；长笔记与聊天进 KB，上下文不搅成一锅。",
      "ta.showcase.title": "同一条环：文件 + 你的语料",
      "ta.showcase.sub":
        "改完代码，再从笔记或微信里捞一句事实——不出 TUI，也不上传归档。",
      "ta.terminal.aria": "ton TUI 预览",
      "ta.ui.you1": "修好 src/index.ts 的导入，再查微信笔记里星云咖啡的供应商。",
      "ta.ui.editOut": "已修正 import · 1 个 hunk",
      "ta.ui.kbOut": "[wechat] 2024-01-01.md — 讨论了星云咖啡采购 · score 0.91",
      "ta.ui.ta1": "导入已修。微信归档里有星云咖啡供应商讨论——要我打开那份文件吗？",
      "ta.features.title": "为眼前事与个人语料而生",
      "ta.f.tools.t": "本地工具",
      "ta.f.tools.d":
        "read / write / edit / bash，外加 skills。文件与终端活不出 TUI。",
      "ta.f.memory.t": "轻量记忆",
      "ta.f.memory.d":
        "短偏好在 ~/.ton/agent/memory——与 KB 长语料分开。",
      "ta.f.kb.t": "个人知识库",
      "ta.f.kb.d":
        "笔记、PDF/DOCX、微信与邮箱本地索引。FTS 常开；有 embedding 时 LanceDB hybrid。",
      "ta.f.ext.t": "扩展与 Skills",
      "ta.f.ext.d":
        "TypeScript Extensions、Skills、Prompt Templates、Themes——项目级放 .ton/。",
      "ta.f.modes.t": "四种模式",
      "ta.f.modes.d":
        "交互 TUI、print/JSON、RPC、SDK 嵌入——同一 agent loop，不同表面。",
      "ta.f.models.t": "自带模型",
      "ta.f.models.d":
        "Anthropic、OpenAI、Gemini、DeepSeek、OpenRouter、Ollama 兼容等——Key 留在本机。",
      "ta.install.title": "安装",
      "ta.install.sub": "从 GitHub Releases 一键安装，然后运行 ton。",
      "ta.install.unix": "macOS / Linux",
      "ta.install.win": "Windows",
      "ta.install.run": "启动",
      "ta.install.source": "源码构建",
      "install.copy": "复制",
      "ta.privacy.title": "数据留在本机",
      "ta.privacy.body":
        "会话、设置、记忆、知识库索引与模型 Key 都在 ~/.ton。可控工作面——不是云端语料库。",
      "ta.footer.tag": "本地办完事 · 个人语料 · 可审计。",
      "ta.footer.kb": "知识库",
      "nav.docs": "文档",
      "nav.menu": "菜单",
      "nav.install": "安装",
      "lang.aria": "语言",
      "footer.product": "产品",
      "footer.resources": "资源",
    },
  };

  // 产品站：正式发布安装路径；源码构建留给贡献者，不用 ton-test.sh
  const TA_COMMANDS = {
    unix: "curl -fsSL https://raw.githubusercontent.com/toninfo/ton/main/install.sh | bash",
    win: "irm https://raw.githubusercontent.com/toninfo/ton/main/install.ps1 | iex",
    run: "ton",
    source:
      "git clone https://github.com/toninfo/ton.git && cd ton && npm install --ignore-scripts && npm run hydrate:model-data && npm run build:offline && npm --prefix packages/coding-agent run build && node packages/coding-agent/dist/cli.js",
  };

  const COMMANDS = TA_COMMANDS;
  const defaultCmd = "unix";
  const labelPrefix = "ta.install.";

  let currentLang = "en";
  let currentCmd = defaultCmd;

  function t(key) {
    return I18N[currentLang]?.[key] ?? I18N.en[key] ?? key;
  }

  function installLabel(key) {
    return t(`${labelPrefix}${key}`);
  }

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

    const titleKey =
      page === "hub" ? "hub.meta.title" : "ta.meta.title";
    document.title = t(titleKey);

    document.querySelectorAll("#langMenu [data-lang]").forEach((btn) => {
      const on = btn.dataset.lang === lang;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });

    if (labelEl) labelEl.textContent = installLabel(currentCmd);
    menu?.querySelectorAll("button[data-cmd]").forEach((b) => {
      const k = b.dataset.cmd;
      b.textContent = installLabel(k);
      b.classList.toggle("active", k === currentCmd);
    });

    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      /* ignore */
    }
  }

  const selectBtn = document.getElementById("installSelect");
  const menu = document.getElementById("installMenu");
  const labelEl = document.getElementById("installLabel");
  const commandEl = document.getElementById("commandText");
  const copyBtn = document.getElementById("copyBtn");
  const downloadBtn = document.getElementById("downloadBtn");
  const heroDownloadBtn = document.getElementById("heroDownloadBtn");

  function setCommand(key) {
    if (!COMMANDS[key]) return;
    currentCmd = key;
    if (commandEl) commandEl.textContent = COMMANDS[key];
    if (labelEl) labelEl.textContent = installLabel(key);
    const href = COMMANDS[key];
    if (downloadBtn) downloadBtn.setAttribute("href", href);
    if (heroDownloadBtn) heroDownloadBtn.setAttribute("href", href);
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

  // 整块菜单吞掉冒泡，避免点到末项时被 document 全局关闭抢走
  menu?.addEventListener("click", (e) => e.stopPropagation());

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
      copyText(code?.textContent?.trim() || COMMANDS.source || "", btn);
    });
  });

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

  const tabs = document.querySelectorAll(".tab-item");
  const panels = document.querySelectorAll("[data-panel]");

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const id = tab.dataset.tab;
      tabs.forEach((tEl) => {
        tEl.classList.toggle("active", tEl === tab);
        tEl.setAttribute("aria-selected", tEl === tab ? "true" : "false");
      });
      panels.forEach((p) => {
        p.classList.toggle("active", p.dataset.panel === id);
      });
    });
  });

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

  // 有本地偏好用偏好；否则按浏览器语言（中文优先）
  let initial = "en";
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "zh" || saved === "en") {
      initial = saved;
    } else if (typeof navigator !== "undefined" && /^zh\b/i.test(navigator.language || "")) {
      initial = "zh";
    }
  } catch {
    if (typeof navigator !== "undefined" && /^zh\b/i.test(navigator.language || "")) {
      initial = "zh";
    }
  }
  applyI18n(initial);
  if (COMMANDS[currentCmd]) setCommand(currentCmd);
})();
