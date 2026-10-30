/* Unified visibility control for optional workbench overlays. */
function clampWorkbenchFabPosition(left, top, width, height, viewportWidth, viewportHeight, margin = 8) {
  const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const safeWidth = Math.max(0, finite(width, 46));
  const safeHeight = Math.max(0, finite(height, 46));
  const safeViewportWidth = Math.max(safeWidth + margin * 2, finite(viewportWidth, safeWidth + margin * 2));
  const safeViewportHeight = Math.max(safeHeight + margin * 2, finite(viewportHeight, safeHeight + margin * 2));
  const maxLeft = Math.max(margin, safeViewportWidth - safeWidth - margin);
  const maxTop = Math.max(margin, safeViewportHeight - safeHeight - margin);
  return {
    left: Math.round(Math.min(maxLeft, Math.max(margin, finite(left, margin)))),
    top: Math.round(Math.min(maxTop, Math.max(margin, finite(top, margin))))
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = {clampWorkbenchFabPosition};

(() => {
  'use strict';
  if (typeof window === 'undefined' || window.__workbenchPanelManager || !/^https:\/\/agentseller(?:-us)?\.temu\.com$/.test(location.origin)) return;
  window.__workbenchPanelManager = true;

  const STORAGE_KEY = 'workbench.panel.visibility.v1';
  const POSITION_KEY = 'workbench.panel.fab.position.v1';
  const ROOT_ID = 'wbPanelManager';
  const FAB_MARGIN = 8;
  const DRAG_THRESHOLD = 5;
  const PANELS = [
    {key:'daily', label:'每日数据更新', selector:'#wbDailyBar'},
    {key:'enrollment', label:'自动报名状态', selector:'#wbEnrollmentStatus'},
    {key:'activity', label:'活动扫描状态', selector:'#temuActivityEvidenceButton'},
    {key:'price', label:'当前窗口调价', selector:'#wbPriceWindow'},
    {key:'flow', label:'流量页本地工具', selector:'#workbench-flow-tools'},
    {key:'traffic', label:'流量加速助手', selector:'[data-traffic-assistant]'},
    {key:'delisting', label:'商品批量下架', selector:'#__batch_delisting_assistant_root__'},
  ];
  const DEFAULTS = Object.fromEntries(PANELS.map((panel) => [panel.key, false]));
  let settings = {...DEFAULTS};
  let customPosition = false;
  let drag = null;

  function managedElements(panel) {
    return [...document.querySelectorAll(panel.selector)].filter((element) => !element.closest?.(`#${ROOT_ID}`));
  }
  function applyPanel(panel) {
    const visible = settings[panel.key] === true;
    for (const element of managedElements(panel)) {
      if (visible || (panel.key === 'traffic' && element.dataset.trafficRunning === 'true')) {
        element.style.removeProperty('display');
        element.removeAttribute('data-wb-manager-hidden');
      } else {
        element.style.setProperty('display', 'none', 'important');
        element.setAttribute('data-wb-manager-hidden', 'true');
      }
    }
  }
  function applyAll() { for (const panel of PANELS) applyPanel(panel); }
  async function save() { await chrome.storage.local.set({[STORAGE_KEY]:settings}); }

  const host = document.createElement('div');
  host.id = ROOT_ID;
  host.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;font:13px/1.5 system-ui,"Microsoft YaHei",sans-serif;color:#25364b';
  const shadow = host.attachShadow({mode:'open'});
  shadow.innerHTML = `
    <style>
      *{box-sizing:border-box}.fab{width:46px;height:46px;border:0;border-radius:50%;background:#0b7f77;color:#fff;font-weight:800;cursor:grab;box-shadow:0 8px 24px #0b5f5960;touch-action:none;user-select:none;-webkit-user-select:none}.fab.dragging{cursor:grabbing;box-shadow:0 12px 30px #0b5f5980;transform:scale(1.04)}.menu{position:absolute;right:0;bottom:56px;width:238px;padding:12px;border:1px solid #9bc9c5;border-radius:12px;background:#fff;box-shadow:0 14px 38px #122a3940}.menu[hidden]{display:none}.head{display:flex;justify-content:space-between;align-items:center;margin-bottom:7px}.head b{font-size:14px}.close{border:0;background:transparent;font-size:18px;cursor:pointer;color:#60717f}.hint{margin:0 0 8px;color:#71808d;font-size:11px}.item{display:flex;align-items:center;gap:8px;padding:6px 2px;cursor:pointer}.item input{width:16px;height:16px}.actions{display:flex;gap:7px;margin-top:8px;padding-top:9px;border-top:1px solid #e5eeee}.actions button{flex:1;border:1px solid #a9ceca;border-radius:7px;padding:6px;background:#f7ffff;color:#087e76;cursor:pointer}
    </style>
    <button class="fab" type="button" title="拖动调整位置；双击恢复右下角；单击展开工具" aria-label="页面工具：可拖动，双击恢复默认位置">工具</button>
    <section class="menu" hidden aria-label="工作台浮层开关">
      <div class="head"><b>页面工具显示</b><button class="close" type="button" title="关闭">×</button></div>
      <p class="hint">只显示已勾选的面板，选择会自动保存。</p>
      <div class="items"></div>
      <div class="actions"><button type="button" data-action="none">全部隐藏</button><button type="button" data-action="all">全部显示</button></div>
    </section>`;
  const fab = shadow.querySelector('.fab');
  const menu = shadow.querySelector('.menu');
  const items = shadow.querySelector('.items');

  for (const panel of PANELS) {
    const label = document.createElement('label');
    label.className = 'item';
    label.innerHTML = `<input type="checkbox" data-key="${panel.key}"><span>${panel.label}</span>`;
    label.querySelector('input').addEventListener('change', async (event) => {
      settings[panel.key] = event.currentTarget.checked;
      if(panel.key === 'traffic' && settings.traffic){try{const result=await chrome.runtime.sendMessage({type:'WORKBENCH_OPEN_TRAFFIC_ACCELERATOR'});if(!result?.ok)throw Error(result?.error||'面板打开失败')}catch(error){settings.traffic=false;event.currentTarget.checked=false;alert(String(error.message||error))}}
      applyPanel(panel);
      await save().catch(() => {});
    });
    items.appendChild(label);
  }

  function renderChecks() {
    for (const input of shadow.querySelectorAll('input[data-key]')) input.checked = settings[input.dataset.key] === true;
  }
  function setPosition(left, top) {
    const position = clampWorkbenchFabPosition(left, top, fab.offsetWidth || 46, fab.offsetHeight || 46, window.innerWidth, window.innerHeight, FAB_MARGIN);
    host.style.left = `${position.left}px`;
    host.style.top = `${position.top}px`;
    host.style.right = 'auto';
    host.style.bottom = 'auto';
    customPosition = true;
    return position;
  }
  function persistPosition(position) {
    return chrome.storage.local.set({[POSITION_KEY]:position});
  }
  function alignMenu() {
    if (menu.hidden) return;
    const rect = fab.getBoundingClientRect();
    const menuWidth = menu.offsetWidth || 238;
    const menuHeight = menu.offsetHeight || 260;
    menu.style.removeProperty('left');
    menu.style.removeProperty('right');
    menu.style.removeProperty('top');
    menu.style.removeProperty('bottom');
    if (rect.top >= menuHeight + 10) menu.style.bottom = '56px';
    else menu.style.top = '56px';
    if (rect.right >= menuWidth) menu.style.right = '0';
    else menu.style.left = '0';
  }
  async function resetPosition() {
    customPosition = false;
    host.style.removeProperty('left');
    host.style.removeProperty('top');
    host.style.right = '18px';
    host.style.bottom = '18px';
    await chrome.storage.local.remove(POSITION_KEY).catch(() => {});
    alignMenu();
  }

  fab.addEventListener('click', () => {
    if (fab.dataset.suppressClick === 'true') return;
    menu.hidden = !menu.hidden;
    alignMenu();
  });
  shadow.querySelector('.close').addEventListener('click', () => { menu.hidden = true; });
  shadow.querySelector('[data-action="none"]').addEventListener('click', async () => { settings = {...DEFAULTS}; renderChecks(); applyAll(); await save().catch(() => {}); });
  shadow.querySelector('[data-action="all"]').addEventListener('click', async () => { settings = Object.fromEntries(PANELS.map((panel) => [panel.key, true])); renderChecks(); applyAll(); await save().catch(() => {}); });

  fab.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const rect = fab.getBoundingClientRect();
    drag = {pointerId:event.pointerId, startX:event.clientX, startY:event.clientY, left:rect.left, top:rect.top, moved:false};
    fab.dataset.suppressClick = 'false';
    fab.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });
  fab.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    if (!drag.moved) {
      drag.moved = true;
      menu.hidden = true;
      fab.classList.add('dragging');
    }
    setPosition(drag.left + dx, drag.top + dy);
    event.preventDefault();
  });
  const finishDrag = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const moved = drag.moved;
    drag = null;
    fab.classList.remove('dragging');
    try { fab.releasePointerCapture?.(event.pointerId); } catch (_) { /* pointer capture may already be gone */ }
    if (!moved) return;
    fab.dataset.suppressClick = 'true';
    const rect = fab.getBoundingClientRect();
    persistPosition(setPosition(rect.left, rect.top)).catch(() => {});
    setTimeout(() => { fab.dataset.suppressClick = 'false'; }, 250);
    event.preventDefault();
  };
  fab.addEventListener('pointerup', finishDrag);
  fab.addEventListener('pointercancel', finishDrag);
  fab.addEventListener('dblclick', (event) => {
    event.preventDefault();
    event.stopPropagation();
    menu.hidden = true;
    resetPosition();
  });
  window.addEventListener('resize', () => {
    if (!customPosition) return;
    const rect = fab.getBoundingClientRect();
    persistPosition(setPosition(rect.left, rect.top)).catch(() => {});
    alignMenu();
  });

  (document.documentElement || document.body).appendChild(host);
  let applyTimer = 0;
  const observer = new MutationObserver((mutations) => {
    if (!mutations.some((mutation) => mutation.addedNodes.length)) return;
    clearTimeout(applyTimer);
    applyTimer = setTimeout(applyAll, 80);
  });
  observer.observe(document.documentElement, {childList:true, subtree:true});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[STORAGE_KEY]) return;
    const saved = changes[STORAGE_KEY].newValue;
    if (saved && typeof saved === 'object') settings = {...DEFAULTS, ...Object.fromEntries(Object.entries(saved).filter(([key, value]) => key in DEFAULTS && typeof value === 'boolean'))};
    renderChecks();
    applyAll();
  });
  chrome.storage.local.get([STORAGE_KEY, POSITION_KEY]).then((stored) => {
    const saved = stored?.[STORAGE_KEY];
    if (saved && typeof saved === 'object') settings = {...DEFAULTS, ...Object.fromEntries(Object.entries(saved).filter(([key, value]) => key in DEFAULTS && typeof value === 'boolean'))};
    const position = stored?.[POSITION_KEY];
    if (Number.isFinite(Number(position?.left)) && Number.isFinite(Number(position?.top))) setPosition(Number(position.left), Number(position.top));
    renderChecks();
    applyAll();
  }).catch(() => { renderChecks(); applyAll(); });
})();
