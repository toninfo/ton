/**
 * ton Settings Web — 单页设置壳
 * 即时 PATCH；搜索过滤；分区导航。
 */

const SECTIONS = [
	{ id: "overview", label: "概览", icon: "◇", desc: "路径、版本与当前配置快照。" },
	{ id: "providers", label: "认证", icon: "🔑", desc: "为各 Provider 写入 API Key，或移除本地凭证。" },
	{ id: "model", label: "模型", icon: "◎", desc: "默认模型、思考强度与模型循环范围。" },
	{ id: "appearance", label: "外观", icon: "◐", desc: "主题、思考块显示与启动安静模式。" },
	{ id: "terminal", label: "终端", icon: "⌘", desc: "TUI 模式与全屏交互细节。" },
	{ id: "tools", label: "工具", icon: "⚒", desc: "启动时启用的内置工具集合。" },
	{ id: "knowledge", label: "知识库", icon: "☰", desc: "三步挂来源：归档文件夹 → 填表 → 同步。" },
	{ id: "advanced", label: "高级", icon: "⚙", desc: "压缩、重试、代理与遥测。" },
];

const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "powershell", "codemode", "tool_search"];

const state = {
	meta: null,
	settings: null,
	themes: [],
	providers: [],
	kb: null,
	models: [],
	section: "overview",
	saveTimer: null,
	modelQuery: "",
	showAllProviders: false,
	kbHint: "",
	syncFlashId: null,
	picker: null,
	pickerTarget: "kb-path",
};

const el = {
	nav: document.getElementById("nav"),
	content: document.getElementById("content"),
	title: document.getElementById("section-title"),
	desc: document.getElementById("section-desc"),
	status: document.getElementById("save-status"),
	search: document.getElementById("search"),
	metaFoot: document.getElementById("meta-foot"),
	toasts: document.getElementById("toasts"),
	sidebar: document.getElementById("sidebar"),
	backdrop: document.getElementById("drawer-backdrop"),
	navToggle: document.getElementById("nav-toggle"),
	pickerRoot: document.getElementById("picker-root"),
	pickerShortcuts: document.getElementById("picker-shortcuts"),
	pickerPath: document.getElementById("picker-path"),
	pickerList: document.getElementById("picker-list"),
};

const TOKEN_STORAGE_KEY = "ton_settings_token";

/** URL → sessionStorage；标签页内重启后仍带 Bearer，少踩「未授权」 */
function resolveToken() {
	const fromUrl = new URL(location.href).searchParams.get("token");
	if (fromUrl) {
		try {
			sessionStorage.setItem(TOKEN_STORAGE_KEY, fromUrl);
		} catch {
			/* private mode */
		}
		return fromUrl;
	}
	try {
		return sessionStorage.getItem(TOKEN_STORAGE_KEY) || "";
	} catch {
		return "";
	}
}

async function api(path, options = {}) {
	const headers = {
		Accept: "application/json",
		...(options.body ? { "Content-Type": "application/json" } : {}),
		...(options.headers || {}),
	};
	const token = resolveToken();
	if (token) headers.Authorization = `Bearer ${token}`;
	const res = await fetch(path, { ...options, headers, credentials: "same-origin" });
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		if (res.status === 401) {
			throw new Error(
				data.error ||
					"设置页会话已失效（服务可能刚重启）。请在终端重新运行 ton settings，用新链接打开。",
			);
		}
		throw new Error(data.error || `HTTP ${res.status}`);
	}
	return data;
}

function toast(message, kind = "ok") {
	const node = document.createElement("div");
	node.className = `toast${kind === "error" ? " error" : ""}`;
	node.textContent = message;
	el.toasts.appendChild(node);
	setTimeout(() => node.remove(), 3200);
}

function setSaveState(kind, text) {
	el.status.dataset.state = kind;
	el.status.textContent = text;
}

function escapeHtml(s) {
	return String(s)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

function renderNav() {
	el.nav.innerHTML = SECTIONS.map(
		(s) => `
    <button type="button" class="nav-btn${state.section === s.id ? " active" : ""}" data-section="${s.id}">
      <span class="nav-ico" aria-hidden="true">${s.icon}</span>
      <span>${s.label}</span>
    </button>`,
	).join("");
	el.nav.querySelectorAll("[data-section]").forEach((btn) => {
		btn.addEventListener("click", () => {
			state.section = btn.getAttribute("data-section");
			el.search.value = "";
			closeDrawer();
			render();
		});
	});
}

function closeDrawer() {
	el.sidebar.classList.remove("open");
	el.backdrop.hidden = true;
}

function openDrawer() {
	el.sidebar.classList.add("open");
	el.backdrop.hidden = false;
}

function fieldSelect(id, value, options, attrs = "") {
	return `<select class="control" data-field="${id}" ${attrs}>
    ${options
			.map(([v, label]) => `<option value="${escapeHtml(v)}"${String(value) === String(v) ? " selected" : ""}>${escapeHtml(label)}</option>`)
			.join("")}
  </select>`;
}

function toggle(key, title, hint, checked) {
	return `<div class="toggle-row" data-search="${escapeHtml(`${title} ${hint}`)}">
    <div class="meta"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(hint)}</span></div>
    <label class="switch"><input type="checkbox" data-toggle="${key}" ${checked ? "checked" : ""} /><span></span></label>
  </div>`;
}

function segmented(key, value, options) {
	return `<div class="segmented" data-seg="${key}">
    ${options
			.map(
				([v, label]) =>
					`<button type="button" aria-pressed="${String(value) === String(v)}" data-value="${escapeHtml(v)}">${escapeHtml(label)}</button>`,
			)
			.join("")}
  </div>`;
}

async function patchSettings(patch) {
	setSaveState("saving", "保存中…");
	try {
		const data = await api("/api/settings", { method: "PATCH", body: JSON.stringify(patch) });
		state.settings = data.settings;
		setSaveState("saved", "已保存");
		// 静默成功：只更新状态胶囊，避免每次开关都弹 toast
		setTimeout(() => setSaveState("idle", "已同步"), 1200);
		return data;
	} catch (err) {
		setSaveState("error", "保存失败");
		toast(err.message || String(err), "error");
		throw err;
	}
}

function setKbHint(message) {
	state.kbHint = message || "";
	const node = el.content.querySelector("#kb-hint");
	if (node) {
		if (state.kbHint) {
			node.hidden = false;
			node.textContent = state.kbHint;
		} else {
			node.hidden = true;
			node.textContent = "";
		}
	}
}

async function openPicker(startPath) {
	const data = await api(`/api/fs/browse${startPath ? `?path=${encodeURIComponent(startPath)}` : ""}`);
	state.picker = data;
	renderPicker();
	el.pickerRoot.hidden = false;
}

function closePicker() {
	el.pickerRoot.hidden = true;
	state.picker = null;
}

function renderPicker() {
	const data = state.picker;
	if (!data) return;
	el.pickerPath.textContent = data.path;
	el.pickerShortcuts.innerHTML = (data.shortcuts || [])
		.map(
			(s) =>
				`<button type="button" data-shortcut="${escapeHtml(s.path)}">${escapeHtml(s.label)}</button>`,
		)
		.join("");
	const rows = [];
	if (data.parent) {
		rows.push(
			`<button type="button" class="picker-item" data-enter="${escapeHtml(data.parent)}"><span class="kind">↑</span><span>..</span></button>`,
		);
	}
	for (const entry of data.entries || []) {
		if (entry.kind === "dir") {
			rows.push(
				`<button type="button" class="picker-item" data-enter="${escapeHtml(entry.path)}"><span class="kind">📁</span><span>${escapeHtml(entry.name)}</span></button>`,
			);
		} else {
			rows.push(
				`<button type="button" class="picker-item disabled" disabled><span class="kind">📄</span><span>${escapeHtml(entry.name)}</span></button>`,
			);
		}
	}
	el.pickerList.innerHTML = rows.join("") || `<div class="empty" style="padding:12px">此目录为空</div>`;

	el.pickerShortcuts.querySelectorAll("[data-shortcut]").forEach((btn) => {
		btn.addEventListener("click", () => {
			void openPicker(btn.getAttribute("data-shortcut"));
		});
	});
	el.pickerList.querySelectorAll("[data-enter]").forEach((btn) => {
		btn.addEventListener("click", () => {
			void openPicker(btn.getAttribute("data-enter"));
		});
	});
}

function schedulePatch(patch) {
	clearTimeout(state.saveTimer);
	state.saveTimer = setTimeout(() => {
		void patchSettings(patch);
	}, 280);
}

function bindControls(root) {
	root.querySelectorAll("[data-field]").forEach((node) => {
		const key = node.getAttribute("data-field");
		node.addEventListener("change", () => {
			let value = node.value;
			if (node.dataset.type === "number") value = Number(value);
			if (node.dataset.type === "nullable" && value.trim() === "") value = null;
			if (key.includes(".")) {
				const [a, b] = key.split(".");
				schedulePatch({ [a]: { [b]: value } });
			} else {
				schedulePatch({ [key]: value });
			}
		});
	});

	root.querySelectorAll("[data-toggle]").forEach((node) => {
		node.addEventListener("change", () => {
			const key = node.getAttribute("data-toggle");
			if (key.includes(".")) {
				const [a, b] = key.split(".");
				schedulePatch({ [a]: { [b]: node.checked } });
			} else {
				schedulePatch({ [key]: node.checked });
			}
		});
	});

	root.querySelectorAll("[data-seg]").forEach((group) => {
		const key = group.getAttribute("data-seg");
		group.querySelectorAll("button").forEach((btn) => {
			btn.addEventListener("click", () => {
				const value = btn.getAttribute("data-value");
				let patchValue = value;
				if (value === "true") patchValue = true;
				if (value === "false") patchValue = false;
				if (key.includes(".")) {
					const [a, b] = key.split(".");
					void patchSettings({ [a]: { [b]: patchValue } }).then(() => render());
				} else {
					void patchSettings({ [key]: patchValue }).then(() => render());
				}
			});
		});
	});
}

function renderOverview() {
	const s = state.settings;
	const m = state.meta;
	const kb = state.kb?.status;
	const readyProviders = state.providers.filter((p) => p.configured).length;
	const kbReady = (kb?.roots || []).length > 0;
	return `
  <section class="card" data-search="概览 路径 版本 开箱">
    <div class="card-h"><div><h2>开箱状态</h2><p>${escapeHtml(m.appName)} ${escapeHtml(m.version)} · 装完即可跑会话；密钥与额外来源按需再配。</p></div></div>
    ${kbReady ? `<div class="callout"><strong>知识库已自动就绪</strong> · docs=${kb?.totalDocs ?? 0} · 默认目录可用；微信等用「知识库 → 采集器」写入归档根。</div>` : `<div class="callout soft">知识库将在首次会话或打开本页时自动启用默认目录。</div>`}
    <div class="stat-grid">
      <div class="stat"><div class="k">Provider</div><div class="v">${readyProviders ? `${readyProviders} 已配` : "待配密钥"}</div></div>
      <div class="stat"><div class="k">默认模型</div><div class="v" style="font-size:.95rem">${escapeHtml(s.defaultProvider || "自动")}/${escapeHtml(s.defaultModel || "自动")}</div></div>
      <div class="stat"><div class="k">KB</div><div class="v">${kbReady ? "就绪" : "…"}</div></div>
    </div>
    <div class="grid" style="margin-top:14px">
      <div class="field"><label>agentDir</label><div class="path">${escapeHtml(m.agentDir)}</div></div>
      <div class="field"><label>settings.json</label><div class="path">${escapeHtml(m.paths.settings)}</div></div>
      <div class="field"><label>auth.json</label><div class="path">${escapeHtml(m.paths.auth)}</div></div>
    </div>
  </section>
  <section class="card" data-search="快捷 跳转">
    <div class="card-h"><div><h2>需要时再配</h2><p>只有加密钥、换模型、挂额外来源才要动手。</p></div></div>
    <div class="btn-row">
      <button type="button" class="btn primary" data-jump="providers">API Key</button>
      <button type="button" class="btn" data-jump="model">默认模型</button>
      <button type="button" class="btn" data-jump="knowledge">知识库 / 采集器</button>
      <button type="button" class="btn" data-jump="appearance">外观</button>
    </div>
  </section>`;
}

function renderProviders() {
	const ready = state.providers.filter((p) => p.configured);
	const rest = state.providers.filter((p) => !p.configured);
	const visible = state.showAllProviders ? state.providers : ready.length ? ready : rest.slice(0, 6);
	const cards = visible
		.map((p) => {
			const badge = p.configured
				? `<span class="badge ok">${escapeHtml(p.authLabel || p.storedType || "ready")}</span>`
				: `<span class="badge">未添加密钥</span>`;
			const apiForm = p.supportsApiKey
				? `<div class="inline-form">
            <input class="control" type="password" placeholder="粘贴 API Key…" data-api-key="${escapeHtml(p.id)}" autocomplete="off" />
            <button type="button" class="btn primary" data-save-key="${escapeHtml(p.id)}">保存</button>
          </div>`
				: `<div class="empty">此 Provider 走 OAuth，在 TUI 用 /login 即可。</div>`;
			return `<div class="provider-card" data-search="${escapeHtml(`${p.name} ${p.id} provider 认证`)}">
        <div class="provider-top">
          <div>
            <div class="name">${escapeHtml(p.name)} ${badge}</div>
            <div class="sub">${escapeHtml(p.id)}${p.supportsOAuth ? " · OAuth" : ""}${p.supportsApiKey ? " · API Key" : ""}</div>
          </div>
          <div class="btn-row" style="margin:0;justify-content:flex-end">
            ${p.configured ? `<button type="button" class="btn danger" data-logout="${escapeHtml(p.id)}">移除</button>` : ""}
          </div>
        </div>
        ${p.configured ? "" : apiForm}
        ${p.configured && p.supportsApiKey ? `<div class="inline-form"><input class="control" type="password" placeholder="更换 API Key…" data-api-key="${escapeHtml(p.id)}" autocomplete="off" /><button type="button" class="btn" data-save-key="${escapeHtml(p.id)}">更新</button></div>` : ""}
      </div>`;
		})
		.join("");
	const toggleLabel = state.showAllProviders
		? "只看已配置"
		: `显示全部（${state.providers.length}）`;
	return `<section class="card" data-search="认证 provider api key">
    <div class="card-h"><div><h2>模型服务商</h2><p>密钥只保存在本机 auth.json，不会上传。已配置 ${ready.length} 个。</p></div>
      <button type="button" class="btn ghost" id="toggle-providers">${toggleLabel}</button></div>
    ${ready.length === 0 ? `<div class="callout">还没配密钥也能先玩默认能力；要用自己的模型，先配一个常用的（如 OpenAI、Anthropic、DeepSeek）。</div>` : ""}
    <div class="provider-list scroll-list">${cards || '<div class="empty">没有可用 Provider</div>'}</div></section>`;
}

function renderModel() {
	const s = state.settings;
	const providerOptions = [
		["", "自动 / 未指定"],
		...[...new Set(state.providers.map((p) => p.id))].map((id) => [id, id]),
	];
	const modelHits = state.models
		.slice(0, 40)
		.map(
			(m) => `<button type="button" class="model-item" data-pick-model="${escapeHtml(m.provider)}" data-pick-id="${escapeHtml(m.id)}" data-search="${escapeHtml(`${m.provider}/${m.id} ${m.name}`)}">
        <div><div class="name">${escapeHtml(m.name || m.id)}</div><div class="sub">${escapeHtml(m.provider)}/${escapeHtml(m.id)}</div></div>
        <span class="badge">${m.reasoning ? "reasoning" : "chat"}</span>
      </button>`,
		)
		.join("");
	return `
  <section class="card" data-search="默认模型 thinking">
    <div class="card-h"><div><h2>默认模型</h2><p>启动与新会话使用的 provider / model。</p></div></div>
    <div class="grid cols-2">
      <div class="field"><label>Provider</label>${fieldSelect("defaultProvider", s.defaultProvider || "", providerOptions)}</div>
      <div class="field"><label>Model ID</label><input class="control" data-field="defaultModel" value="${escapeHtml(s.defaultModel || "")}" placeholder="例如 gpt-5.4" /></div>
      <div class="field"><label>思考强度</label>${fieldSelect(
				"defaultThinkingLevel",
				s.defaultThinkingLevel,
				THINKING.map((t) => [t, t]),
			)}</div>
      <div class="field"><label>传输协议</label>${fieldSelect("transport", s.transport, [
				["auto", "auto"],
				["sse", "sse"],
				["websocket", "websocket"],
				["websocket-cached", "websocket-cached"],
			])}</div>
    </div>
  </section>
  <section class="card" data-search="模型列表 搜索 选择">
    <div class="card-h"><div><h2>从目录挑选</h2><p>点击即可设为默认（基于本机静态目录，无需联网）。</p></div></div>
    <input class="control" id="model-search" placeholder="过滤模型…" value="${escapeHtml(state.modelQuery)}" />
    <div class="model-list" style="margin-top:12px">${modelHits || '<div class="empty">无匹配模型</div>'}</div>
  </section>
  <section class="card" data-search="enabledModels 循环">
    <div class="card-h"><div><h2>模型循环范围</h2><p>对应 enabledModels，逗号分隔 pattern。</p></div></div>
    <textarea class="control" data-field="enabledModelsText" data-type="list" placeholder="anthropic/*, openai/gpt-*">${escapeHtml((s.enabledModels || []).join(", "))}</textarea>
    <div class="hint" style="margin-top:8px;color:var(--text-3);font-size:.78rem">留空表示全部可用模型。</div>
  </section>`;
}

function renderAppearance() {
	const s = state.settings;
	const themes = [["system", "system（跟随终端）"], ...state.themes.map((t) => [t, t])];
	return `
  <section class="card" data-search="主题 theme">
    <div class="card-h"><div><h2>主题</h2><p>影响交互式 TUI 配色。</p></div></div>
    ${fieldSelect("theme", s.theme || "system", themes)}
  </section>
  <section class="card">
    ${toggle("hideThinkingBlock", "隐藏思考块", "转录中不展示 thinking 内容", s.hideThinkingBlock)}
    ${toggle("showCacheMissNotices", "缓存未命中提示", "显示显著 cache miss / warming 通知", s.showCacheMissNotices)}
    <div class="toggle-row" data-search="quietStartup 安静启动">
      <div class="meta"><strong>安静启动</strong><span>隐藏启动横幅或资源列表</span></div>
      ${segmented("quietStartup", String(s.quietStartup), [
				["false", "关闭"],
				["true", "全部隐藏"],
				["header", "仅保留 header"],
			])}
    </div>
    <div class="toggle-row" data-search="mermaid">
      <div class="meta"><strong>Mermaid</strong><span>图表渲染时机</span></div>
      ${segmented("mermaid", s.mermaid, [
				["off", "off"],
				["final", "final"],
				["streaming", "streaming"],
			])}
    </div>
  </section>`;
}

function renderTerminal() {
	const s = state.settings;
	return `
  <section class="card" data-search="tui fullscreen">
    <div class="card-h"><div><h2>TUI</h2><p>交互终端行为。</p></div></div>
    <div class="toggle-row">
      <div class="meta"><strong>模式</strong><span>fullscreen 更沉浸；regular 更像经典 REPL</span></div>
      ${segmented("tuiMode", s.tuiMode, [
				["fullscreen", "fullscreen"],
				["regular", "regular"],
			])}
    </div>
    <div class="toggle-row">
      <div class="meta"><strong>退出输出</strong><span>离开全屏时打印内容</span></div>
      ${segmented("fullscreenExitOutput", s.fullscreenExitOutput, [
				["transcript", "transcript"],
				["resume-hint", "resume-hint"],
			])}
    </div>
    <div class="toggle-row">
      <div class="meta"><strong>滚动条</strong><span>fullscreenScrollbar</span></div>
      ${segmented("fullscreenScrollbar", s.fullscreenScrollbar, [
				["auto", "auto"],
				["always", "always"],
				["hidden", "hidden"],
			])}
    </div>
    ${toggle("fullscreenCopyOnSelect", "选中即复制", "全屏模式下选中文本自动复制", s.fullscreenCopyOnSelect)}
    ${toggle("showHardwareCursor", "硬件光标", "IME 场景下显示终端光标", s.showHardwareCursor)}
  </section>
  <section class="card" data-search="padding 编辑器">
    <div class="grid cols-3">
      <div class="field"><label>editorPaddingX (0–3)</label><input class="control" data-field="editorPaddingX" data-type="number" type="number" min="0" max="3" value="${s.editorPaddingX}" /></div>
      <div class="field"><label>outputPad</label>${fieldSelect("outputPad", String(s.outputPad), [
				["0", "0"],
				["1", "1"],
			], 'data-type="number"')}</div>
      <div class="field"><label>autocompleteMaxVisible</label><input class="control" data-field="autocompleteMaxVisible" data-type="number" type="number" min="3" max="20" value="${s.autocompleteMaxVisible}" /></div>
    </div>
    <div class="grid cols-2" style="margin-top:14px">
      <div class="field"><label>双 Esc</label>${fieldSelect("doubleEscapeAction", s.doubleEscapeAction, [
				["tree", "tree"],
				["fork", "fork"],
				["none", "none"],
			])}</div>
      <div class="field"><label>外部编辑器</label><input class="control" data-field="externalEditor" data-type="nullable" value="${escapeHtml(s.externalEditor || "")}" placeholder="$VISUAL / $EDITOR" /></div>
    </div>
  </section>`;
}

function renderTools() {
	const s = state.settings;
	const selected = new Set(s.defaultTools && s.defaultTools.length ? s.defaultTools : ["read", "bash", "edit", "write"]);
	const chips = BUILTIN_TOOLS.map((name) => {
		const on = selected.has(name) || selected.has(`+${name}`);
		return `<button type="button" class="chip" data-tool="${name}" aria-pressed="${on}" style="${on ? "border-color:rgba(255,71,86,.45);background:var(--brand-soft)" : ""}">${name}</button>`;
	}).join("");
	return `
  <section class="card" data-search="defaultTools 工具">
    <div class="card-h"><div><h2>默认工具</h2><p>点击切换；写入 defaultTools 明文列表。</p></div></div>
    <div class="chips" id="tool-chips">${chips}</div>
    <div class="btn-row">
      <button type="button" class="btn" id="tools-reset">恢复默认四件套</button>
      <button type="button" class="btn ghost" id="tools-clear">清空（仅扩展工具）</button>
    </div>
  </section>
  <section class="card">
    <div class="toggle-row">
      <div class="meta"><strong>转向消息</strong><span>steeringMode</span></div>
      ${segmented("steeringMode", s.steeringMode, [
				["one-at-a-time", "逐条"],
				["all", "全部"],
			])}
    </div>
    <div class="toggle-row">
      <div class="meta"><strong>追问消息</strong><span>followUpMode</span></div>
      ${segmented("followUpMode", s.followUpMode, [
				["one-at-a-time", "逐条"],
				["all", "全部"],
			])}
    </div>
  </section>`;
}

/** 按来源收集表单 → POST /api/archive/collectors */
function buildCollectorPayloadForSource(id) {
	const patch = {};
	const secrets = {};
	if (id === "email") {
		const host = el.content.querySelector("#col-email-host")?.value?.trim();
		const user = el.content.querySelector("#col-email-user")?.value?.trim();
		const pwd = el.content.querySelector("#col-email-password")?.value?.trim();
		if (!host || !user) {
			return { emptyMessage: "请填写 IMAP 服务器和邮箱账号。" };
		}
		const email = { host, user, tls: el.content.querySelector("#col-email-tls")?.checked ?? true };
		const portRaw = el.content.querySelector("#col-email-port")?.value?.trim();
		if (portRaw) email.port = Number(portRaw);
		const foldersRaw = el.content.querySelector("#col-email-folders")?.value?.trim();
		if (foldersRaw) {
			email.folders = foldersRaw
				.split(/[,，]/)
				.map((x) => x.trim())
				.filter(Boolean);
		}
		patch.email = email;
		if (pwd) secrets.emailPassword = pwd;
		else if (!state.kb?.collectorsMeta?.emailPasswordSet) {
			return { emptyMessage: "请填写邮箱密码（或授权码）。" };
		}
		return { patch, secrets: Object.keys(secrets).length ? secrets : undefined };
	}
	if (id === "notion") {
		const notionToken = el.content.querySelector("#col-notion-token")?.value?.trim();
		const notionPages = el.content.querySelector("#col-notion-page-ids")?.value?.trim();
		if (!notionToken && !state.kb?.collectorsConfig?.notion?.token) {
			return { emptyMessage: "请粘贴 Notion 集成 Token。" };
		}
		const notion = {};
		if (notionToken) notion.token = notionToken;
		if (notionPages) {
			notion.pageIds = notionPages
				.split(/[,，]/)
				.map((x) => x.trim())
				.filter(Boolean);
		}
		patch.notion = notion;
		return { patch };
	}
	if (id === "obsidian") {
		const vaultPath = el.content.querySelector("#col-obsidian-vault")?.value?.trim();
		if (!vaultPath) return { emptyMessage: "请选择 Obsidian 笔记库文件夹。" };
		patch.obsidian = { vaultPath };
		return { patch };
	}
	if (id === "tencent-docs") {
		const tencent = {};
		const tcId = el.content.querySelector("#col-tencent-client-id")?.value?.trim();
		const tcSecret = el.content.querySelector("#col-tencent-client-secret")?.value?.trim();
		const tcOpen = el.content.querySelector("#col-tencent-open-id")?.value?.trim();
		const tcAccess = el.content.querySelector("#col-tencent-access-token")?.value?.trim();
		if (tcId) tencent.clientId = tcId;
		if (tcSecret) tencent.clientSecret = tcSecret;
		if (tcOpen) tencent.openId = tcOpen;
		if (tcAccess) tencent.accessToken = tcAccess;
		if (!tcId || !tcOpen || !tcAccess) {
			return { emptyMessage: "腾讯文档至少需要：应用 ID、openId、访问令牌。" };
		}
		patch["tencent-docs"] = tencent;
		return { patch };
	}
	if (id === "git") {
		const gitRaw = el.content.querySelector("#col-git-repos")?.value?.trim();
		if (!gitRaw) return { emptyMessage: "请至少填一行 Git 地址或本机路径。" };
		const repos = gitRaw
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => (line.startsWith("/") || /^[A-Za-z]:\\/.test(line) ? { path: line } : { url: line }));
		patch.git = { repos };
		return { patch };
	}
	return { emptyMessage: "未知来源。" };
}

function collectorStatusBadge(c) {
	if (c.status === "ready") return `<span class="badge ok">${escapeHtml(c.statusLabel || "可同步")}</span>`;
	if (c.status === "needs-login") return `<span class="badge warn">${escapeHtml(c.statusLabel || "待登录")}</span>`;
	if (c.status === "needs-config") return `<span class="badge warn">${escapeHtml(c.statusLabel || "待填写")}</span>`;
	if (c.status === "stub") return `<span class="badge">${escapeHtml(c.statusLabel || "暂未开放")}</span>`;
	return `<span class="badge">${escapeHtml(c.statusLabel || "先选归档文件夹")}</span>`;
}

/** 每个来源：说明 + 表单 + 保存/同步（小白不用碰 JSON） */
function renderSourceForm(id, cfg, meta) {
	const c = cfg || {};
	if (id === "wechat") {
		return `<p class="source-note">不用填表。电脑登录微信后，直接点右上角「同步」。</p>`;
	}
	if (id === "email") {
		const email = c.email || {};
		const pwdPh = meta?.emailPasswordSet ? "已保存；留空表示不修改" : "邮箱密码或授权码";
		return `
      <div class="grid cols-2">
        <div class="field"><label>IMAP 服务器</label><input class="control" id="col-email-host" value="${escapeHtml(email.host || "")}" placeholder="例如 imap.qq.com" /></div>
        <div class="field"><label>端口</label><input class="control" id="col-email-port" type="number" value="${email.port ?? ""}" placeholder="993" /><span class="field-hint">一般填 993</span></div>
        <div class="field"><label>邮箱账号</label><input class="control" id="col-email-user" value="${escapeHtml(email.user || "")}" placeholder="name@example.com" /></div>
        <div class="field"><label>密码</label><input class="control" type="password" id="col-email-password" autocomplete="new-password" placeholder="${escapeHtml(pwdPh)}" /></div>
        <div class="field" style="grid-column:1/-1"><label>收件箱（可选）</label><input class="control" id="col-email-folders" value="${escapeHtml((email.folders || []).join(", "))}" placeholder="INBOX，多个用逗号分隔" /></div>
      </div>
      <label class="toggle-row" style="margin-top:8px"><input type="checkbox" id="col-email-tls" ${email.tls !== false ? "checked" : ""} /> 加密连接（TLS）</label>`;
	}
	if (id === "notion") {
		const notion = c.notion || {};
		const tokenPh = notion.token ? "已保存；输入新 Token 可覆盖" : "secret_… 开头的一串字符";
		return `
      <div class="field"><label>集成 Token</label><input class="control" type="password" id="col-notion-token" autocomplete="off" placeholder="${escapeHtml(tokenPh)}" />
        <span class="field-hint">打开 <a href="https://www.notion.so/my-integrations" target="_blank" rel="noopener">notion.so/my-integrations</a> 创建集成并复制 Token，记得在 Notion 里给页面「连接」该集成。</span></div>
      <div class="field" style="margin-top:10px"><label>只同步指定页面（可选）</label><input class="control" id="col-notion-page-ids" value="${escapeHtml((notion.pageIds || []).join(", "))}" placeholder="页面 ID，逗号分隔；留空则按集成权限同步" /></div>`;
	}
	if (id === "obsidian") {
		const obsidian = c.obsidian || {};
		return `
      <div class="path-row">
        <input class="control" id="col-obsidian-vault" placeholder="点右侧选择 Obsidian 库文件夹" value="${escapeHtml(obsidian.vaultPath || "")}" />
        <button type="button" class="btn" id="col-obsidian-browse">选择文件夹</button>
      </div>
      <span class="field-hint">文件夹里应能看到 <code>.obsidian</code> 配置目录。</span>`;
	}
	if (id === "tencent-docs") {
		const tencent = c["tencent-docs"] || {};
		return `
      <p class="source-note soft">需要腾讯开放平台应用，适合已有开发者账号的用户；个人可先跳过。</p>
      <div class="grid cols-2">
        <div class="field"><label>应用 ID (clientId)</label><input class="control" id="col-tencent-client-id" value="${escapeHtml(tencent.clientId || "")}" /></div>
        <div class="field"><label>应用密钥</label><input class="control" type="password" id="col-tencent-client-secret" autocomplete="off" placeholder="${tencent.clientSecret ? "已保存" : ""}" /></div>
        <div class="field"><label>用户 openId</label><input class="control" id="col-tencent-open-id" value="${escapeHtml(tencent.openId || "")}" /></div>
        <div class="field"><label>访问令牌</label><input class="control" type="password" id="col-tencent-access-token" autocomplete="off" placeholder="${tencent.accessToken ? "已保存" : ""}" /></div>
      </div>`;
	}
	if (id === "git") {
		const gitLines = (c.git?.repos || [])
			.map((r) => (r.url || r.path || "").trim())
			.filter(Boolean)
			.join("\n");
		return `
      <div class="field"><label>仓库列表</label>
        <textarea class="control" id="col-git-repos" rows="4" placeholder="每行一个，例如：&#10;https://github.com/你的账号/笔记仓库.git&#10;D:\\\\notes\\\\my-repo">${escapeHtml(gitLines)}</textarea>
        <span class="field-hint">同步后会出现在归档文件夹下的 git 子目录。</span></div>`;
	}
	return "";
}

function renderSourceCards(collectors, cfg, meta, archiveRoot) {
	const hasArchive = Boolean(archiveRoot?.trim());
	return (collectors || [])
		.map((c) => {
			const enabled = Boolean(c.enabled);
			const flash = state.syncFlashId === c.id;
			const indexed =
				c.indexedDocs > 0
					? `<span class="badge ok">已索引 ${c.indexedDocs} 条</span>`
					: enabled
						? `<span class="badge warn">待同步</span>`
						: "";
			const syncBtn =
				enabled && c.runnable && hasArchive
					? `<button type="button" class="btn primary" data-collector-sync="${escapeHtml(c.id)}">同步</button>`
					: `<button type="button" class="btn" disabled title="${!hasArchive ? "请先保存归档文件夹" : "请先启用左侧开关"}">同步</button>`;
			const saveBtn =
				c.id !== "wechat" && enabled
					? `<button type="button" class="btn" data-save-source="${escapeHtml(c.id)}">保存</button>`
					: "";
			const configBlock = enabled
				? `<details class="source-details" ${c.status === "needs-config" || c.status === "needs-login" ? "open" : ""}>
          <summary>${c.id === "wechat" ? "使用说明" : "连接信息（保存后再同步）"}</summary>
          <div class="source-body">${renderSourceForm(c.id, cfg, meta)}</div>
        </details>`
				: `<p class="source-note muted">打开左侧开关启用；关闭后不再出现在上方索引，归档文件仍保留在磁盘。</p>`;
			return `<article class="source-card${enabled ? " source-on" : ""}${flash ? " source-flash" : ""}" id="source-${escapeHtml(c.id)}" data-search="${escapeHtml(`${c.label} ${c.id}`)}">
        <header class="source-head">
          <div class="source-title-row">
            <label class="switch source-switch" title="启用 / 停用该来源">
              <input type="checkbox" data-collector-enable="${escapeHtml(c.id)}" ${enabled ? "checked" : ""} ${!hasArchive ? "disabled" : ""} />
              <span></span>
            </label>
            <div>
              <h3>${escapeHtml(c.label)}</h3>
              <div class="source-badges">
                ${enabled ? `<span class="badge ok">已启用</span>` : `<span class="badge">未启用</span>`}
                ${indexed}
                ${enabled ? collectorStatusBadge(c) : ""}
              </div>
              <p class="source-lead">${escapeHtml(c.hint || "")}</p>
            </div>
          </div>
          <div class="source-actions">${saveBtn}${syncBtn}</div>
        </header>
        ${configBlock}
      </article>`;
		})
		.join("");
}

function renderKnowledge() {
	const status = state.kb?.status;
	const defaults = state.kb?.defaults;
	const defPath = defaults?.kbPathDisplay || "~/Documents/ton-kb";
	const embDefaults = defaults?.embedding || {};
	const emb = status?.embedding;
	// archive-* 只在下方来源卡片展示；上方只保留默认笔记库与用户附加目录
	const rootList = (status?.roots || []).filter((r) => !String(r.id).startsWith("archive-"));
	const ready = rootList.length > 0;
	const roots = rootList
		.map(
			(r) => `<div class="kb-card" data-search="${escapeHtml(`${r.id} ${r.path}`)}">
      <div>
        <div class="name">${escapeHtml(r.id)} <span class="badge">${escapeHtml(r.type || "local")}</span> ${r.reachable ? `<span class="badge ok">就绪</span>` : '<span class="badge warn">路径不可达</span>'}</div>
        <div class="sub">${escapeHtml(r.path)} · docs=${r.docs}</div>
      </div>
      <button type="button" class="btn danger" data-kb-rm="${escapeHtml(r.id)}">移除</button>
    </div>`,
		)
		.join("");
	const archive = state.kb?.archive;
	const archiveRoot = archive?.root || "";
	const collectors = state.kb?.collectors || [];
	const cfg = state.kb?.collectorsConfig;
	const meta = state.kb?.collectorsMeta;
	const step1 = archiveRoot ? "done" : "active";
	const step2 = collectors.some((c) => c.enabled) ? "done" : archiveRoot ? "active" : "";
	const step3 = (status?.totalDocs ?? 0) > 0 ? "done" : "";

	return `
  <section class="card" data-search="知识库 怎么用 三步">
    <div class="card-h"><div><h2>${ready ? "默认笔记库已就绪" : "正在准备…"}</h2>
      <p>AI 只读这里的索引来回答，不会直接登录你的微信/邮箱。</p></div>
      ${ready ? `<button type="button" class="btn" id="kb-reindex">刷新索引</button>` : ""}
    </div>
    ${ready ? "" : `<div class="callout soft">首次使用会自动创建 <code>${escapeHtml(defPath)}</code> 作为默认笔记文件夹。</div>`}
    <ol class="kb-steps">
      <li class="kb-step ${step1}"><span class="kb-step-n">1</span><div><strong>选一个「归档文件夹」</strong><span>同步下来的微信/邮件等副本会放在这里</span></div></li>
      <li class="kb-step ${step2}"><span class="kb-step-n">2</span><div><strong>打开来源开关，填表并保存</strong><span>只有启用的来源会进检索；未用的保持折叠</span></div></li>
      <li class="kb-step ${step3}"><span class="kb-step-n">3</span><div><strong>点「同步」，然后在 ton 里直接问</strong><span>例如：「我微信里关于 XX 说了什么」</span></div></li>
    </ol>
    <div class="kb-list">${roots}</div>
    <div class="hint-inline" id="kb-hint" ${state.kbHint ? "" : "hidden"}>${escapeHtml(state.kbHint)}</div>
  </section>
  <section class="card" data-search="归档 微信 邮件 Notion Obsidian">
    <div class="card-h"><div><h2>归档文件夹</h2>
      <p>专门存放「从别处同步来的副本」，和上面的默认笔记库是两回事。</p></div>
    </div>
    <div class="path-row">
      <input class="control" id="archive-root" placeholder="例如 ~/Documents/ton-archive" value="${escapeHtml(archiveRoot)}" />
      <button type="button" class="btn" id="archive-browse">选择文件夹</button>
      <button type="button" class="btn primary" id="archive-save">保存</button>
    </div>
    <h3 class="sources-title">内容来源</h3>
    <div class="source-list">${renderSourceCards(collectors, cfg, meta, archiveRoot) || `<p class="hint">加载中…</p>`}</div>
  </section>
  <details class="card extras" data-search="附加目录 向量 embedding 高级">
    <summary class="extras-sum">
      <strong>更多选项（一般不用动）</strong>
      <span>额外挂载文件夹 · 语义搜索 Embedding</span>
    </summary>
    <div class="extras-body">
      <h3>额外挂载文件夹</h3>
      <p class="hint">已有文件夹想原样索引、不经过同步：选目录后添加（适合 Notion 导出包、只读资料库）。</p>
      <div class="path-row">
        <input class="control" id="kb-path" placeholder="${escapeHtml(defPath)}" value="" />
        <button type="button" class="btn" id="kb-browse-2">选择目录</button>
      </div>
      <div class="inline-form" style="margin-top:8px">
        <input class="control" id="kb-id" placeholder="可选 id" />
        <button type="button" class="btn primary" id="kb-add">添加</button>
      </div>
      <h3 style="margin-top:18px">语义搜索 Embedding（可选）</h3>
      <p class="hint">${emb ? `已开启：${escapeHtml(emb.provider)}/${escapeHtml(emb.model)}` : "默认关键词搜索就够用；想「找意思相近」再开。"}</p>
      <div class="grid cols-2">
        <div class="field"><label>模型名</label><input class="control" id="emb-model" value="${escapeHtml(emb?.model || embDefaults.model || "text-embedding-3-small")}" /></div>
        <div class="field"><label>API 地址</label><input class="control" id="emb-base" value="${escapeHtml(emb?.baseUrl || embDefaults.baseUrl || "https://api.openai.com/v1")}" /></div>
        <div class="field"><label>密钥环境变量名</label><input class="control" id="emb-env" value="${escapeHtml(emb?.apiKeyEnv || embDefaults.apiKeyEnv || "OPENAI_API_KEY")}" /><span class="field-hint">在「认证」页或系统里配置同名 Key</span></div>
        <div class="field"><label>提供方类型</label><input class="control" id="emb-provider" value="${escapeHtml(emb?.provider || embDefaults.provider || "openai-compatible")}" /></div>
      </div>
      <div class="btn-row">
        <button type="button" class="btn primary" id="emb-save">保存 Embedding</button>
        <button type="button" class="btn" id="emb-local">尝试本机 Ollama</button>
        ${emb ? `<button type="button" class="btn ghost" id="emb-clear">关闭 Embedding</button>` : ""}
      </div>
    </div>
  </details>`;
}

function renderAdvanced() {
	const s = state.settings;
	return `
  <section class="card" data-search="compaction 压缩">
    <div class="card-h"><div><h2>上下文压缩</h2><p>长会话自动摘要。</p></div></div>
    ${toggle("compaction.enabled", "启用压缩", "compaction.enabled", s.compaction.enabled)}
    <div class="grid cols-2">
      <div class="field"><label>reserveTokens</label><input class="control" data-field="compaction.reserveTokens" data-type="number" type="number" value="${s.compaction.reserveTokens}" /></div>
      <div class="field"><label>keepRecentTokens</label><input class="control" data-field="compaction.keepRecentTokens" data-type="number" type="number" value="${s.compaction.keepRecentTokens}" /></div>
    </div>
  </section>
  <section class="card" data-search="retry 重试 代理">
    <div class="card-h"><div><h2>网络与重试</h2></div></div>
    ${toggle("retry.enabled", "自动重试", "瞬时失败指数退避", s.retry.enabled)}
    <div class="grid cols-2">
      <div class="field"><label>maxRetries</label><input class="control" data-field="retry.maxRetries" data-type="number" type="number" value="${s.retry.maxRetries}" /></div>
      <div class="field"><label>baseDelayMs</label><input class="control" data-field="retry.baseDelayMs" data-type="number" type="number" value="${s.retry.baseDelayMs}" /></div>
      <div class="field"><label>httpProxy</label><input class="control" data-field="httpProxy" data-type="nullable" value="${escapeHtml(s.httpProxy || "")}" placeholder="http://127.0.0.1:7890" /></div>
      <div class="field"><label>httpIdleTimeoutMs</label><input class="control" data-field="httpIdleTimeoutMs" data-type="number" type="number" value="${s.httpIdleTimeoutMs}" /></div>
    </div>
    <div class="toggle-row" style="margin-top:12px">
      <div class="meta"><strong>Cache warming</strong><span>保持 prompt cache 温热（会消耗少量 token）</span></div>
      ${segmented("cacheWarming", s.cacheWarming, [
				["off", "off"],
				["streaming", "streaming"],
				["idle", "idle"],
			])}
    </div>
  </section>
  <section class="card" data-search="shell 信任 遥测">
    <div class="grid cols-2">
      <div class="field"><label>shellPath</label><input class="control" data-field="shellPath" data-type="nullable" value="${escapeHtml(s.shellPath || "")}" /></div>
      <div class="field"><label>shellCommandPrefix</label><input class="control" data-field="shellCommandPrefix" data-type="nullable" value="${escapeHtml(s.shellCommandPrefix || "")}" /></div>
      <div class="field"><label>项目信任默认</label>${fieldSelect("defaultProjectTrust", s.defaultProjectTrust, [
				["ask", "ask"],
				["always", "always"],
				["never", "never"],
			])}</div>
    </div>
    ${toggle("enableInstallTelemetry", "安装/更新遥测", "匿名版本与更新 ping", s.enableInstallTelemetry)}
    ${toggle("enableAnalytics", "分析数据", "可选加入；默认关闭", s.enableAnalytics)}
    ${toggle("collapseChangelog", "精简更新日志", "更新后显示 condensed changelog", s.collapseChangelog)}
    ${toggle("blockImages", "阻止发图", "禁止向模型发送图片", s.blockImages)}
    ${toggle("warnings.anthropicExtraUsage", "Anthropic 超额用量警告", "订阅认证可能走付费 extra usage", s.warnings.anthropicExtraUsage)}
  </section>`;
}

const RENDERERS = {
	overview: renderOverview,
	providers: renderProviders,
	model: renderModel,
	appearance: renderAppearance,
	terminal: renderTerminal,
	tools: renderTools,
	knowledge: renderKnowledge,
	advanced: renderAdvanced,
};

function applySearchFilter() {
	const q = el.search.value.trim().toLowerCase();
	// 只过滤当前分区内容；勿用 document 全局 query（会误伤 + 切页后旧关键词把列表藏光）
	if (!el.content) return;
	el.content.querySelectorAll("[data-search]").forEach((node) => {
		if (!q) {
			node.classList.remove("hidden-by-search");
			return;
		}
		const hay = (node.getAttribute("data-search") || node.textContent || "").toLowerCase();
		node.classList.toggle("hidden-by-search", !hay.includes(q));
	});
}

function bindSectionActions() {
	el.content.querySelectorAll("[data-jump]").forEach((btn) => {
		btn.addEventListener("click", () => {
			state.section = btn.getAttribute("data-jump");
			el.search.value = "";
			render();
		});
	});

	el.content.querySelector("#toggle-providers")?.addEventListener("click", () => {
		state.showAllProviders = !state.showAllProviders;
		render();
	});

	el.content.querySelectorAll("[data-save-key]").forEach((btn) => {
		btn.addEventListener("click", async () => {
			const id = btn.getAttribute("data-save-key");
			const input = el.content.querySelector(`[data-api-key="${CSS.escape(id)}"]`);
			const key = input?.value?.trim();
			if (!key) {
				toast("请先粘贴 API Key", "error");
				return;
			}
			try {
				await api(`/api/providers/${encodeURIComponent(id)}/api-key`, {
					method: "PUT",
					body: JSON.stringify({ key }),
				});
				toast(`已保存 ${id}`);
				input.value = "";
				await reloadProviders();
				render();
			} catch (err) {
				toast(err.message, "error");
			}
		});
	});

	el.content.querySelectorAll("[data-logout]").forEach((btn) => {
		btn.addEventListener("click", async () => {
			const id = btn.getAttribute("data-logout");
			try {
				await api(`/api/providers/${encodeURIComponent(id)}`, { method: "DELETE" });
				toast(`已移除 ${id}`);
				await reloadProviders();
				render();
			} catch (err) {
				toast(err.message, "error");
			}
		});
	});

	const modelSearch = el.content.querySelector("#model-search");
	if (modelSearch) {
		modelSearch.addEventListener("input", async () => {
			state.modelQuery = modelSearch.value.trim();
			await reloadModels(state.modelQuery);
			render();
			const again = el.content.querySelector("#model-search");
			if (again) {
				again.focus();
				again.selectionStart = again.selectionEnd = again.value.length;
			}
		});
	}

	el.content.querySelectorAll("[data-pick-model]").forEach((btn) => {
		btn.addEventListener("click", async () => {
			const provider = btn.getAttribute("data-pick-model");
			const id = btn.getAttribute("data-pick-id");
			await patchSettings({ defaultProvider: provider, defaultModel: id });
			render();
		});
	});

	const enabledModels = el.content.querySelector('[data-field="enabledModelsText"]');
	if (enabledModels) {
		enabledModels.addEventListener("change", () => {
			const raw = enabledModels.value.trim();
			const list = raw
				? raw
						.split(/[,\n]/)
						.map((x) => x.trim())
						.filter(Boolean)
				: null;
			void patchSettings({ enabledModels: list });
		});
	}

	const toolChips = el.content.querySelector("#tool-chips");
	if (toolChips) {
		const selected = new Set(
			state.settings.defaultTools && state.settings.defaultTools.length
				? state.settings.defaultTools
				: ["read", "bash", "edit", "write"],
		);
		toolChips.querySelectorAll("[data-tool]").forEach((chip) => {
			chip.addEventListener("click", () => {
				const name = chip.getAttribute("data-tool");
				if (selected.has(name)) selected.delete(name);
				else selected.add(name);
				void patchSettings({ defaultTools: [...selected] }).then(() => render());
			});
		});
		el.content.querySelector("#tools-reset")?.addEventListener("click", () => {
			void patchSettings({ defaultTools: ["read", "bash", "edit", "write"] }).then(() => render());
		});
		el.content.querySelector("#tools-clear")?.addEventListener("click", () => {
			void patchSettings({ defaultTools: [] }).then(() => render());
		});
	}

	el.content.querySelector("#archive-browse")?.addEventListener("click", () => {
		state.pickerTarget = "archive-root";
		const current = el.content.querySelector("#archive-root")?.value?.trim();
		void openPicker(current || undefined).catch((err) => setKbHint(err.message));
	});
	el.content.querySelector("#col-obsidian-browse")?.addEventListener("click", () => {
		state.pickerTarget = "obsidian-vault";
		const current = el.content.querySelector("#col-obsidian-vault")?.value?.trim();
		void openPicker(current || undefined).catch((err) => setKbHint(err.message));
	});
	el.content.querySelectorAll("[data-save-source]").forEach((btn) => {
		btn.addEventListener("click", async () => {
			const id = btn.getAttribute("data-save-source");
			try {
				const { patch, secrets, emptyMessage } = buildCollectorPayloadForSource(id);
				if (emptyMessage) {
					setKbHint(emptyMessage);
					return;
				}
				const body = secrets ? { ...patch, secrets } : patch;
				const result = await api("/api/archive/collectors", { method: "POST", body: JSON.stringify(body) });
				state.kb = {
					...state.kb,
					collectors: result.collectors,
					collectorsConfig: result.config,
					collectorsMeta: result.collectorsMeta ?? state.kb?.collectorsMeta,
				};
				toast("已保存");
				setKbHint("");
				render();
			} catch (err) {
				setKbHint(err.message);
			}
		});
	});
	el.content.querySelector("#archive-save")?.addEventListener("click", async () => {
		const path = el.content.querySelector("#archive-root")?.value?.trim();
		if (!path) {
			setKbHint("先选择归档根目录。");
			return;
		}
		try {
			await api("/api/archive/root", { method: "POST", body: JSON.stringify({ path }) });
			toast("归档根已设置");
			await reloadKb();
			render();
		} catch (err) {
			setKbHint(err.message);
		}
	});
	el.content.querySelectorAll("[data-collector-enable]").forEach((input) => {
		input.addEventListener("change", async () => {
			const id = input.getAttribute("data-collector-enable");
			const on = input.checked;
			try {
				const result = await api("/api/archive/collectors", {
					method: "POST",
					body: JSON.stringify({ enabled: { [id]: on } }),
				});
				state.kb = {
					...state.kb,
					collectors: result.collectors,
					collectorsConfig: result.config,
					collectorsMeta: result.collectorsMeta ?? state.kb?.collectorsMeta,
				};
				toast(on ? "已启用，可填写连接信息并同步" : "已停用，已从检索索引移除");
				await reloadKb();
				render();
			} catch (err) {
				input.checked = !on;
				setKbHint(err.message);
			}
		});
	});

	el.content.querySelectorAll("[data-collector-sync]").forEach((btn) => {
		btn.addEventListener("click", async () => {
			const id = btn.getAttribute("data-collector-sync");
			const path = el.content.querySelector("#archive-root")?.value?.trim();
			try {
				const result = await api("/api/archive/sync", {
					method: "POST",
					body: JSON.stringify({ id, ...(path ? { path } : {}) }),
				});
				const notes = (result.results || []).map((r) => `${r.id}: ${r.note}`).join("；");
				setKbHint(notes || "同步完成");
				toast(notes || "同步完成");
				state.syncFlashId = id;
				await reloadKb();
				render();
				setTimeout(() => {
					state.syncFlashId = null;
					render();
				}, 2600);
			} catch (err) {
				setKbHint(err.message);
			}
		});
	});

	el.content.querySelector("#kb-browse-2")?.addEventListener("click", () => {
		const current = el.content.querySelector("#kb-path")?.value?.trim();
		void openPicker(current || state.kb?.defaults?.kbPath).catch((err) => toast(err.message, "error"));
	});

	el.content.querySelector("#kb-add")?.addEventListener("click", async () => {
		const path = el.content.querySelector("#kb-path")?.value?.trim();
		const id = el.content.querySelector("#kb-id")?.value?.trim();
		if (!path) {
			setKbHint("先点「选择目录」或「启用默认知识库」，也可以直接粘贴路径。");
			return;
		}
		try {
			await api("/api/kb/roots", { method: "POST", body: JSON.stringify({ path, id: id || undefined }) });
			toast("已添加目录");
			state.kbHint = "";
			await reloadKb();
			render();
		} catch (err) {
			setKbHint(err.message);
		}
	});

	el.content.querySelectorAll("[data-kb-rm]").forEach((btn) => {
		btn.addEventListener("click", async () => {
			const id = btn.getAttribute("data-kb-rm");
			try {
				await api(`/api/kb/roots/${encodeURIComponent(id)}`, { method: "DELETE" });
				toast(`已移除 ${id}`);
				await reloadKb();
				render();
			} catch (err) {
				setKbHint(err.message);
			}
		});
	});

	el.content.querySelector("#kb-reindex")?.addEventListener("click", async () => {
		try {
			await api("/api/kb/reindex", { method: "POST", body: "{}" });
			toast("索引已更新");
			await reloadKb();
			render();
		} catch (err) {
			setKbHint(err.message);
		}
	});

	el.content.querySelector("#emb-save")?.addEventListener("click", async () => {
		try {
			await api("/api/kb/embedding", {
				method: "POST",
				body: JSON.stringify({
					model: el.content.querySelector("#emb-model")?.value?.trim(),
					baseUrl: el.content.querySelector("#emb-base")?.value?.trim(),
					apiKeyEnv: el.content.querySelector("#emb-env")?.value?.trim(),
					provider: el.content.querySelector("#emb-provider")?.value?.trim() || "openai-compatible",
				}),
			});
			toast("Embedding 已保存");
			await reloadKb();
			render();
		} catch (err) {
			setKbHint(err.message);
		}
	});

	el.content.querySelector("#emb-local")?.addEventListener("click", async () => {
		try {
			const result = await api("/api/kb/embedding", {
				method: "POST",
				body: JSON.stringify({ local: true, force: true }),
			});
			if (result.ok === false) {
				setKbHint(result.message || "本机 Ollama 暂不可用，继续用 FTS 即可");
				return;
			}
			toast("已启用本地 embedding");
			state.kbHint = "";
			await reloadKb();
			render();
		} catch (err) {
			setKbHint(err.message);
		}
	});

	el.content.querySelector("#emb-clear")?.addEventListener("click", async () => {
		try {
			await api("/api/kb/embedding", { method: "POST", body: JSON.stringify({ clear: true }) });
			toast("已回到纯 FTS");
			await reloadKb();
			render();
		} catch (err) {
			setKbHint(err.message);
		}
	});
}

function render() {
	const section = SECTIONS.find((s) => s.id === state.section) || SECTIONS[0];
	el.title.textContent = section.label;
	el.desc.textContent = section.desc;
	renderNav();
	el.content.innerHTML = RENDERERS[section.id]();
	bindControls(el.content);
	bindSectionActions();
	applySearchFilter();
	if (state.meta) {
		el.metaFoot.innerHTML = `<div>${escapeHtml(state.meta.appName)} <code>v${escapeHtml(state.meta.version)}</code></div><div style="margin-top:6px"><code>${escapeHtml(state.meta.agentDir)}</code></div>`;
	}
}

async function reloadProviders() {
	state.providers = (await api("/api/providers")).providers;
}

async function reloadKb() {
	state.kb = await api("/api/kb");
}

async function reloadModels(q = "") {
	const qs = q ? `?q=${encodeURIComponent(q)}` : "";
	state.models = (await api(`/api/models${qs}`)).models;
}

async function boot() {
	try {
		const [meta, settingsPack] = await Promise.all([api("/api/meta"), api("/api/settings")]);
		state.meta = meta;
		state.settings = settingsPack.settings;
		state.themes = settingsPack.themes || [];
		await Promise.all([reloadProviders(), reloadKb(), reloadModels()]);
		document.title = `${meta.appName} Settings`;
		render();
	} catch (err) {
		el.content.innerHTML = `<section class="card"><h2>无法打开设置</h2><p>${escapeHtml(err.message)}</p><p class="hint">在终端执行 <code>ton settings</code>，用它打印的链接打开（不要只收藏无参数的地址）。</p></section>`;
		setSaveState("error", "未连接");
	}
}

el.search.addEventListener("input", applySearchFilter);
el.navToggle.addEventListener("click", openDrawer);
el.backdrop.addEventListener("click", closeDrawer);

document.getElementById("picker-close")?.addEventListener("click", closePicker);
document.getElementById("picker-cancel")?.addEventListener("click", closePicker);
document.getElementById("picker-backdrop")?.addEventListener("click", closePicker);
document.getElementById("picker-confirm")?.addEventListener("click", async () => {
	const path = state.picker?.path;
	if (!path) return;
	const target = state.pickerTarget || "kb-path";
	closePicker();
	if (target === "archive-root") {
		state.section = "knowledge";
		render();
		const archiveInput = el.content.querySelector("#archive-root");
		if (archiveInput) archiveInput.value = path;
		try {
			await api("/api/archive/root", { method: "POST", body: JSON.stringify({ path }) });
			toast("归档根已设置");
			await reloadKb();
			render();
		} catch (err) {
			setKbHint(err.message);
		}
		state.pickerTarget = "kb-path";
		return;
	}
	if (target === "obsidian-vault") {
		state.section = "knowledge";
		render();
		const vaultInput = el.content.querySelector("#col-obsidian-vault");
		if (vaultInput) vaultInput.value = path;
		state.pickerTarget = "kb-path";
		return;
	}
	state.section = "knowledge";
	render();
	const input = el.content.querySelector("#kb-path");
	if (input) input.value = path;
	state.pickerTarget = "kb-path";
});

void boot();
