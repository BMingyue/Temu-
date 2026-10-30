/* Replace the third-party header ads with a configurable Temu shortcut bar. */
(() => {
  "use strict";

  const STORAGE_KEY = "temuQuickNavItems.v2";
  const LEGACY_STORAGE_KEY = "temuPopupShortcuts.v1";
  const HOST_ID = "temuQuickNavHost";
  const DEFAULT_LINKS = Object.freeze([
    {id:"default-flow", name:"流量分析", url:"https://agentseller-us.temu.com/main/flux-analysis", tone:"teal"},
    {id:"default-products", name:"商品列表", url:"https://agentseller-us.temu.com/goods/list", tone:"orange"},
    {id:"default-orders", name:"订单列表", url:"https://agentseller-us.temu.com/mmsos/orders.html", tone:"blue"},
    {id:"default-newon", name:"上新生命周期", url:"https://agentseller-us.temu.com/newon/product-select", tone:"purple"},
  ]);
  const US_DEFAULT_IDS = new Set(["default-flow", "default-products", "default-orders", "default-newon"]);

  const helpers = {
    normalizeUrl(rawValue) {
      const value = String(rawValue || "").trim();
      if (!value) throw new Error("请填写跳转地址");
      const withProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`;
      const parsed = new URL(withProtocol);
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("地址只支持 HTTP 或 HTTPS");
      if (parsed.protocol !== "https:" || !(parsed.hostname === "temu.com" || parsed.hostname.endsWith(".temu.com"))) throw new Error("快捷入口只允许 Temu 官方 HTTPS 地址");
      return parsed.href;
    },
    matchPattern(rawUrl) {
      const parsed = new URL(rawUrl);
      return `${parsed.origin}${parsed.pathname}${parsed.search || ""}*`;
    },
    isCurrent(currentUrl, targetUrl) {
      try {
        const current = new URL(currentUrl);
        const target = new URL(targetUrl);
        const targetPath = target.pathname.replace(/\/+$/, "") || "/";
        const currentPath = current.pathname.replace(/\/+$/, "") || "/";
        return current.origin === target.origin
          && (currentPath === targetPath || (targetPath !== "/" && currentPath.startsWith(`${targetPath}/`)));
      } catch {
        return false;
      }
    },
    shouldHideOnPage(rawUrl) {
      try {
        return new URL(rawUrl).hostname.toLowerCase() === "ads.temu.com";
      } catch {
        return false;
      }
    },
    cleanLinks(value) {
      if (!Array.isArray(value)) return [];
      const ids = new Set();
      return value.slice(0, 20).map((item, index) => {
        try {
          const name = String(item?.name || "").trim().slice(0, 20);
          const url = helpers.normalizeUrl(item?.url);
          if (!name) return null;
          let id = String(item?.id || `custom-${index}-${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 60);
          while (!id || ids.has(id)) id = `custom-${crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`}`;
          ids.add(id);
          const tone = ["teal", "orange", "blue", "purple"].includes(item?.tone) ? item.tone : "custom";
          return {id, name, url, tone};
        } catch {
          return null;
        }
      }).filter(Boolean);
    },
    migrateDefaultSellerUrls(value) {
      const defaults = new Map(DEFAULT_LINKS.map((item) => [item.id, item]));
      return helpers.cleanLinks(value).map((item) => {
        const target = defaults.get(item.id);
        if (!target || !US_DEFAULT_IDS.has(item.id)) return item;
        try {
          const current = new URL(item.url), expected = new URL(target.url);
          if (current.hostname === "agentseller.temu.com" && current.pathname.replace(/\/+$/, "") === expected.pathname.replace(/\/+$/, "")) return {...item, url:target.url};
        } catch {}
        return item;
      });
    },
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {helpers, DEFAULT_LINKS};
    return;
  }
  if (helpers.shouldHideOnPage(location.href)) return;
  if (window.__temuQuickNavInstalled) return;
  window.__temuQuickNavInstalled = true;

  const cloneDefaults = () => DEFAULT_LINKS.map((item) => ({...item}));
  let navItems = cloneDefaults();
  let managerDraft = [];
  let host = null;
  let shadow = null;
  let lastUrl = "";
  let attachTimer = 0;
  let suppressManagerClick = false;
  let fallbackContainer = null;
  let mountedContainer = null;

  function isRenderedContainer(node) {
    if (!node?.isConnected) return false;
    const style = getComputedStyle(node);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" && node.getClientRects().length > 0;
  }

  function findAdContainer() {
    const direct = document.querySelector(".yqsj-temu-ads-container");
    if (isRenderedContainer(direct)) return direct;
    const image = [...document.querySelectorAll("img")].find((item) => /(?:云起浏览器|Y2物流)/i.test(String(item.alt || "")));
    const container = image?.closest?.(".yqsj-temu-ads-container") || image?.parentElement?.parentElement || null;
    return isRenderedContainer(container) ? container : null;
  }

  const compactText = (node) => String(node?.textContent || "").replace(/\s+/g, " ").trim();

  function deepestHeaderMarker(pattern) {
    const nodes = document.body ? [...document.body.querySelectorAll("div,span,a,button")] : [];
    return nodes.find((node) => {
      const text = compactText(node);
      if (!text || text.length > 80 || !pattern.test(text)) return false;
      return ![...node.children].some((child) => {
        const childText = compactText(child);
        return childText && childText.length <= 80 && pattern.test(childText);
      });
    }) || null;
  }

  function branchBelow(ancestor, node) {
    let branch = node;
    while (branch?.parentElement && branch.parentElement !== ancestor) branch = branch.parentElement;
    return branch?.parentElement === ancestor ? branch : null;
  }

  function preferredEmptyContainer(node) {
    let current = node;
    for (let depth = 0; depth < 2; depth += 1) {
      const emptyChildren = [...current.children].filter((child) => child.tagName === "DIV" && !compactText(child));
      if (emptyChildren.length !== 1) break;
      current = emptyChildren[0];
    }
    return current;
  }

  function emptyContainerBetween(shell, leftMarker, rightMarker) {
    const children = [...shell.children];
    const leftBranch = branchBelow(shell, leftMarker);
    const rightBranch = branchBelow(shell, rightMarker);
    const leftIndex = children.indexOf(leftBranch);
    const rightIndex = children.indexOf(rightBranch);
    if (leftIndex < 0 || rightIndex <= leftIndex + 1) return null;
    const middle = children.slice(leftIndex + 1, rightIndex).find((node) => node !== host && node.tagName === "DIV" && !compactText(node));
    return middle ? preferredEmptyContainer(middle) : null;
  }

  function findSellerHeaderCenter() {
    if (!/^(?:agentseller-us|agentseller)\.temu\.com$/.test(location.hostname) || !document.body) return null;
    if (isRenderedContainer(fallbackContainer)) return fallbackContainer;
    fallbackContainer = null;

    const rightMarker = deepestHeaderMarker(/(?:履约中心|规则中心|运营对接|消息)/);
    if (!rightMarker) return null;
    const leftMarker = deepestHeaderMarker(/(?:Seller Central|卖家中心)/i) || deepestHeaderMarker(/^Beta$/i);

    if (leftMarker) {
      const leftAncestors = new Set();
      for (let node = leftMarker; node && node !== document.body; node = node.parentElement) leftAncestors.add(node);
      let common = rightMarker;
      while (common && common !== document.body && !leftAncestors.has(common)) common = common.parentElement;
      for (let shell = common; shell && shell !== document.body; shell = shell.parentElement) {
        const middle = emptyContainerBetween(shell, leftMarker, rightMarker);
        if (middle) {
          fallbackContainer = middle;
          return fallbackContainer;
        }
      }
    }

    for (let shell = rightMarker.parentElement; shell && shell !== document.body; shell = shell.parentElement) {
      const children = [...shell.children];
      const rightBranch = branchBelow(shell, rightMarker);
      const rightIndex = children.indexOf(rightBranch);
      if (rightIndex < 1) continue;
      const middle = children.slice(0, rightIndex).reverse().find((node) => node !== host && node.tagName === "DIV" && !compactText(node));
      if (!middle) continue;
      fallbackContainer = preferredEmptyContainer(middle);
      return fallbackContainer;
    }
    return null;
  }

  function createHost() {
    host = document.createElement("div");
    host.id = HOST_ID;
    shadow = host.attachShadow({mode:"open"});
    shadow.innerHTML = `
      <style>
        :host{display:block;width:100%;height:42px;color:#153148;font:13px/1.2 Inter,"Microsoft YaHei",system-ui,sans-serif}
        *{box-sizing:border-box}button,input{font:inherit}.bar{height:42px;display:flex;align-items:center;gap:8px;padding:3px 5px;border:1px solid #bdd8dc;border-radius:11px;background:linear-gradient(180deg,#ffffff,#f2faf9);box-shadow:0 4px 14px #0f766e16;overflow:hidden}
        .links{min-width:0;display:flex;align-items:center;gap:7px;flex:1;overflow-x:auto;scrollbar-width:none}.links::-webkit-scrollbar{display:none}
        .nav,.add{flex:1 1 128px;min-width:110px;height:34px;border:1px solid var(--accent,#16877e);border-radius:8px;padding:0 14px;background:#fff;color:var(--accent,#16877e);font-size:15px;font-weight:800;white-space:nowrap;cursor:pointer;transition:.14s ease}
        .nav:hover,.add:hover{transform:translateY(-1px);filter:saturate(1.2);box-shadow:0 4px 10px #0f172a18}.nav.active{background:var(--accent,#16877e);color:#fff;box-shadow:0 4px 12px color-mix(in srgb,var(--accent,#16877e) 35%,transparent)}
        .nav[data-tone=teal]{--accent:#078b80}.nav[data-tone=orange]{--accent:#dd7808}.nav[data-tone=blue]{--accent:#2874dc}.nav[data-tone=purple]{--accent:#7a42db}.nav[data-tone=custom]{--accent:#526879}
        .add{--accent:#0d766e;flex:0 0 105px;min-width:105px;background:#0d766e;color:#fff}
        dialog{font:13px/1.45 Inter,"Microsoft YaHei",system-ui,sans-serif}.manager{position:fixed;width:min(860px,calc(100vw - 40px));max-height:calc(100vh - 70px);margin:auto;padding:0;border:1px solid #8dc7c2;border-radius:17px;background:#f7fbfb;color:#183348;box-shadow:0 24px 75px #0f172a66;overflow:hidden}.manager::backdrop{background:#102e3b70;backdrop-filter:blur(2px)}
        .manager-head{display:flex;align-items:center;justify-content:space-between;padding:17px 20px;border-bottom:1px solid #d4e5e6;background:#fff}.manager h2{margin:0;font-size:20px}.manager-head p{margin:4px 0 0;color:#657b86}.close{width:34px;height:34px;border:0;border-radius:8px;background:#edf4f4;color:#607684;font-size:23px;cursor:pointer}
        .manager-body{max-height:calc(100vh - 235px);overflow:auto;padding:15px 20px}.manager-columns,.manager-row{display:grid;grid-template-columns:42px minmax(130px,.65fr) minmax(280px,1.6fr) 70px;gap:9px;align-items:center}.manager-columns{padding:0 8px 7px;color:#607885;font-weight:700}.manager-row{margin-bottom:8px;padding:8px;border:1px solid #d0e1e3;border-radius:10px;background:#fff;transition:border-color .15s,box-shadow .15s,transform .15s}.manager-row.dragging{border-color:#07988d;box-shadow:0 10px 26px #0d766e30;transform:scale(1.008);opacity:.94;z-index:2}
        .drag-handle{height:36px;border:0;border-radius:7px;background:#edf7f6;color:#087e76;font-size:19px;font-weight:800;cursor:grab;touch-action:none;user-select:none}.drag-handle:active{cursor:grabbing}.manager input{min-width:0;width:100%;height:36px;border:1px solid #c5d9dc;border-radius:7px;padding:0 10px;color:#173349;outline:0}.manager input:focus{border-color:#0d9488;box-shadow:0 0 0 2px #0d948820}.delete{height:36px;border:1px solid #efc2bf;border-radius:7px;background:#fff5f4;color:#bf3f36;font-weight:700;cursor:pointer}
        .empty{padding:30px;border:1px dashed #b9ced1;border-radius:10px;text-align:center;color:#6b808a;background:#fff}.manager-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 20px;border-top:1px solid #d4e5e6;background:#fff}.foot-left,.foot-right{display:flex;align-items:center;gap:8px}.manager-foot button{height:36px;border:1px solid #aaccc9;border-radius:8px;padding:0 14px;background:#fff;color:#18736d;font-weight:800;cursor:pointer}.manager-foot .primary{border-color:#0d766e;background:#0d766e;color:#fff}.manager-foot .restore{border-color:#e0b468;color:#956108;background:#fff9ec}.status{min-width:80px;color:#607585;font-size:12px}
        .confirm-layer{position:absolute;inset:0;display:grid;place-items:center;padding:20px;background:#102e3b66}.confirm-layer[hidden]{display:none}.confirm-card{width:min(410px,100%);padding:22px;border-radius:14px;background:#fff;box-shadow:0 18px 55px #102e3b55}.confirm-card h3{margin:0 0 8px;font-size:18px}.confirm-card p{margin:0 0 18px;color:#647984}.confirm-actions{display:flex;justify-content:flex-end;gap:8px}.confirm-actions button{height:36px;border:1px solid #bed3d5;border-radius:8px;padding:0 14px;background:#fff;color:#45616e;font-weight:800;cursor:pointer}.confirm-actions .danger{border-color:#d54d43;background:#d54d43;color:#fff}
        @media(max-width:760px){.nav{min-width:120px}.manager-columns{display:none}.manager-row{grid-template-columns:38px 1fr 64px}.manager-row input[data-field=url]{grid-column:2/4}.manager-foot{align-items:stretch;flex-direction:column}.foot-left,.foot-right{justify-content:space-between}}
      </style>
      <div class="bar"><div class="links" aria-label="Temu 快捷跳转"></div><button class="add" type="button">＋自定义</button></div>
      <dialog class="manager">
        <div class="manager-head"><div><h2>管理快捷跳转</h2><p>可修改名称和地址；长按左侧拖动柄后拖动排序。</p></div><button class="close" type="button" aria-label="关闭">×</button></div>
        <div class="manager-body"><div class="manager-columns"><span>排序</span><span>名称</span><span>地址</span><span>操作</span></div><div class="manager-rows"></div></div>
        <div class="manager-foot"><div class="foot-left"><button class="append" type="button">＋新增入口</button><button class="restore" type="button">恢复默认四项</button></div><div class="foot-right"><span class="status" role="status"></span><button class="cancel" type="button">取消</button><button class="save-all primary" type="button">保存更改</button></div></div>
        <div class="confirm-layer" hidden><div class="confirm-card"><h3>恢复默认快捷入口？</h3><p>这会删除全部自定义项和当前修改，并恢复默认的四个入口。</p><div class="confirm-actions"><button class="confirm-cancel" type="button">取消</button><button class="confirm-restore danger" type="button">确认恢复</button></div></div></div>
      </dialog>`;
    shadow.querySelector(".add").addEventListener("click", openManager);
    shadow.querySelector(".close").addEventListener("click", closeManager);
    shadow.querySelector(".cancel").addEventListener("click", closeManager);
    shadow.querySelector(".append").addEventListener("click", appendManagerRow);
    shadow.querySelector(".restore").addEventListener("click", () => { shadow.querySelector(".confirm-layer").hidden = false; });
    shadow.querySelector(".confirm-cancel").addEventListener("click", () => { shadow.querySelector(".confirm-layer").hidden = true; });
    shadow.querySelector(".confirm-restore").addEventListener("click", restoreDefaults);
    shadow.querySelector(".save-all").addEventListener("click", saveManager);
    shadow.querySelector(".manager-rows").addEventListener("click", handleManagerClick);
    shadow.querySelector(".manager").addEventListener("cancel", (event) => { event.preventDefault(); closeManager(); });
    renderLinks();
    return host;
  }

  function makeLinkButton(link) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "nav";
    button.dataset.tone = link.tone || "custom";
    button.dataset.url = link.url;
    button.textContent = link.name;
    button.title = `${link.name}\n${link.url}`;
    button.addEventListener("click", () => openLink(link.url, button));
    return button;
  }

  function renderLinks() {
    if (!shadow) return;
    shadow.querySelector(".links").replaceChildren(...navItems.map(makeLinkButton));
    updateActiveLink(true);
  }

  function openManager() {
    managerDraft = navItems.map((item) => ({...item}));
    renderManagerRows();
    const manager = shadow.querySelector(".manager");
    shadow.querySelector(".confirm-layer").hidden = true;
    shadow.querySelector(".status").textContent = "";
    if (!manager.open) manager.showModal();
  }

  function closeManager() {
    const manager = shadow?.querySelector(".manager");
    if (manager?.open) manager.close();
  }

  function managerRow(item) {
    const row = document.createElement("div");
    row.className = "manager-row";
    row.dataset.id = item.id;
    row.innerHTML = `<button class="drag-handle" type="button" title="长按后拖动排序" aria-label="长按后拖动排序">≡</button><input data-field="name" maxlength="20" autocomplete="off" aria-label="入口名称"/><input data-field="url" inputmode="url" autocomplete="off" aria-label="入口地址"/><button class="delete" type="button">删除</button>`;
    row.querySelector('[data-field="name"]').value = item.name;
    row.querySelector('[data-field="url"]').value = item.url;
    installLongPressDrag(row.querySelector(".drag-handle"), row);
    return row;
  }

  function renderManagerRows() {
    const rows = shadow.querySelector(".manager-rows");
    if (!managerDraft.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "当前没有快捷入口，可点击“新增入口”或“恢复默认四项”。";
      rows.replaceChildren(empty);
      return;
    }
    rows.replaceChildren(...managerDraft.map(managerRow));
  }

  function syncDraftFromRows() {
    const source = new Map(managerDraft.map((item) => [item.id, item]));
    managerDraft = [...shadow.querySelectorAll(".manager-row")].map((row) => {
      const item = source.get(row.dataset.id) || {id:row.dataset.id, tone:"custom"};
      return {...item, name:row.querySelector('[data-field="name"]').value, url:row.querySelector('[data-field="url"]').value};
    });
  }

  function installLongPressDrag(handle, row) {
    let timer = 0;
    let active = false;
    const finish = (event) => {
      clearTimeout(timer);
      if (!active) return;
      active = false;
      suppressManagerClick = true;
      row.classList.remove("dragging");
      try { handle.releasePointerCapture(event.pointerId); } catch {}
      syncDraftFromRows();
      shadow.querySelector(".status").textContent = "顺序已调整，保存后生效";
      setTimeout(() => { suppressManagerClick = false; }, 0);
    };
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        active = true;
        row.classList.add("dragging");
        handle.setPointerCapture?.(event.pointerId);
      }, 420);
    });
    handle.addEventListener("pointermove", (event) => {
      if (!active) return;
      event.preventDefault();
      const rows = [...shadow.querySelectorAll(".manager-row")].filter((item) => item !== row);
      const target = rows.find((item) => event.clientY < item.getBoundingClientRect().top + item.getBoundingClientRect().height / 2);
      const parent = row.parentElement;
      if (target) parent.insertBefore(row, target);
      else parent.append(row);
    });
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
    handle.addEventListener("pointerleave", () => { if (!active) clearTimeout(timer); });
  }

  function appendManagerRow() {
    syncDraftFromRows();
    managerDraft.push({id:`custom-${crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`}`, name:"", url:"https://", tone:"custom"});
    renderManagerRows();
    const input = shadow.querySelector('.manager-row:last-child [data-field="name"]');
    input?.scrollIntoView?.({block:"nearest"});
    input?.focus();
  }

  function handleManagerClick(event) {
    if (suppressManagerClick) return;
    const remove = event.target.closest(".delete");
    if (!remove) return;
    syncDraftFromRows();
    managerDraft = managerDraft.filter((item) => item.id !== remove.closest(".manager-row").dataset.id);
    renderManagerRows();
    shadow.querySelector(".status").textContent = "已从清单移除，保存后生效";
  }

  async function saveManager() {
    const status = shadow.querySelector(".status");
    try {
      syncDraftFromRows();
      const cleaned = managerDraft.map((item, index) => {
        const name = String(item.name || "").trim().slice(0, 20);
        if (!name) throw new Error(`第 ${index + 1} 项缺少名称`);
        return {...item, name, url:helpers.normalizeUrl(item.url), tone:item.tone || "custom"};
      });
      if (cleaned.length > 20) throw new Error("快捷入口最多保留 20 个");
      navItems = helpers.cleanLinks(cleaned);
      await chrome.storage.local.set({[STORAGE_KEY]:navItems});
      renderLinks();
      closeManager();
    } catch (error) {
      status.textContent = String(error?.message || error || "无法保存");
    }
  }

  async function restoreDefaults() {
    navItems = cloneDefaults();
    managerDraft = cloneDefaults();
    await chrome.storage.local.set({[STORAGE_KEY]:navItems});
    shadow.querySelector(".confirm-layer").hidden = true;
    shadow.querySelector(".status").textContent = "已恢复默认四项";
    renderLinks();
    renderManagerRows();
  }

  async function openLink(url, button) {
    button.disabled = true;
    try {
      const normalized = helpers.normalizeUrl(url);
      const result = await chrome.runtime.sendMessage({type:"TEMU_TAB", matches:[helpers.matchPattern(normalized)], url:normalized});
      if (!result?.success && !result?.tabId) throw new Error(result?.error || "打开失败");
    } catch (error) {
      const status = shadow?.querySelector(".status");
      if (status) status.textContent = String(error?.message || error || "暂时无法打开");
    } finally {
      button.disabled = false;
    }
  }

  function updateActiveLink(force = false) {
    if (!shadow) return;
    if (!force && lastUrl === location.href) return;
    lastUrl = location.href;
    for (const button of shadow.querySelectorAll(".nav")) {
      const active = helpers.isCurrent(location.href, button.dataset.url);
      button.classList.toggle("active", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
  }

  function clearViewportFallbackStyles() {
    for (const property of ["position", "top", "left", "right", "transform", "z-index"]) {
      host.style.removeProperty(property);
    }
  }

  function attachViewportFallback() {
    if (!document.body) return;
    if (!host) createHost();
    if (host.parentElement !== document.body) document.body.append(host);
    mountedContainer = document.body;
    host.style.setProperty("position", "fixed", "important");
    host.style.setProperty("top", "8px", "important");
    host.style.setProperty("left", "50%", "important");
    host.style.setProperty("transform", "translateX(-50%)", "important");
    host.style.setProperty("z-index", "2147482000", "important");
    host.style.setProperty("width", "min(980px, calc(100vw - 24px))", "important");
    host.style.setProperty("max-width", "980px", "important");
    host.style.setProperty("margin", "0", "important");
    updateActiveLink();
  }

  function attachNavigation() {
    const adContainer = findAdContainer();
    const container = adContainer || findSellerHeaderCenter();
    if (!container) {
      attachViewportFallback();
      return;
    }
    if (!host) createHost();
    if (host.parentElement !== container) container.append(host);
    mountedContainer = container;
    clearViewportFallbackStyles();
    if (adContainer) {
      for (const child of container.children) {
        if (child !== host) child.style.setProperty("display", "none", "important");
      }
      container.style.setProperty("display", "block", "important");
      container.style.setProperty("flex", "1 1 900px", "important");
      container.style.setProperty("width", "clamp(560px, 48vw, 980px)", "important");
      container.style.setProperty("max-width", "980px", "important");
      container.style.setProperty("height", "42px", "important");
      host.style.setProperty("width", "100%", "important");
      host.style.removeProperty("max-width");
      host.style.removeProperty("margin");
    } else {
      container.style.setProperty("display", "flex", "important");
      container.style.setProperty("align-items", "center", "important");
      container.style.setProperty("justify-content", "center", "important");
      container.style.setProperty("min-width", "0", "important");
      host.style.setProperty("width", "min(980px, calc(100% - 24px))", "important");
      host.style.setProperty("max-width", "980px", "important");
      host.style.setProperty("margin", "0 auto", "important");
    }
    container.style.setProperty("overflow", "visible", "important");
    updateActiveLink();
  }

  function scheduleAttach() {
    if (host?.isConnected && isRenderedContainer(mountedContainer)) return;
    if (attachTimer) return;
    attachTimer = setTimeout(() => {
      attachTimer = 0;
      attachNavigation();
    }, 180);
  }

  chrome.storage.local.get([STORAGE_KEY, LEGACY_STORAGE_KEY]).then(async (saved) => {
    if (Array.isArray(saved[STORAGE_KEY])) {
      const previous = helpers.cleanLinks(saved[STORAGE_KEY]);
      navItems = helpers.migrateDefaultSellerUrls(previous);
      if (JSON.stringify(navItems) !== JSON.stringify(previous)) await chrome.storage.local.set({[STORAGE_KEY]:navItems});
    } else {
      const legacy = helpers.cleanLinks(saved[LEGACY_STORAGE_KEY]).map((item) => ({...item, tone:"custom"}));
      navItems = helpers.cleanLinks([...cloneDefaults(), ...legacy]);
      await chrome.storage.local.set({[STORAGE_KEY]:navItems});
    }
    renderLinks();
  }).catch(() => {});
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area !== "local" || !changes[STORAGE_KEY]) return;
    navItems = helpers.cleanLinks(changes[STORAGE_KEY].newValue);
    renderLinks();
  });
  new MutationObserver(scheduleAttach).observe(document.documentElement, {childList:true, subtree:true});
  setInterval(() => {
    attachNavigation();
    updateActiveLink();
  }, 1000);
  attachNavigation();
})();
