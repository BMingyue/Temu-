(() => {
  'use strict';

  const ROOT_ID = '__batch_delisting_assistant_root__';
  const STORAGE_KEY = '__batch_delisting_assistant_v1__';
  const MAX_HISTORY = 500;
  const FAB_MARGIN = 10;
  const FAB_DRAG_THRESHOLD = 5;

  if (document.getElementById(ROOT_ID)) {
    document.getElementById(ROOT_ID).querySelector('.bda-panel')?.classList.remove('bda-hidden');
    return;
  }

  const persisted = loadPersisted();
  const state = {
    running: false,
    paused: false,
    stopping: false,
    completed: 0,
    failed: 0,
    total: 0,
    current: '',
    history: Array.isArray(persisted.history) ? persisted.history : []
  };

  const root = document.createElement('div');
  root.id = ROOT_ID;
  root.innerHTML = `
    <style>
      #${ROOT_ID}, #${ROOT_ID} * { box-sizing: border-box; }
      #${ROOT_ID} { font-family: system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif; color: #172033; }
      #${ROOT_ID} .bda-panel { position: fixed; right: 18px; bottom: 18px; z-index: 2147483647; width: 390px; max-height: calc(100vh - 36px); overflow: auto; border: 1px solid #cfd7e6; border-radius: 14px; background: #fff; box-shadow: 0 16px 50px rgba(24,39,75,.22); }
      #${ROOT_ID} .bda-hidden { display: none; }
      #${ROOT_ID} .bda-head { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; justify-content: space-between; padding: 13px 15px; color: #fff; background: linear-gradient(135deg,#2468f2,#5b3ee4); }
      #${ROOT_ID} .bda-title { font-size: 16px; font-weight: 750; }
      #${ROOT_ID} .bda-version { margin-left: 6px; font-size: 10px; opacity: .75; }
      #${ROOT_ID} .bda-icon-btn { border: 0; padding: 2px 5px; color: #fff; background: transparent; font-size: 20px; cursor: pointer; }
      #${ROOT_ID} .bda-body { padding: 14px; }
      #${ROOT_ID} label { display: block; margin: 0 0 6px; color: #344055; font-size: 12px; font-weight: 650; }
      #${ROOT_ID} textarea, #${ROOT_ID} select, #${ROOT_ID} input[type=number] { width: 100%; border: 1px solid #ccd5e3; border-radius: 7px; padding: 8px 9px; color: #172033; background: #fff; font: inherit; font-size: 13px; outline: none; }
      #${ROOT_ID} textarea:focus, #${ROOT_ID} select:focus, #${ROOT_ID} input:focus { border-color: #2468f2; box-shadow: 0 0 0 2px rgba(36,104,242,.12); }
      #${ROOT_ID} textarea { min-height: 104px; resize: vertical; line-height: 1.45; }
      #${ROOT_ID} .bda-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 11px; }
      #${ROOT_ID} .bda-actions { display: flex; gap: 8px; margin-top: 10px; }
      #${ROOT_ID} button { border: 1px solid #cbd4e2; border-radius: 7px; padding: 8px 10px; color: #344055; background: #fff; font: inherit; font-size: 12px; font-weight: 650; cursor: pointer; }
      #${ROOT_ID} button:hover { filter: brightness(.98); }
      #${ROOT_ID} button:disabled { opacity: .48; cursor: not-allowed; }
      #${ROOT_ID} .bda-primary { flex: 1; border-color: #2468f2; color: #fff; background: #2468f2; }
      #${ROOT_ID} .bda-danger { color: #c43d2f; }
      #${ROOT_ID} .bda-options { margin-top: 11px; padding: 9px 10px; border-radius: 8px; background: #f5f7fb; }
      #${ROOT_ID} .bda-history { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 9px; padding-top: 8px; border-top: 1px solid #dfe5ef; }
      #${ROOT_ID} .bda-history span { color: #657086; font-size: 11px; }
      #${ROOT_ID} .bda-history-actions { display: flex; gap: 6px; }
      #${ROOT_ID} .bda-history-actions button { padding: 5px 7px; font-size: 11px; }
      #${ROOT_ID} .bda-check { display: flex; align-items: flex-start; gap: 7px; margin: 5px 0; font-weight: 500; line-height: 1.4; cursor: pointer; }
      #${ROOT_ID} .bda-check input { margin-top: 2px; }
      #${ROOT_ID} .bda-status { margin-top: 11px; padding: 9px 10px; border-radius: 8px; color: #44516a; background: #eef3ff; font-size: 12px; line-height: 1.45; }
      #${ROOT_ID} .bda-progress { height: 6px; margin-top: 7px; overflow: hidden; border-radius: 99px; background: #dbe4f6; }
      #${ROOT_ID} .bda-progress > i { display: block; width: 0%; height: 100%; background: #2468f2; transition: width .2s ease; }
      #${ROOT_ID} .bda-log { max-height: 126px; margin-top: 9px; overflow: auto; border: 1px solid #e0e5ed; border-radius: 7px; padding: 7px 8px; color: #5d687a; background: #fafbfc; font: 11px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace; white-space: pre-wrap; }
      #${ROOT_ID} .bda-note { margin-top: 9px; color: #7a8495; font-size: 11px; line-height: 1.45; }
      #${ROOT_ID} .bda-fab { position: fixed; right: 18px; bottom: 18px; z-index: 2147483647; display: none; width: 48px; height: 48px; border: 0; border-radius: 50%; color: #fff; background: #2468f2; box-shadow: 0 9px 25px rgba(36,104,242,.35); font-size: 12px; font-weight: 750; cursor: grab; touch-action: none; user-select: none; -webkit-user-select: none; }
      #${ROOT_ID} .bda-fab.bda-dragging { cursor: grabbing; box-shadow: 0 12px 30px rgba(36,104,242,.45); }
      #${ROOT_ID} .bda-hidden + .bda-fab { display: block; }
    </style>
    <section class="bda-panel bda-hidden" aria-label="商品批量下架助手">
      <header class="bda-head">
        <div><span class="bda-title">商品批量下架助手</span><span class="bda-version">工作台版 0.15.10</span></div>
        <button class="bda-icon-btn" data-act="hide" title="收起" type="button">−</button>
      </header>
      <div class="bda-body">
        <label for="bda-ids">待处理编号（每行一个，也支持空格、逗号分隔）</label>
        <textarea id="bda-ids" placeholder="先在商品列表中复制编号，再点“读取剪贴板”\n例如：\n84368635964\n84368635965"></textarea>
        <div class="bda-actions">
          <button data-act="clipboard" type="button">读取剪贴板</button>
          <button data-act="dedupe" type="button">整理并去重</button>
          <button data-act="clear" type="button">清空</button>
        </div>
        <div class="bda-row">
          <div>
            <label for="bda-id-type">编号类型</label>
            <select id="bda-id-type">
              <option value="SKC ID">SKC ID</option>
              <option value="SKU ID">SKU ID</option>
              <option value="SPU ID">SPU ID</option>
            </select>
          </div>
          <div>
            <label for="bda-reason">下架原因</label>
            <select id="bda-reason">
              <option value="业务调整下架">业务调整下架</option>
              <option value="亏损下架">亏损下架</option>
              <option value="经营/库存策略下架">经营/库存策略下架</option>
              <option value="节假日原因下架">节假日原因下架</option>
              <option value="物流问题下架">物流问题下架</option>
              <option value="测款失败下架">测款失败下架</option>
            </select>
          </div>
        </div>
        <div class="bda-row">
          <div>
            <label for="bda-delay">每条间隔（毫秒）</label>
            <input id="bda-delay" type="number" min="1000" max="30000" step="500" value="1800">
          </div>
          <div>
            <label for="bda-retry">失败重试次数</label>
            <input id="bda-retry" type="number" min="0" max="5" step="1" value="1">
          </div>
        </div>
        <div class="bda-options">
          <label class="bda-check"><input id="bda-dry-run" type="checkbox" checked> 演练模式：只填第一条，不点击“申请下架”</label>
          <label class="bda-check"><input id="bda-skip-history" type="checkbox" checked> 跳过本机记录中已成功的编号</label>
          <div class="bda-history">
            <span data-role="history-info">历史已完成 0 个</span>
            <div class="bda-history-actions">
              <button data-act="exclude-history" type="button">从列表排除</button>
              <button data-act="clear-history" type="button">清空历史</button>
            </div>
          </div>
        </div>
        <div class="bda-actions">
          <button class="bda-primary" data-act="start" type="button">开始执行</button>
          <button data-act="pause" type="button" disabled>暂停</button>
          <button class="bda-danger" data-act="stop" type="button" disabled>停止</button>
        </div>
        <div class="bda-status" role="status">
          <div data-role="status-text">等待导入编号</div>
          <div class="bda-progress"><i data-role="progress"></i></div>
        </div>
        <div class="bda-log" data-role="log">尚未开始</div>
        <div class="bda-note">正式执行会向平台提交真实下架申请。运行时请保持页面可见，不要手动操作客服窗口。</div>
      </div>
    </section>
    <button class="bda-fab" data-act="show" type="button" title="拖动调整位置；双击恢复右下角；单击展开助手" aria-label="下架助手：可拖动，双击恢复默认位置">下架</button>
  `;
  document.documentElement.appendChild(root);

  const $ = (selector) => root.querySelector(selector);
  const els = {
    panel: $('.bda-panel'),
    fab: $('.bda-fab'),
    ids: $('#bda-ids'),
    idType: $('#bda-id-type'),
    reason: $('#bda-reason'),
    delay: $('#bda-delay'),
    retry: $('#bda-retry'),
    dryRun: $('#bda-dry-run'),
    skipHistory: $('#bda-skip-history'),
    start: $('[data-act="start"]'),
    pause: $('[data-act="pause"]'),
    stop: $('[data-act="stop"]'),
    status: $('[data-role="status-text"]'),
    progress: $('[data-role="progress"]'),
    log: $('[data-role="log"]')
  };
  els.historyInfo = $('[data-role="history-info"]');

  hydrateSettings();
  restoreFabPosition();
  updateHistoryInfo();
  bindEvents();
  updateStatus('等待导入编号');

  function bindEvents() {
    bindFabDrag();

    let fabClickTimer = null;
    root.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-act]');
      if (!button) return;
      const action = button.dataset.act;
      if (action === 'hide') els.panel.classList.add('bda-hidden');
      if (action === 'show') {
        event.preventDefault();
        if (els.fab.dataset.suppressClick === 'true') return;
        if (event.detail > 1) {
          if (fabClickTimer) clearTimeout(fabClickTimer);
          fabClickTimer = null;
          resetFabPosition();
          return;
        }
        if (fabClickTimer) clearTimeout(fabClickTimer);
        fabClickTimer = setTimeout(() => {
          fabClickTimer = null;
          els.panel.classList.remove('bda-hidden');
        }, 220);
        return;
      }
      if (action === 'clear' && !state.running) {
        els.ids.value = '';
        updateStatus('已清空');
      }
      if (action === 'dedupe' && !state.running) normalizeTextarea();
      if (action === 'exclude-history' && !state.running) excludeCompletedFromTextarea();
      if (action === 'clear-history' && !state.running) clearHistory();
      if (action === 'clipboard' && !state.running) await readClipboard();
      if (action === 'start' && !state.running) await startRun();
      if (action === 'pause' && state.running) togglePause();
      if (action === 'stop' && state.running) {
        state.stopping = true;
        state.paused = false;
        updateStatus('正在安全停止…');
      }
    });

    for (const control of [els.idType, els.reason, els.delay, els.retry, els.dryRun, els.skipHistory]) {
      control.addEventListener('change', saveSettings);
    }
  }

  function bindFabDrag() {
    let drag = null;

    els.fab.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const rect = els.fab.getBoundingClientRect();
      drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        left: rect.left,
        top: rect.top,
        moved: false
      };
      els.fab.dataset.suppressClick = 'false';
      els.fab.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });

    els.fab.addEventListener('pointermove', (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < FAB_DRAG_THRESHOLD) return;
      if (!drag.moved) {
        drag.moved = true;
        els.fab.classList.add('bda-dragging');
      }
      setFabPosition(drag.left + dx, drag.top + dy);
      event.preventDefault();
    });

    const finishDrag = (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const moved = drag.moved;
      drag = null;
      els.fab.classList.remove('bda-dragging');
      try { els.fab.releasePointerCapture?.(event.pointerId); } catch (_) { /* capture may already be gone */ }
      if (!moved) return;
      els.fab.dataset.suppressClick = 'true';
      const rect = els.fab.getBoundingClientRect();
      const position = setFabPosition(rect.left, rect.top);
      persistFabPosition(position);
      setTimeout(() => { els.fab.dataset.suppressClick = 'false'; }, 250);
      event.preventDefault();
    };

    els.fab.addEventListener('pointerup', finishDrag);
    els.fab.addEventListener('pointercancel', finishDrag);
    els.fab.addEventListener('dblclick', (event) => {
      event.preventDefault();
      event.stopPropagation();
      resetFabPosition();
    });

    window.addEventListener('resize', () => {
      if (!hasCustomFabPosition()) return;
      const rect = els.fab.getBoundingClientRect();
      persistFabPosition(setFabPosition(rect.left, rect.top));
    });
  }

  function setFabPosition(left, top) {
    const width = els.fab.offsetWidth || 48;
    const height = els.fab.offsetHeight || 48;
    const maxLeft = Math.max(FAB_MARGIN, window.innerWidth - width - FAB_MARGIN);
    const maxTop = Math.max(FAB_MARGIN, window.innerHeight - height - FAB_MARGIN);
    const position = {
      left: Math.round(clampNumber(left, FAB_MARGIN, maxLeft, FAB_MARGIN)),
      top: Math.round(clampNumber(top, FAB_MARGIN, maxTop, FAB_MARGIN))
    };
    els.fab.style.left = `${position.left}px`;
    els.fab.style.top = `${position.top}px`;
    els.fab.style.right = 'auto';
    els.fab.style.bottom = 'auto';
    return position;
  }

  function hasCustomFabPosition() {
    const position = loadPersisted().fabPosition;
    return Number.isFinite(Number(position?.left)) && Number.isFinite(Number(position?.top));
  }

  function restoreFabPosition() {
    const position = persisted.fabPosition;
    if (!Number.isFinite(Number(position?.left)) || !Number.isFinite(Number(position?.top))) return;
    setFabPosition(Number(position.left), Number(position.top));
  }

  function persistFabPosition(position) {
    savePersisted({ ...loadPersisted(), fabPosition: position });
  }

  function resetFabPosition() {
    els.fab.style.removeProperty('left');
    els.fab.style.removeProperty('top');
    els.fab.style.removeProperty('right');
    els.fab.style.removeProperty('bottom');
    const next = loadPersisted();
    delete next.fabPosition;
    savePersisted(next);
  }

  async function readClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) throw new Error('剪贴板为空');
      els.ids.value = text;
      normalizeTextarea();
    } catch (error) {
      log(`读取剪贴板失败：${error.message}`);
      updateStatus('无法读取剪贴板，请直接粘贴到输入框');
      els.ids.focus();
    }
  }

  function normalizeTextarea() {
    const ids = parseIds(els.ids.value);
    els.ids.value = ids.join('\n');
    updateStatus(ids.length ? `已准备 ${ids.length} 个不重复编号` : '没有识别到有效编号');
    log(ids.length ? `整理完成：${ids.length} 个编号` : '未识别到编号，请检查复制内容');
    return ids;
  }

  function excludeCompletedFromTextarea() {
    const ids = parseIds(els.ids.value);
    const succeeded = successfulHistoryIds();
    const remaining = ids.filter((id) => !succeeded.has(id));
    const removed = ids.length - remaining.length;
    els.ids.value = remaining.join('\n');
    updateStatus(removed
      ? `已排除 ${removed} 个历史完成编号，剩余 ${remaining.length} 个`
      : `未发现历史完成编号，当前 ${remaining.length} 个`);
    log(removed ? `从待处理列表排除 ${removed} 个已完成编号` : '待处理列表中没有已完成编号');
  }

  function clearHistory() {
    const count = successfulHistoryIds().size;
    if (!count) {
      updateStatus('完成历史为空');
      return;
    }
    if (!window.confirm(`确定清空本机记录的 ${count} 个已完成编号吗？\n清空后再次导入这些编号将不会自动跳过。`)) return;
    state.history = [];
    savePersisted({ ...loadPersisted(), history: [] });
    updateHistoryInfo();
    updateStatus('已清空完成历史');
    log(`已清空 ${count} 个历史完成编号`);
  }

  function parseIds(raw) {
    const ignored = new Set(['SKC', 'SKU', 'SPU', 'ID', 'SKCID', 'SKUID', 'SPUID']);
    const seen = new Set();
    const result = [];
    const normalized = String(raw || '')
      .replace(/(?:SKC|SKU|SPU)\s*ID\s*[:：]?/gi, ' ')
      .replace(/[，,;；|\t\r\n]+/g, ' ');
    for (const token of normalized.split(/\s+/)) {
      const id = token.trim().replace(/^["'\[\](){}]+|["'\[\](){}]+$/g, '');
      if (!id || id.length < 4 || ignored.has(id.toUpperCase())) continue;
      if (!/^[A-Za-z0-9_-]+$/.test(id)) continue;
      if (!seen.has(id)) {
        seen.add(id);
        result.push(id);
      }
    }
    return result;
  }

  async function startRun() {
    let ids = normalizeTextarea();
    if (!ids.length) return;

    if (els.skipHistory.checked) {
      const succeeded = successfulHistoryIds();
      const before = ids.length;
      ids = ids.filter((id) => !succeeded.has(id));
      if (before !== ids.length) log(`已跳过 ${before - ids.length} 个历史成功编号`);
      if (!ids.length) {
        updateStatus('这些编号此前均已成功处理');
        return;
      }
    }

    const dryRun = els.dryRun.checked;
    const confirmed = window.confirm(
      dryRun
        ? `将以演练模式填入第一条（${ids[0]}），不会点击“申请下架”。继续吗？`
        : `即将真实提交 ${ids.length} 条下架申请。\n编号类型：${els.idType.value}\n下架原因：${els.reason.value}\n\n请确认编号和原因无误。`
    );
    if (!confirmed) return;

    saveSettings();
    state.running = true;
    state.paused = false;
    state.stopping = false;
    state.completed = 0;
    state.failed = 0;
    state.total = dryRun ? 1 : ids.length;
    state.current = '';
    setControlsRunning(true);
    clearLog();
    log(dryRun ? '开始演练，最终提交按钮不会被点击' : `开始正式执行，共 ${ids.length} 条`);

    try {
      await ensureChatReady();
      for (const id of ids) {
        if (dryRun && state.completed + state.failed >= 1) break;
        if (state.stopping) break;
        await waitWhilePaused();
        if (state.stopping) break;

        state.current = id;
        updateStatus(`正在处理 ${state.completed + state.failed + 1}/${state.total}：${id}`);
        let success = false;
        let lastError = null;
        const retryCount = clampNumber(els.retry.value, 0, 5, 1);

        for (let attempt = 0; attempt <= retryCount && !success; attempt += 1) {
          try {
            if (attempt > 0) log(`${id} 第 ${attempt + 1} 次尝试`);
            const result = await submitOne(id, dryRun);
            success = true;
            state.completed += 1;
            if (!dryRun) addHistory(id, true, '提交成功');
            log(dryRun ? `${id} 已填入，演练停止在提交前` : `✓ ${id} 已提交`);
            if (result === 'dry-run') break;
          } catch (error) {
            lastError = error;
            log(`× ${id}：${error.message}`);
            if (attempt < retryCount && !error.noRetry) await sleep(1200);
            if (error.noRetry) break;
          }
        }

        if (!success) {
          state.failed += 1;
          addHistory(id, false, lastError?.message || '未知错误');
        }
        updateProgress();
        if (dryRun) break;
        if (!state.stopping) await sleep(clampNumber(els.delay.value, 1000, 30000, 1800));
      }

      if (state.stopping) {
        updateStatus(`已停止：成功 ${state.completed}，失败 ${state.failed}`);
      } else if (dryRun) {
        updateStatus('演练完成：表单已填好，未提交。请核对页面');
      } else {
        updateStatus(`处理完成：成功 ${state.completed}，失败 ${state.failed}`);
      }
    } catch (error) {
      log(`流程中断：${error.message}`);
      updateStatus(`流程中断：${error.message}`);
    } finally {
      state.running = false;
      state.paused = false;
      state.stopping = false;
      state.current = '';
      setControlsRunning(false);
    }
  }

  async function ensureChatReady() {
    updateStatus('正在打开客服会话…');
    if (findByText('发商品', { exact: true })) return;

    if (!findByText('联系官方客服', { exact: true })) {
      const service = await waitFor(() => findByText('客服', { exact: true }), 8000, '未找到顶部“客服”入口');
      safeClick(service);
    }

    const contactOrChat = await waitFor(() =>
      findByText('联系官方客服', { exact: true }) ||
      findChatEditor() ||
      findByText('发商品', { exact: true }),
    12000, '客服面板未打开');

    if (normalizedText(contactOrChat) === '联系官方客服') {
      safeClick(contactOrChat);
      await sleep(800);
    }

    if (findByText('发商品', { exact: true })) return;

    const editor = await waitFor(findChatEditor, 15000, '未找到客服消息输入框');
    setControlValue(editor, '商品下架');
    const send = await waitFor(() => findByText('发送', { exact: true }), 5000, '未找到客服“发送”按钮');
    safeClick(send);
    await waitFor(() => findByText('发商品', { exact: true }), 20000, '客服未返回“发商品”入口，请稍后重试');
    log('客服下架入口已准备好');
  }

  async function submitOne(id, dryRun) {
    await waitWhilePaused();
    if (state.stopping) throw new Error('已停止');
    if (findConfirmDialog()) {
      const error = new Error('页面已有待处理的“确认下架”弹窗，请先核对上一条结果');
      error.noRetry = true;
      throw error;
    }

    let dialog = findDelistingDialog();
    if (!dialog) {
      const sendProduct = await waitFor(() => findByText('发商品', { exact: true }), 12000, '未找到“发商品”入口');
      safeClick(sendProduct);
      dialog = await waitFor(findDelistingDialog, 12000, '下架商品表单未弹出');
    }

    await selectField(dialog, '商品ID', els.idType.value);
    const idInput = await waitFor(() => findIdInput(dialog), 5000, '未找到商品编号输入框');
    setControlValue(idInput, id);
    await selectField(dialog, '下架原因', els.reason.value);

    if (dryRun) return 'dry-run';

    const apply = await waitFor(() => findByText('申请下架', { exact: true, within: dialog }), 5000, '未找到“申请下架”按钮');
    if (apply.disabled || apply.getAttribute('aria-disabled') === 'true') {
      throw new Error('“申请下架”按钮不可用，请检查编号或原因');
    }
    const priorSuccess = findSubmissionSuccess();
    safeClick(apply);
    try {
      const result = await waitFor(() => {
        const confirmation = findConfirmDialog();
        if (confirmation) return { confirmation };
        const success = findSubmissionSuccess();
        if (success && success !== priorSuccess) return { submitted: true };
        return null;
      }, 18000, '申请下架后未出现确认弹窗或成功提示，请检查页面');

      if (result.confirmation) {
        log(`${id} 等待平台确认按钮倒计时…`);
        const confirm = await waitFor(() => {
          const confirmation = findConfirmDialog();
          if (!confirmation) return null;
          const button = findConfirmButton(confirmation);
          return button && !button.disabled && button.getAttribute('aria-disabled') !== 'true' ? button : null;
        }, 20000, '确认下架按钮长时间不可用，请检查弹窗');
        await waitWhilePaused();
        if (state.stopping) throw new Error('用户已停止');
        safeClick(confirm);
        await waitFor(() => {
          if (findConfirmDialog()) return null;
          const success = findSubmissionSuccess();
          return (success && success !== priorSuccess) || !findDelistingDialog();
        }, 18000, '点击确认后未收到完成结果，请检查页面');
      }
    } catch (error) {
      error.noRetry = true;
      throw error;
    }
    return 'submitted';
  }

  function findSubmissionSuccess() {
    return findByText(['提交成功', '申请成功', '发送成功'], { exact: false });
  }

  function findConfirmButton(dialog) {
    return queryDeep('button,[role="button"]', dialog)
      .filter(isVisible)
      .find((button) => /^确认(?:\s*[（(]\s*\d+\s*s\s*[)）])?$/i.test(normalizedText(button))) || null;
  }

  function findConfirmDialog() {
    const hasConfirmControls = (node) =>
      /确认下架[?？]?/.test(normalizedText(node))
      && !!findConfirmButton(node)
      && !!queryDeep('button,[role="button"]', node).find((button) => isVisible(button) && normalizedText(button) === '取消');
    const dialogs = queryDeep('[role="dialog"],.el-dialog,.ant-modal,.ant-modal-content,[class*="modal"],[class*="Modal"],[class*="dialog"],[class*="Dialog"]')
      .filter(isVisible)
      .filter(hasConfirmControls);
    if (dialogs.length) return smallestArea(dialogs);

    const titles = queryDeep('h1,h2,h3,div,span,p')
      .filter(isVisible)
      .filter((node) => /^确认下架[?？]?$/.test(normalizedText(node)));
    for (const title of titles) {
      let node = title.parentElement;
      for (let i = 0; i < 8 && node && node !== document.body; i += 1, node = node.parentElement) {
        if (hasConfirmControls(node)) return node;
      }
    }
    return null;
  }

  async function selectField(dialog, labelText, optionText) {
    const nativeSelect = findNativeSelectNearLabel(dialog, labelText);
    if (nativeSelect) {
      const option = [...nativeSelect.options].find((item) => normalizedText(item) === optionText);
      if (!option) throw new Error(`${labelText}中没有“${optionText}”`);
      nativeSelect.value = option.value;
      nativeSelect.dispatchEvent(new Event('input', { bubbles: true }));
      nativeSelect.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }

    const current = findDropdownNearLabel(dialog, labelText);
    if (!current) throw new Error(`未找到“${labelText}”选择框`);
    if (normalizedText(current).includes(optionText)) return;
    safeClick(current);
    await sleep(250);
    const option = await waitFor(() => findByText(optionText, { exact: true }), 5000, `未找到选项“${optionText}”`);
    safeClick(option);
    await sleep(220);
  }

  function findDelistingDialog() {
    const selectors = '[role="dialog"], .el-dialog, .ant-modal, .ant-modal-content, .modal';
    const dialogs = queryDeep(selectors)
      .filter(isVisible)
      .filter((el) => {
        const text = normalizedText(el);
        return text.includes('发送下架商品信息')
          && text.includes('商品ID')
          && text.includes('下架原因')
          && text.includes('申请下架');
      });
    if (dialogs.length) return smallestArea(dialogs);

    const title = findByText('发送下架商品信息', { exact: true });
    if (!title) return null;
    let node = title;
    for (let i = 0; i < 7 && node?.parentElement; i += 1) {
      node = node.parentElement;
      const text = normalizedText(node);
      if (text.includes('商品ID') && text.includes('下架原因') && text.includes('申请下架')) return node;
    }
    return null;
  }

  function findIdInput(dialog) {
    const inputs = queryDeep('input:not([type="hidden"]), textarea', dialog).filter(isVisible);
    return inputs.find((el) => /完整.*(?:SKC|SKU|SPU)|商品.*ID|SKC|SKU|SPU/i.test(el.placeholder || el.getAttribute('aria-label') || ''))
      || inputs.find((el) => !el.disabled && !el.readOnly);
  }

  function findChatEditor() {
    const controls = queryDeep('textarea, input:not([type="hidden"]), [contenteditable="true"]').filter(isVisible);
    return controls.find((el) => /简单描述|遇到的问题|输入消息|请输入消息/.test(el.placeholder || el.getAttribute('aria-label') || ''))
      || controls.find((el) => el.getAttribute('contenteditable') === 'true' && findByText('发送', { exact: true }));
  }

  function findNativeSelectNearLabel(dialog, labelText) {
    const label = findFieldLabel(dialog, labelText);
    if (!label) return null;
    const row = nearestFieldRow(label, dialog);
    return row?.querySelector('select') || null;
  }

  function findDropdownNearLabel(dialog, labelText) {
    const label = findFieldLabel(dialog, labelText);
    if (!label) return null;
    const row = nearestFieldRow(label, dialog);
    if (!row) return null;
    const selectors = [
      '[role="combobox"]', '.el-select', '.ant-select', '[class*="select"]',
      'input[readonly]', 'button', '[aria-haspopup="listbox"]'
    ];
    for (const selector of selectors) {
      const candidate = [...row.querySelectorAll(selector)].find((el) => isVisible(el) && !label.contains(el));
      if (candidate) return candidate;
    }
    return [...row.children].find((el) => el !== label && isVisible(el)) || null;
  }

  function findFieldLabel(dialog, labelText) {
    const candidates = queryDeep('label,span,div', dialog)
      .filter(isVisible)
      .filter((element) => {
        const text = normalizedText(element)
          .replace(/^[*＊\s]+/, '')
          .replace(/[:：]\s*$/, '');
        return text === labelText;
      });
    return smallestArea(candidates);
  }

  function nearestFieldRow(label, boundary) {
    let node = label.parentElement;
    for (let i = 0; i < 5 && node && node !== boundary; i += 1) {
      const text = normalizedText(node);
      const controls = node.querySelectorAll('input,select,button,[role="combobox"],[class*="select"]');
      if (controls.length && text.length < 180) return node;
      node = node.parentElement;
    }
    return label.parentElement;
  }

  function findByText(textOrTexts, options = {}) {
    const texts = Array.isArray(textOrTexts) ? textOrTexts : [textOrTexts];
    const exact = options.exact !== false;
    const within = options.within || document;
    const candidates = [];
    for (const node of queryDeep('button,a,[role="button"],li,span,div,p', within)) {
      if (!isVisible(node) || root.contains(node)) continue;
      const text = normalizedText(node);
      if (!text || text.length > 240) continue;
      for (const target of texts) {
        const matches = exact ? text === target : text.includes(target);
        if (!matches) continue;
        const clickable = node.closest('button,a,[role="button"],[role="option"],li,[tabindex]') || node;
        if (!isVisible(clickable) || root.contains(clickable)) continue;
        const rect = clickable.getBoundingClientRect();
        const score = (text === target ? 100000 : 0)
          + (/^(BUTTON|A|LI)$/.test(clickable.tagName) ? 10000 : 0)
          - Math.max(1, rect.width * rect.height);
        candidates.push({ element: clickable, score });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.element || null;
  }

  function queryDeep(selector, start = document) {
    const result = [];
    const visited = new Set();
    const scan = (scope) => {
      if (!scope || visited.has(scope)) return;
      visited.add(scope);
      try { result.push(...scope.querySelectorAll(selector)); } catch (_) { /* ignore */ }
      let elements = [];
      try { elements = scope.querySelectorAll('*'); } catch (_) { /* ignore */ }
      for (const el of elements) if (el.shadowRoot) scan(el.shadowRoot);
    };
    scan(start);
    return [...new Set(result)];
  }

  function normalizedText(element) {
    return String(element?.innerText ?? element?.textContent ?? element?.value ?? '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isVisible(element) {
    if (!element || !element.isConnected) return false;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function smallestArea(elements) {
    return [...elements].sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return (ar.width * ar.height) - (br.width * br.height);
    })[0] || null;
  }

  function safeClick(element) {
    element.scrollIntoView?.({ block: 'center', inline: 'center' });
    element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, view: window }));
    element.click();
  }

  function setControlValue(element, value) {
    element.focus();
    if (element.getAttribute('contenteditable') === 'true') {
      element.textContent = value;
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    } else {
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (setter) setter.call(element, value);
      else element.value = value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  async function waitFor(predicate, timeoutMs, errorMessage) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (state.stopping) throw new Error('用户已停止');
      await waitWhilePaused();
      const value = predicate();
      if (value) return value;
      await sleep(180);
    }
    throw new Error(errorMessage || '等待页面响应超时');
  }

  async function waitWhilePaused() {
    while (state.paused && !state.stopping) await sleep(250);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function togglePause() {
    state.paused = !state.paused;
    els.pause.textContent = state.paused ? '继续' : '暂停';
    updateStatus(state.paused ? `已暂停${state.current ? `：${state.current}` : ''}` : '继续执行…');
  }

  function setControlsRunning(running) {
    els.start.disabled = running;
    els.pause.disabled = !running;
    els.stop.disabled = !running;
    els.ids.disabled = running;
    els.idType.disabled = running;
    els.reason.disabled = running;
    els.dryRun.disabled = running;
    if (!running) els.pause.textContent = '暂停';
  }

  function updateStatus(message) {
    els.status.textContent = message;
    updateProgress();
  }

  function updateProgress() {
    const done = state.completed + state.failed;
    const percent = state.total ? Math.min(100, Math.round(done / state.total * 100)) : 0;
    els.progress.style.width = `${percent}%`;
  }

  function clearLog() {
    els.log.textContent = '';
  }

  function log(message) {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    els.log.textContent += `${els.log.textContent ? '\n' : ''}[${time}] ${message}`;
    els.log.scrollTop = els.log.scrollHeight;
  }

  function addHistory(id, ok, message) {
    state.history = state.history.filter((item) => item.id !== id);
    state.history.push({ id, ok, message, at: new Date().toISOString() });
    state.history = state.history.slice(-MAX_HISTORY);
    savePersisted({ ...loadPersisted(), history: state.history });
    updateHistoryInfo();
  }

  function successfulHistoryIds() {
    return new Set(state.history.filter((item) => item.ok).map((item) => item.id));
  }

  function updateHistoryInfo() {
    const count = successfulHistoryIds().size;
    els.historyInfo.textContent = `历史已完成 ${count} 个`;
  }

  function saveSettings() {
    savePersisted({
      ...loadPersisted(),
      settings: {
        idType: els.idType.value,
        reason: els.reason.value,
        delay: clampNumber(els.delay.value, 1000, 30000, 1800),
        retry: clampNumber(els.retry.value, 0, 5, 1),
        dryRun: els.dryRun.checked,
        skipHistory: els.skipHistory.checked
      },
      history: state.history
    });
  }

  function hydrateSettings() {
    const settings = persisted.settings || {};
    if ([...els.idType.options].some((option) => option.value === settings.idType)) els.idType.value = settings.idType;
    if ([...els.reason.options].some((option) => option.value === settings.reason)) els.reason.value = settings.reason;
    els.delay.value = clampNumber(settings.delay, 1000, 30000, 1800);
    els.retry.value = clampNumber(settings.retry, 0, 5, 1);
    els.dryRun.checked = settings.dryRun !== false;
    els.skipHistory.checked = settings.skipHistory !== false;
  }

  function loadPersisted() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }
    catch (_) { return {}; }
  }

  function savePersisted(value) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); }
    catch (_) { /* storage is optional */ }
  }

  function clampNumber(value, min, max, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
  }
})();
