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
      "hub.meta.title": "TON.REN — Your personal assistant, on your machine",
      "hub.meta.description":
        "ton — a real personal assistant. Entrust your work and memory to him; ask, and he brings it back.",
      "hub.lede": "A personal assistant that stays with you.",
      "hub.sub": "One product on TON.REN — ton.",
      "hub.ta.when": "For everyday work & life",
      "hub.ta.desc":
        "Get things done, and bring back what you once told him — notes, chats, mail, all on your machine.",
      "hub.open": "Open →",
      "ta.meta.title": "ton — a real personal assistant",
      "ta.meta.description":
        "ton keeps what you entrust to him, and brings it back when you ask. Work, notes, chats — on your machine.",
      "ta.nav.install": "Install",
      "ta.nav.app": "See it",
      "ta.eyebrow": "Personal assistant · on your machine",
      "ta.hero.subtitle":
        "A real personal assistant. What you entrust to ton, he can bring back when you need it.",
      "ta.hero.see": "Why ton →",
      "ta.why.title": "Not a chatbot. An assistant who stays.",
      "ta.why.sub":
        "Most tools forget you the moment the tab closes. ton keeps your world close — then helps you use it.",
      "ta.why.kb.t": "He remembers for you",
      "ta.why.kb.d":
        "Notes, chats, and documents live with him locally. Ask in plain language — he finds what matters.",
      "ta.why.conn.t": "Your real life, not just a repo",
      "ta.why.conn.d":
        "WeChat, email, notes, docs, and more — the places your life already happens.",
      "ta.why.fts.t": "Ask, then get it back",
      "ta.why.fts.d":
        "No digging through folders. Say what you need; he looks it up and continues the work.",
      "ta.why.split.t": "Yours stays yours",
      "ta.why.split.d":
        "Everything stays on your machine. You decide what he holds — nothing has to leave home first.",
      "ta.showcase.title": "One place for the job and the memory",
      "ta.showcase.sub":
        "Finish what’s in front of you, then ask about something you once saved — without starting over.",
      "ta.terminal.aria": "ton preview",
      "ta.ui.you1":
        "Fix the import in src/index.ts, then find who supplies nebula coffee from my WeChat history.",
      "ta.ui.editOut": "Import fixed",
      "ta.ui.kbOut": "Found it — WeChat thread about the nebula coffee supplier",
      "ta.ui.ta1":
        "Import’s fixed. I also found the supplier thread in your WeChat history — want me to open it?",
      "ta.features.title": "What a personal assistant should do",
      "ta.f.tools.t": "Gets work done",
      "ta.f.tools.d":
        "Files, commands, edits — he can act on the task in front of you, not only chat about it.",
      "ta.f.memory.t": "Knows your preferences",
      "ta.f.memory.d":
        "Small things you care about stick with him, so you don’t repeat yourself every time.",
      "ta.f.kb.t": "Holds your archive",
      "ta.f.kb.d":
        "Notes, WeChat, email, docs, and more — kept locally, ready when you ask.",
      "ta.f.ext.t": "Grows with you",
      "ta.f.ext.d":
        "Add skills and habits over time. He becomes more yours the longer you use him.",
      "ta.f.modes.t": "Always reachable",
      "ta.f.modes.d":
        "Talk to him in the terminal, or wire him into your own workflows — same assistant underneath.",
      "ta.f.models.t": "Your choice of mind",
      "ta.f.models.d":
        "Bring the model you trust. Keys stay with you; ton is the assistant around it.",
      "ta.install.title": "Install",
      "ta.install.sub": "One command. Then meet ton.",
      "ta.install.unix": "macOS / Linux",
      "ta.install.win": "Windows",
      "ta.install.run": "Start",
      "ta.install.source": "From source",
      "install.copy": "Copy",
      "ta.privacy.title": "Stays on your machine",
      "ta.privacy.body":
        "Your conversations, settings, memories, and archives live with you. ton is an assistant at home — not a cloud locker.",
      "ta.footer.tag": "A personal assistant · on your machine.",
      "ta.footer.kb": "Knowledge base",
      "nav.docs": "Docs",
      "nav.menu": "Menu",
      "nav.install": "Install",
      "lang.aria": "Language",
      "footer.product": "Product",
      "footer.resources": "Resources",
    },
    zh: {
      "hub.meta.title": "TON.REN — 真正的个人助理，在你本机",
      "hub.meta.description":
        "ton — 真正的个人助理。你交托的事与记忆，问的时候他都能拿回来。",
      "hub.lede": "真正的个人助理，一直在你身边。",
      "hub.sub": "TON.REN 上的产品：ton。",
      "hub.ta.when": "适合 · 日常办事与记事",
      "hub.ta.desc":
        "把眼前事办完，也能把你交托过的笔记、聊天、邮件再找回来——都在本机。",
      "hub.open": "进入 →",
      "ta.meta.title": "ton — 真正的个人助理",
      "ta.meta.description":
        "你交托给 ton 的，需要时他都能拿回来。办事、记事、查往事——都在本机。",
      "ta.nav.install": "安装",
      "ta.nav.app": "看看他",
      "ta.eyebrow": "真正的个人助理 · 本机相伴",
      "ta.hero.subtitle":
        "真正的个人助理。你交托给他的，需要时他都能拿回来。",
      "ta.hero.see": "为什么选 ton →",
      "ta.why.title": "不是聊完就忘的工具",
      "ta.why.sub":
        "多数工具关了标签页就忘了你。ton 把你的世界收在身边，再用得上。",
      "ta.why.kb.t": "替你记着",
      "ta.why.kb.d":
        "笔记、聊天、文档都在本机跟着他。用平常话问，他帮你找到要紧的那一段。",
      "ta.why.conn.t": "接住真实生活",
      "ta.why.conn.d":
        "微信、邮箱、笔记、文档……生活本来发生的地方，他都接得住。",
      "ta.why.fts.t": "问得回来",
      "ta.why.fts.d":
        "不用自己翻文件夹。说出要什么，他查到，接着把事办下去。",
      "ta.why.split.t": "你的仍是你的",
      "ta.why.split.d":
        "都在本机。交托什么由你定——不必先上传，才换来一个「助理」。",
      "ta.showcase.title": "办事和记事，是同一个人",
      "ta.showcase.sub":
        "眼前的事办完，再问起从前交托过的内容——不用从头来过。",
      "ta.terminal.aria": "ton 预览",
      "ta.ui.you1": "先修好 src/index.ts 的导入，再从微信里找星云咖啡的供应商。",
      "ta.ui.editOut": "导入已修好",
      "ta.ui.kbOut": "找到了——微信里关于星云咖啡供应商的讨论",
      "ta.ui.ta1": "导入修好了。微信里也找到供应商那条讨论——要我打开吗？",
      "ta.features.title": "个人助理该做的事",
      "ta.f.tools.t": "能把事办完",
      "ta.f.tools.d":
        "改文件、跑命令、动手处理眼前工作——不只是陪你聊天。",
      "ta.f.memory.t": "记得你的习惯",
      "ta.f.memory.d":
        "你在意的小偏好会留下来，不用每次重说一遍。",
      "ta.f.kb.t": "收着你的归档",
      "ta.f.kb.d":
        "笔记、微信、邮件、文档等，都在本机收好，问起就能找。",
      "ta.f.ext.t": "会越用越像你的",
      "ta.f.ext.d":
        "技能和习惯可以慢慢加。用得越久，越是你的助理。",
      "ta.f.modes.t": "随时找得到他",
      "ta.f.modes.d":
        "在终端里聊，或接到你自己的流程里——底下是同一个助理。",
      "ta.f.models.t": "脑子你来选",
      "ta.f.models.d":
        "用你信任的模型。钥匙在你手里；ton 是围着它办事的助理。",
      "ta.install.title": "安装",
      "ta.install.sub": "一条命令。然后认识 ton。",
      "ta.install.unix": "macOS / Linux",
      "ta.install.win": "Windows",
      "ta.install.run": "启动",
      "ta.install.source": "源码构建",
      "install.copy": "复制",
      "ta.privacy.title": "留在你的本机",
      "ta.privacy.body":
        "对话、设置、记忆与归档都跟你在一起。ton 是家里的助理，不是云端储物柜。",
      "ta.footer.tag": "真正的个人助理 · 在你本机。",
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
