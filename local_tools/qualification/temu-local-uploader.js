'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const PRIMARY_STATE_ROOT = path.join(__dirname, 'state');
const FALLBACK_STATE_ROOT = path.join(__dirname, 'logs');

function writableStateRoot() {
  let lastError;
  for (const folder of [...new Set([PRIMARY_STATE_ROOT, FALLBACK_STATE_ROOT])]) {
    const probe = path.join(folder, `.write-probe-${process.pid}-${Date.now()}`);
    try {
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(probe, 'ok', { encoding: 'utf8', flag: 'wx' });
      fs.unlinkSync(probe);
      return folder;
    } catch (error) {
      lastError = error;
      try { if (fs.existsSync(probe)) fs.unlinkSync(probe); } catch (_cleanupError) { /* ignore */ }
    }
  }
  throw lastError || new Error('没有可写的本机状态目录。');
}

const STATE_ROOT = writableStateRoot();
const USING_FALLBACK_STATE = STATE_ROOT !== PRIMARY_STATE_ROOT;

const CONFIG = Object.freeze({
  version: '2.3.6',
  pageUrl: 'https://agentseller.temu.com/govern/upload-qualifications',
  debugPort: 9337,
  materialFolder: path.join(__dirname, 'assets'),
  files: Object.freeze({
    productFront: '产品正面图.jpg',
    productSide: '产品侧视图.jpg',
    washLabel: '水洗唛.jpg',
    packageFront: '包装正视图.jpg',
    qualificationPdf: '自制证书3.0(1).pdf',
  }),
  maxFileBytes: 3 * 1024 * 1024,
  maxPdfBytes: 10 * 1024 * 1024,
  profileFolder: path.join(STATE_ROOT, 'ChromeProfile'),
});

const COMPLIANCE = Object.freeze({
  pageUrl: 'https://agentseller.temu.com/govern/information-supplementation',
  path: '/govern/information-supplementation',
});
const COMPLIANCE_MODE = process.argv.includes('--confirm-warnings');

const LOG_FOLDER = path.join(__dirname, 'logs');
const LATEST_LOG = path.join(LOG_FOLDER, COMPLIANCE_MODE ? 'compliance-latest.log' : 'latest.log');
const IS_DIAGNOSTIC = process.argv.includes('--check')
  || process.argv.includes('--lock-check')
  || process.argv.includes('--page-check')
  || process.argv.includes('--modal-check');
const ACTIVE_LOG = IS_DIAGNOSTIC ? path.join(LOG_FOLDER, 'check.log') : LATEST_LOG;
const STATUS_FILE = path.join(LOG_FOLDER, COMPLIANCE_MODE ? 'compliance-status.json' : 'status.json');
const STORE_CONFIRM_SCRIPT = path.join(__dirname, 'CONFIRM-STORE.ps1');
const PRIMARY_LOCK_FILE = path.join(PRIMARY_STATE_ROOT, 'uploader.lock');
const FALLBACK_LOCK_FILE = path.join(LOG_FOLDER, 'uploader.lock');
let activeLockFile = '';
let lockHeld = false;
try {
  fs.mkdirSync(LOG_FOLDER, { recursive: true });
  fs.writeFileSync(ACTIVE_LOG, `Temu uploader started: ${new Date().toISOString()}\r\n`, 'utf8');
} catch (_error) {
  // Logging must never prevent the uploader from running.
}

const PAGE = Object.freeze({
  ready() {
    const compact = (value) => String(value || '').replace(/\s+/g, '');
    const visible = (el) => Boolean(el && el.isConnected
      && getComputedStyle(el).display !== 'none'
      && getComputedStyle(el).visibility !== 'hidden'
      && el.getClientRects().length > 0);
    if (location.pathname.replace(/\/$/, '') !== '/govern/upload-qualifications') return false;
    if ([...document.querySelectorAll('input[type="password"]')].some(visible)) return false;
    const selector = document.querySelector('#goodsStatusList')?.closest('.rocket-select')
      ?.querySelector('.rocket-select-selector');
    const query = [...document.querySelectorAll('button')]
      .find((el) => visible(el) && compact(el.innerText) === '查询' && !el.disabled);
    // The quick-filter banner is optional and has changed between Temu page versions.
    // Require the controls used by the next step, including an empty product list.
    return compact(document.body?.innerText).includes('商品资质') && visible(selector) && Boolean(query);
  },

  summary() {
    const compact = (value) => String(value || '').replace(/\s+/g, '');
    return {
      url: location.href,
      title: document.title,
      loginPage: /\/(auth|login)(\/|$)/i.test(location.pathname)
        || [...document.querySelectorAll('input[type="password"]')]
          .some((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'),
      store: compact(document.querySelector('.agentseller-userinfo span')?.innerText),
      filter: compact(document.querySelector('#goodsStatusList')?.closest('.rocket-form-field-item')?.innerText),
      statusFilterPresent: Boolean(document.querySelector('#goodsStatusList')),
      queryButtonPresent: [...document.querySelectorAll('button')]
        .some((el) => compact(el.innerText) === '查询' && el.getClientRects().length > 0),
    };
  },

  listState() {
    const compact = (value) => String(value || '').replace(/\s+/g, '');
    const rows = [...document.querySelectorAll('tr, [role="row"]')];
    const productRows = rows.filter((row) => /SPU(?:ID)?[：:]?\d{6,}/i.test(compact(row.innerText)));
    const eligibleRows = productRows.filter((row) => {
      const text = compact(row.innerText);
      return text.includes('GCC') && text.includes('待上传')
        && text.includes('16CFRpart1631') && /(地垫|地毯)/.test(text)
        && !text.includes('已删除');
    });
    const uploadCount = eligibleRows.filter((row) => [...row.querySelectorAll('button, a, [role="button"]')]
      .some((el) => compact(el.innerText) === '上传资质' && !el.disabled)).length;
    const totalText = [...document.querySelectorAll('*')]
      .map((el) => compact(el.innerText)).find((text) => /^总共\d+条数据$/.test(text)) || '';
    return {
      productRowCount: productRows.length,
      eligibleRowCount: eligibleRows.length,
      uploadCount,
      totalCount: Number(totalText.match(/\d+/)?.[0] || 0),
      selectedUnpublished: compact(document.querySelector('#goodsStatusList')
        ?.closest('.rocket-form-field-item')?.innerText).includes('未发布到站点'),
    };
  },

  firstPage() {
    const first = document.querySelector('li.rocket-pagination-item-1, li[title="1"]');
    if (!first) return { moved: false, reason: 'not-found' };
    const classes = String(first.className || '').toLowerCase();
    if (classes.includes('active')) return { moved: false, reason: 'already-first' };
    first.scrollIntoView({ block: 'center', inline: 'nearest' });
    first.click();
    return { moved: true, reason: '' };
  },

  nextPending(skippedSpus) {
    const compact = (value) => String(value || '').replace(/\s+/g, '');
    const rendered = (el) => {
      if (!el || !el.isConnected) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
        && el.getClientRects().length > 0;
    };
    const extractSpu = (text) => String(text || '').match(/SPU(?:ID)?[：:]?(\d{6,})/i)?.[1] || '';
    const skipped = new Set(Array.isArray(skippedSpus) ? skippedSpus.map(String) : []);
    const candidates = [...document.querySelectorAll('button, a, [role="button"]')]
      .filter((el) => rendered(el) && compact(el.innerText) === '上传资质' && !el.disabled);
    for (const button of candidates) {
      const row = button.closest('tr, [role="row"]');
      if (!row) continue;
      const spu = extractSpu(compact(row.innerText));
      if (spu && skipped.has(spu)) continue;
      const groupText = compact(row.innerText);
      if (!groupText.includes('GCC') || !groupText.includes('待上传')
        || !groupText.includes('16CFRpart1631') || !/(地垫|地毯)/.test(groupText)
        || groupText.includes('已删除')) continue;
      button.scrollIntoView({ block: 'center', inline: 'nearest' });
      button.click();
      return { clicked: true, spu };
    }
    return { clicked: false, spu: '' };
  },

  statusFilterState() {
    const compact = (value) => String(value || '').replace(/\s+/g, '');
    const field = document.querySelector('#goodsStatusList')?.closest('.rocket-form-field-item');
    const selector = document.querySelector('#goodsStatusList')?.closest('.rocket-select')
      ?.querySelector('.rocket-select-selector');
    if (!selector) return { ready: false, selected: false };
    const rect = selector.getBoundingClientRect();
    return {
      ready: true,
      selected: compact(field?.innerText).includes('未发布到站点'),
      point: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
    };
  },

  unpublishedOptionPoint() {
    const option = [...document.querySelectorAll('.rocket-select-item-option')]
      .find((el) => el.title === '未发布到站点' && el.getClientRects().length > 0);
    if (!option) return null;
    const rect = option.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  },

  queryButtonPoint() {
    const compact = (value) => String(value || '').replace(/\s+/g, '');
    const button = [...document.querySelectorAll('button')]
      .find((el) => compact(el.innerText) === '查询' && !el.disabled);
    if (!button) return null;
    const rect = button.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  },

  qualificationModalInfo() {
    const compact = (value) => String(value || '').replace(/\s+/g, '');
    const rendered = (el) => {
      if (!el || !el.isConnected) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
        && el.getClientRects().length > 0;
    };
    const body = [...document.querySelectorAll('.rocket-drawer-body')]
      .filter(rendered).find((el) => {
        const text = compact(el.innerText);
        return text.includes('商品实拍图') && text.includes('GCC资质') && text.includes('检测报告');
      });
    if (!body) return { open: false };
    const text = compact(body.innerText);
    const pdfInput = [...body.querySelectorAll('input[type="file"]')]
      .find((el) => String(el.accept || '').toLowerCase().includes('.pdf'));
    const productHeader = [...body.querySelectorAll('*')]
      .filter((el) => rendered(el) && compact(el.innerText) === '商品实拍图')
      .sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length)[0];
    const gccHeader = [...body.querySelectorAll('*')]
      .filter((el) => rendered(el) && compact(el.innerText).startsWith('GCC资质'))
      .sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length)[0];
    const before = (a, b) => Boolean(a && b
      && (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING));
    const inPhotoSection = (el) => before(productHeader, el) && before(el, gccHeader);
    const photoButtons = [...body.querySelectorAll('button')]
      .filter((el) => rendered(el) && inPhotoSection(el));
    const photoImageCount = [...body.querySelectorAll('img')]
      .filter((el) => rendered(el) && inPhotoSection(el)).length;
    const photoEdit = photoButtons.some((el) => compact(el.innerText) === '编辑图片');
    const photoAction = photoButtons.some((el) => compact(el.innerText) === '+点击上传');
    return {
      open: true,
      spu: text.match(/SPU(?:ID)?[：:]?(\d{6,})/i)?.[1] || '',
      gcc: text.includes('GCC资质') && text.includes('16CFRpart1631'),
      photoAction: photoAction || photoEdit,
      photoEdit,
      photoImageCount,
      photoReady: photoEdit && photoImageCount >= 4,
      pdfInput: Boolean(pdfInput),
      pdfSelected: Boolean(pdfInput?.files?.length),
    };
  },

  clickPhotoUpload() {
    const compact = (value) => String(value || '').replace(/\s+/g, '');
    const rendered = (el) => el && el.isConnected && getComputedStyle(el).display !== 'none'
      && getComputedStyle(el).visibility !== 'hidden' && el.getClientRects().length > 0;
    const body = [...document.querySelectorAll('.rocket-drawer-body')]
      .filter(rendered).find((el) => compact(el.innerText).includes('GCC资质')
        && compact(el.innerText).includes('检测报告'));
    if (!body) return false;
    const headers = [...body.querySelectorAll('*')]
      .filter((el) => rendered(el) && ['商品实拍图'].includes(compact(el.innerText)));
    const productHeader = headers.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length)[0];
    const gccHeader = [...body.querySelectorAll('*')]
      .filter((el) => rendered(el) && compact(el.innerText).startsWith('GCC资质'))
      .sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length)[0];
    const before = (a, b) => Boolean(a && b && (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING));
    const candidates = [...body.querySelectorAll('button')].filter((el) => rendered(el)
      && ['+点击上传', '编辑图片'].includes(compact(el.innerText))
      && before(productHeader, el) && before(el, gccHeader));
    const button = candidates.find((el) => compact(el.innerText) === '+点击上传') || candidates[0];
    if (!button) return false;
    button.scrollIntoView({ block: 'center', inline: 'nearest' });
    button.click();
    return true;
  },

  photoAcknowledgement() {
    const compact = (value) => String(value || '').replace(/\s+/g, '');
    const rendered = (el) => {
      if (!el || !el.isConnected || el.getClientRects().length === 0) return false;
      // Temu retains the completed drawer with opacity:0 on a parent wrapper.
      for (let node = el; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      }
      return true;
    };
    const alerts = [...document.querySelectorAll('[role="alert"], [class*="toast"], [class*="message"], [class*="notification"]')]
      .filter(rendered).map((el) => compact(el.innerText));
    const failure = alerts.find((text) => ['上传失败', '识别失败', '图片上传失败', '网络异常']
      .some((part) => text.includes(part))) || '';
    const innerOpen = [...document.querySelectorAll('button')]
      .some((el) => rendered(el) && compact(el.innerText) === '上传并识别');
    const outerOpen = [...document.querySelectorAll('.rocket-drawer-body')]
      .filter(rendered).some((el) => compact(el.innerText).includes('GCC资质')
        && compact(el.innerText).includes('检测报告'));
    return {
      done: !innerOpen && outerOpen,
      acknowledged: alerts.some((text) => text.includes('识别成功')),
      failure,
    };
  },

  tagQualificationPdf(token) {
    const compact = (value) => String(value || '').replace(/\s+/g, '');
    const rendered = (el) => el && el.isConnected && getComputedStyle(el).display !== 'none'
      && getComputedStyle(el).visibility !== 'hidden' && el.getClientRects().length > 0;
    const body = [...document.querySelectorAll('.rocket-drawer-body')]
      .filter(rendered).find((el) => compact(el.innerText).includes('GCC资质')
        && compact(el.innerText).includes('检测报告'));
    const input = body && [...body.querySelectorAll('input[type="file"]')]
      .find((el) => String(el.accept || '').toLowerCase().includes('.pdf'));
    if (!input) return { ok: false, reason: '找不到检测报告上传槽' };
    document.querySelectorAll('[data-codex-pdf-token]').forEach((el) => el.removeAttribute('data-codex-pdf-token'));
    input.setAttribute('data-codex-pdf-token', token);
    return { ok: true, selected: Boolean(input.files?.length) };
  },

  qualificationPdfStatus(fileName) {
    const compact = (value) => String(value || '').replace(/\s+/g, '');
    const rendered = (el) => el && el.isConnected && getComputedStyle(el).display !== 'none'
      && getComputedStyle(el).visibility !== 'hidden' && el.getClientRects().length > 0;
    const body = [...document.querySelectorAll('.rocket-drawer-body')]
      .filter(rendered).find((el) => compact(el.innerText).includes('GCC资质')
        && compact(el.innerText).includes('检测报告'));
    if (!body) return { modalOpen: false, ready: false, failure: '' };
    const input = [...body.querySelectorAll('input[type="file"]')]
      .find((el) => String(el.accept || '').toLowerCase().includes('.pdf'));
    const alerts = [...document.querySelectorAll('[role="alert"], [class*="toast"], [class*="message"], [class*="notification"]')]
      .filter(rendered).map((el) => compact(el.innerText));
    const failure = alerts.find((text) => ['上传失败', '文件失败', '格式错误', '网络异常']
      .some((part) => text.includes(part))) || '';
    const normalizedName = compact(fileName).toLowerCase();
    const text = compact(body.innerText).toLowerCase();
    const selected = Boolean(input?.files?.length);
    const listed = Boolean(normalizedName && text.includes(normalizedName));
    const uploading = Boolean(body.querySelector('[class*="uploading"], [class*="progress"]'));
    return { modalOpen: true, ready: (selected || listed) && !uploading, selected, listed, failure };
  },

  qualificationSubmitReady() {
    const compact = (value) => String(value || '').replace(/\s+/g, '');
    const rendered = (el) => el && el.isConnected && getComputedStyle(el).display !== 'none'
      && getComputedStyle(el).visibility !== 'hidden' && el.getClientRects().length > 0;
    const footer = [...document.querySelectorAll('.rocket-drawer-footer')]
      .filter(rendered).find((el) => compact(el.innerText) === '确认取消'
        && compact(el.parentElement?.innerText).includes('GCC资质'));
    const button = footer && [...footer.querySelectorAll('button')]
      .find((el) => compact(el.innerText) === '确认');
    return Boolean(button && !button.disabled && button.getAttribute('aria-disabled') !== 'true');
  },

  clickQualificationSubmit() {
    const compact = (value) => String(value || '').replace(/\s+/g, '');
    const rendered = (el) => el && el.isConnected && getComputedStyle(el).display !== 'none'
      && getComputedStyle(el).visibility !== 'hidden' && el.getClientRects().length > 0;
    const footer = [...document.querySelectorAll('.rocket-drawer-footer')]
      .filter(rendered).find((el) => compact(el.innerText) === '确认取消'
        && compact(el.parentElement?.innerText).includes('GCC资质'));
    const button = footer && [...footer.querySelectorAll('button')]
      .find((el) => compact(el.innerText) === '确认' && !el.disabled);
    if (!button) return false;
    button.scrollIntoView({ block: 'center', inline: 'nearest' });
    button.click();
    return true;
  },

  qualificationResult(spu) {
    const compact = (value) => String(value || '').replace(/\s+/g, '');
    const rendered = (el) => el && el.isConnected && getComputedStyle(el).display !== 'none'
      && getComputedStyle(el).visibility !== 'hidden' && el.getClientRects().length > 0;
    const alerts = [...document.querySelectorAll('[role="alert"], [class*="toast"], [class*="message"], [class*="notification"]')]
      .filter(rendered).map((el) => compact(el.innerText));
    const failure = alerts.find((text) => ['上传失败', '提交失败', '网络异常', '系统异常']
      .some((part) => text.includes(part))) || '';
    const row = [...document.querySelectorAll('tr,[role="row"]')]
      .find((el) => compact(el.innerText).includes(String(spu || '')));
    const rowText = compact(row?.innerText);
    const done = Boolean(row && (rowText.includes('GCC上传完成')
      || (rowText.includes('查看资质') && !rowText.includes('上传资质'))));
    const outerOpen = [...document.querySelectorAll('.rocket-drawer-body')]
      .filter(rendered).some((el) => compact(el.innerText).includes('GCC资质')
        && compact(el.innerText).includes('检测报告'));
    return {
      done,
      acknowledged: !outerOpen && alerts.some((text) => text.includes('成功')),
      rowFound: Boolean(row),
      failure,
      rowText: rowText.slice(0, 500),
    };
  },

  modalInfo() {
    const compact = (value) => String(value || '').replace(/\s+/g, '');
    const rendered = (el) => {
      if (!el || !el.isConnected) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
        && el.getClientRects().length > 0;
    };
    const deepestExact = (root, text) => [...root.querySelectorAll('*')]
      .filter((el) => rendered(el) && compact(el.innerText) === compact(text))
      .sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length)[0] || null;
    const submit = [...document.querySelectorAll('button, a, [role="button"]')]
      .find((el) => rendered(el) && compact(el.innerText) === '上传并识别');
    if (!submit) return { open: false };
    let modal = submit.closest('[role="dialog"], [class*="drawer"], [class*="modal"]');
    if (!modal || !compact(modal.innerText).includes('商品主体实拍图')) {
      modal = submit.parentElement;
      while (modal && modal !== document.body) {
        const text = compact(modal.innerText);
        if (text.includes('商品主体实拍图') && text.includes('商品外包装实拍图')) break;
        modal = modal.parentElement;
      }
    }
    if (!modal || modal === document.body) return { open: false };
    const text = compact(modal.innerText);
    const mainHeader = deepestExact(modal, '商品主体实拍图');
    const packageHeader = deepestExact(modal, '商品外包装实拍图');
    return {
      open: true,
      hasMain: Boolean(mainHeader),
      hasPackage: Boolean(packageHeader),
      fileInputCount: modal.querySelectorAll('input[type="file"]').length,
      spu: text.match(/SPU(?:ID)?[：:]?(\d{6,})/i)?.[1] || '',
    };
  },

  tagSlot(args) {
    const { sectionName, label, fallbackIndex, token } = args;
    const compact = (value) => String(value || '').replace(/\s+/g, '');
    const rendered = (el) => {
      if (!el || !el.isConnected) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
        && el.getClientRects().length > 0;
    };
    const deepestExact = (root, text) => [...root.querySelectorAll('*')]
      .filter((el) => rendered(el) && compact(el.innerText) === compact(text))
      .sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length)[0] || null;
    const exactAction = (root, text) => [...root.querySelectorAll('button, a, [role="button"]')]
      .find((el) => rendered(el) && compact(el.innerText) === compact(text)) || deepestExact(root, text);
    const before = (a, b) => Boolean(a && b && a !== b
      && (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING));
    const submit = exactAction(document, '上传并识别');
    if (!submit) return { ok: false, reason: '未找到上传并识别按钮' };
    let modal = submit.closest('[role="dialog"], [class*="drawer"], [class*="modal"]');
    if (!modal || !compact(modal.innerText).includes('商品主体实拍图')) {
      modal = submit.parentElement;
      while (modal && modal !== document.body) {
        const text = compact(modal.innerText);
        if (text.includes('商品主体实拍图') && text.includes('商品外包装实拍图')) break;
        modal = modal.parentElement;
      }
    }
    if (!modal || modal === document.body) return { ok: false, reason: '未找到上传窗口' };
    const mainHeader = deepestExact(modal, '商品主体实拍图');
    const packageHeader = deepestExact(modal, '商品外包装实拍图');
    if (!mainHeader || !packageHeader) return { ok: false, reason: '实拍图区块不完整' };
    const start = sectionName === 'main' ? mainHeader : packageHeader;
    const end = sectionName === 'main' ? packageHeader : submit;
    const inputs = [...modal.querySelectorAll('input[type="file"]')]
      .filter((input) => before(start, input) && before(input, end));
    let target = null;
    for (const input of inputs) {
      let current = input.parentElement;
      for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
        if (current.querySelectorAll('input[type="file"]').length > 1) break;
        if (compact(current.innerText).includes(compact(label))) {
          target = input;
          break;
        }
      }
      if (target) break;
    }
    target ||= inputs[fallbackIndex] || null;
    if (!target) return { ok: false, reason: `找不到${sectionName}/${label}上传槽`, count: inputs.length };
    document.querySelectorAll('[data-codex-upload-token]').forEach((el) => el.removeAttribute('data-codex-upload-token'));
    target.setAttribute('data-codex-upload-token', token);
    return { ok: true, inputCount: inputs.length };
  },

  fireFileEvents(token) {
    const input = document.querySelector(`[data-codex-upload-token="${CSS.escape(token)}"]`);
    if (!input) return false;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  },

  slotStatus(args) {
    const { sectionName, label } = args;
    const compact = (value) => String(value || '').replace(/\s+/g, '');
    const rendered = (el) => {
      if (!el || !el.isConnected) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
        && el.getClientRects().length > 0;
    };
    const deepestExact = (root, text) => [...root.querySelectorAll('*')]
      .filter((el) => rendered(el) && compact(el.innerText) === compact(text))
      .sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length)[0] || null;
    const before = (a, b) => Boolean(a && b && a !== b
      && (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING));
    const submit = [...document.querySelectorAll('button, a, [role="button"]')]
      .find((el) => rendered(el) && compact(el.innerText) === '上传并识别');
    if (!submit) return { modalOpen: false, count: null, failure: '' };
    let modal = submit.closest('[role="dialog"], [class*="drawer"], [class*="modal"]');
    if (!modal || !compact(modal.innerText).includes('商品主体实拍图')) {
      modal = submit.parentElement;
      while (modal && modal !== document.body) {
        const text = compact(modal.innerText);
        if (text.includes('商品主体实拍图') && text.includes('商品外包装实拍图')) break;
        modal = modal.parentElement;
      }
    }
    if (!modal || modal === document.body) return { modalOpen: false, count: null, failure: '' };
    const mainHeader = deepestExact(modal, '商品主体实拍图');
    const packageHeader = deepestExact(modal, '商品外包装实拍图');
    const start = sectionName === 'main' ? mainHeader : packageHeader;
    const end = sectionName === 'main' ? packageHeader : submit;
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^${escaped}\\((\\d+)\\/(\\d+)\\)$`);
    const matches = [...modal.querySelectorAll('*')]
      .filter((el) => before(start, el) && before(el, end))
      .map((el) => ({ el, match: compact(el.innerText).match(pattern) }))
      .filter((item) => item.match)
      .sort((a, b) => a.el.querySelectorAll('*').length - b.el.querySelectorAll('*').length);
    const alerts = [...document.querySelectorAll('[role="alert"], [class*="toast"], [class*="message"], [class*="notification"]')]
      .filter(rendered)
      .map((el) => compact(el.innerText));
    const failure = alerts.find((text) => ['上传失败', '识别失败', '图片上传失败', '网络异常'].some((x) => text.includes(x))) || '';
    return { modalOpen: true, count: matches.length ? Number(matches[0].match[1]) : null, failure };
  },

  submitReady() {
    const compact = (value) => String(value || '').replace(/\s+/g, '');
    const rendered = (el) => {
      if (!el || !el.isConnected) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
        && el.getClientRects().length > 0;
    };
    const button = [...document.querySelectorAll('button, a, [role="button"]')]
      .find((el) => rendered(el) && compact(el.innerText) === '上传并识别');
    return Boolean(button && !button.disabled && button.getAttribute('aria-disabled') !== 'true');
  },

  clickSubmit() {
    const compact = (value) => String(value || '').replace(/\s+/g, '');
    const button = [...document.querySelectorAll('button, a, [role="button"]')]
      .find((el) => compact(el.innerText) === '上传并识别' && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
    if (!button) return false;
    button.scrollIntoView({ block: 'center', inline: 'nearest' });
    button.click();
    return true;
  },

  closeModal() {
    const compact = (value) => String(value || '').replace(/\s+/g, '');
    const submit = [...document.querySelectorAll('button, a, [role="button"]')]
      .find((el) => compact(el.innerText) === '上传并识别');
    if (!submit) return true;
    let modal = submit.closest('[role="dialog"], [class*="drawer"], [class*="modal"]');
    if (!modal || !compact(modal.innerText).includes('商品主体实拍图')) {
      modal = submit.parentElement;
      while (modal && modal !== document.body) {
        const text = compact(modal.innerText);
        if (text.includes('商品主体实拍图') && text.includes('商品外包装实拍图')) break;
        modal = modal.parentElement;
      }
    }
    if (!modal || modal === document.body) return false;
    const cancel = [...modal.querySelectorAll('button, a, [role="button"]')]
      .find((el) => ['取消', '关闭'].includes(compact(el.innerText)));
    if (cancel) {
      cancel.click();
      return true;
    }
    const close = modal.querySelector('[aria-label="Close"], [aria-label="关闭"], [class*="close"]');
    if (close) {
      close.click();
      return true;
    }
    return false;
  },

  result(spu) {
    const compact = (value) => String(value || '').replace(/\s+/g, '');
    const rendered = (el) => {
      if (!el || !el.isConnected) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
        && el.getClientRects().length > 0;
    };
    const alerts = [...document.querySelectorAll('[role="alert"], [class*="toast"], [class*="message"], [class*="notification"]')]
      .filter(rendered)
      .map((el) => compact(el.innerText));
    const failure = alerts.find((text) => ['上传失败', '识别失败', '图片上传失败', '网络异常'].some((x) => text.includes(x))) || '';
    if (failure) return { done: false, acknowledged: false, rowFound: false, failure };
    let rowFound = false;
    if (spu) {
      const rows = [...document.querySelectorAll('tr, [role="row"]')]
        .filter((row) => compact(row.innerText).includes(spu));
      rowFound = rows.length > 0;
      for (const row of rows) {
        const group = compact(row.innerText) + compact(row.nextElementSibling?.innerText);
        if (group.includes('识别失败')) {
          return { done: false, acknowledged: false, rowFound: true, failure: `SPU ${spu} 识别失败` };
        }
        if (group.includes('识别成功') && !group.includes('待传图')) {
          return { done: true, acknowledged: true, rowFound: true, failure: '' };
        }
      }
    }
    const toastSuccess = alerts.some((text) => text.includes('识别成功'));
    const modalStillOpen = [...document.querySelectorAll('button, a, [role="button"]')]
      .some((el) => rendered(el) && compact(el.innerText) === '上传并识别');
    return {
      done: false,
      acknowledged: toastSuccess && !modalStillOpen,
      rowFound,
      failure: '',
    };
  },

  pageSignature() {
    const compact = (value) => String(value || '').replace(/\s+/g, '');
    const rendered = (el) => {
      if (!el || !el.isConnected) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
        && el.getClientRects().length > 0;
    };
    const ids = [...document.querySelectorAll('tr, [role="row"]')]
      .map((row) => compact(row.innerText).match(/SPU(?:ID)?[：:]?(\d{6,})/i)?.[1] || '')
      .filter(Boolean);
    const active = [...document.querySelectorAll('li.rocket-pagination-item-active, .rocket-pagination-item-active, [aria-current="page"]')]
      .find(rendered);
    const page = compact(active?.getAttribute('title') || active?.innerText) || 'unknown';
    return `page=${page}|${ids.slice(0, 5).join('|') || `${location.href}|${document.title}`}`;
  },

  nextPagePoint() {
    const compact = (value) => String(value || '').replace(/\s+/g, '');
    const rendered = (el) => {
      if (!el || !el.isConnected) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
        && el.getClientRects().length > 0;
    };
    const enabled = (el) => {
      if (!rendered(el)) return false;
      const classes = `${el.className || ''} ${el.parentElement?.className || ''}`.toLowerCase();
      const button = el.matches('button,a,[role="button"]') ? el : el.querySelector('button,a,[role="button"]');
      return el.getAttribute('aria-disabled') !== 'true' && !classes.includes('disabled') && !el.disabled
        && (!button || (!button.disabled && button.getAttribute('aria-disabled') !== 'true'));
    };
    const active = [...document.querySelectorAll('li.rocket-pagination-item-active, .rocket-pagination-item-active, [aria-current="page"]')]
      .find(rendered);
    const currentPage = Number(compact(active?.getAttribute('title') || active?.innerText)) || 0;
    const semantic = [...document.querySelectorAll(
      'li.rocket-pagination-next, button.rocket-pagination-next, [title="下一页"], [aria-label="下一页"], [aria-label="Next Page"]',
    )];
    const textMatches = [...document.querySelectorAll('button, a, li, [role="button"]')]
      .filter((el) => compact(el.innerText) === '下一页');
    let candidates = [...new Set([...semantic, ...textMatches])];

    // Some Temu builds render a disabled/hidden next-arrow clone. In that case,
    // use the next numeric page inside the same pagination component.
    if (currentPage > 0 && active) {
      const pagination = active.closest('ul, nav, [class*="pagination"]') || active.parentElement;
      const wanted = String(currentPage + 1);
      const numeric = pagination ? [...pagination.querySelectorAll('button, a, li, [role="button"]')]
        .filter((el) => compact(el.getAttribute('title') || el.innerText) === wanted) : [];
      candidates = [...candidates, ...numeric];
    }

    const next = [...new Set(candidates)]
      .sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length)
      .find(enabled);
    if (!next) return { available: false, point: null, currentPage };
    const target = next.matches('button,a,[role="button"]') ? next
      : next.querySelector('button:not([disabled]),a,[role="button"]') || next;
    target.scrollIntoView({ block: 'center', inline: 'nearest' });
    const rect = target.getBoundingClientRect();
    if (!rect.width || !rect.height) return { available: false, point: null, currentPage };
    return {
      available: true,
      currentPage,
      point: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
    };
  },

  nextPage() {
    const compact = (value) => String(value || '').replace(/\s+/g, '');
    const rendered = (el) => {
      if (!el || !el.isConnected) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
        && el.getClientRects().length > 0;
    };
    const semantic = [...document.querySelectorAll('li.rocket-pagination-next, [title="下一页"], [aria-label="下一页"], [aria-label="Next Page"]')];
    const textMatches = [...document.querySelectorAll('button, a, li, [role="button"], div')]
      .filter((el) => compact(el.innerText) === '下一页');
    const candidates = [...new Set([...semantic, ...textMatches])]
      .sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length);
    const next = candidates.find((el) => {
      const classes = `${el.className || ''} ${el.parentElement?.className || ''}`.toLowerCase();
      const button = el.matches('button,a,[role="button"]') ? el : el.querySelector('button,a,[role="button"]');
      return rendered(el) && el.getAttribute('aria-disabled') !== 'true' && !classes.includes('disabled')
        && !el.disabled && (!button || (!button.disabled && button.getAttribute('aria-disabled') !== 'true'));
    });
    if (!next) return false;
    const target = next.matches('button,a,[role="button"]') ? next
      : next.querySelector('button:not([disabled]),a,[role="button"]') || next;
    target.scrollIntoView({ block: 'center', inline: 'nearest' });
    target.click();
    return true;
  },
});

const COMPLIANCE_PAGE = Object.freeze({
  ready() {
    const compact = (value) => String(value || '').replace(/\s+/g, '');
    const text = compact(document.body?.innerText);
    return location.pathname.includes('/govern/information-supplementation')
      && text.includes('商品合规信息') && text.includes('商品信息') && text.includes('编辑');
  },

  summary() {
    const compact = (value) => String(value || '').replace(/\s+/g, '');
    return {
      url: location.href,
      title: document.title,
      loginPage: location.pathname.includes('/auth/'),
      store: compact(document.querySelector('.agentseller-userinfo span')?.innerText),
    };
  },

  listState() {
    const compact = (value) => String(value || '').replace(/\s+/g, '');
    const rows = [...document.querySelectorAll('tr, [role="row"]')]
      .filter((row) => /SPU(?:ID)?[：:]?\d{6,}/i.test(compact(row.innerText)));
    const groupText = (row) => {
      let text = compact(row.innerText);
      let sibling = row.nextElementSibling;
      while (sibling && !/SPU(?:ID)?[：:]?\d{6,}/i.test(compact(sibling.innerText))) {
        text += compact(sibling.innerText);
        sibling = sibling.nextElementSibling;
      }
      return text;
    };
    const eligible = rows.filter((row) => {
      const text = groupText(row);
      return /(地垫|地毯)/.test(text) && /小地(?:垫|毯)易燃警示声明/.test(text)
        && text.includes('待确认') && !text.includes('已删除');
    });
    const editable = eligible.filter((row) => [...row.querySelectorAll('button,a,[role="button"]')]
      .some((el) => compact(el.innerText) === '编辑' && !el.disabled));
    const totalText = [...document.querySelectorAll('*')]
      .map((el) => compact(el.innerText)).find((text) => /^(?:总共|共)\d+条数据$/.test(text)) || '';
    return {
      productRowCount: rows.length,
      eligibleRowCount: eligible.length,
      editCount: editable.length,
      totalCount: Number(totalText.match(/\d+/)?.[0] || 0),
    };
  },

  firstPage() {
    const first = document.querySelector('li.rocket-pagination-item-1, li[title="1"]');
    if (!first) return { moved: false, reason: 'not-found' };
    const classes = String(first.className || '').toLowerCase();
    if (classes.includes('active')) return { moved: false, reason: 'already-first' };
    first.scrollIntoView({ block: 'center', inline: 'nearest' });
    first.click();
    return { moved: true, reason: '' };
  },

  nextPending(skippedSpus) {
    const compact = (value) => String(value || '').replace(/\s+/g, '');
    const rendered = (el) => {
      if (!el || !el.isConnected) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
        && el.getClientRects().length > 0;
    };
    const skipped = new Set(Array.isArray(skippedSpus) ? skippedSpus.map(String) : []);
    const buttons = [...document.querySelectorAll('button,a,[role="button"]')]
      .filter((el) => rendered(el) && compact(el.innerText) === '编辑' && !el.disabled);
    for (const button of buttons) {
      const row = button.closest('tr, [role="row"]');
      if (!row) continue;
      let text = compact(row.innerText);
      let sibling = row.nextElementSibling;
      while (sibling && !/SPU(?:ID)?[：:]?\d{6,}/i.test(compact(sibling.innerText))) {
        text += compact(sibling.innerText);
        sibling = sibling.nextElementSibling;
      }
      const spu = text.match(/SPU(?:ID)?[：:]?(\d{6,})/i)?.[1] || '';
      if (spu && skipped.has(spu)) continue;
      if (!/(地垫|地毯)/.test(text) || !/小地(?:垫|毯)易燃警示声明/.test(text)
        || !text.includes('待确认') || text.includes('已删除')) continue;
      button.scrollIntoView({ block: 'center', inline: 'nearest' });
      button.click();
      return { clicked: true, spu };
    }
    return { clicked: false, spu: '' };
  },

  modalInfo() {
    const compact = (value) => String(value || '').replace(/\s+/g, '');
    const rendered = (el) => {
      if (!el || !el.isConnected || el.getClientRects().length === 0) return false;
      for (let node = el; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      }
      return true;
    };
    const drawers = [...document.querySelectorAll('.rocket-drawer-content, [role="dialog"]')]
      .filter(rendered);
    const drawer = drawers.find((el) => {
      const text = compact(el.innerText);
      return text.includes('编辑合规信息') && /小地(?:垫|毯)易燃警示声明/.test(text);
    }) || drawers.find((el) => /小地(?:垫|毯)易燃警示声明/.test(compact(el.innerText)));
    if (!drawer) return { open: false };
    const text = compact(drawer.innerText);
    const confirm = [...drawer.querySelectorAll('button')]
      .find((el) => rendered(el) && compact(el.innerText) === '确认');
    const checkboxes = [...drawer.querySelectorAll('input[type="checkbox"]')];
    const checked = checkboxes.some((el) => el.checked)
      || Boolean(drawer.querySelector('.rocket-checkbox-checked, [aria-checked="true"]'));
    const selectedStatement = text.includes('我同意和授权平台在商品详情页面展示该警示声明');
    return {
      open: true,
      spu: text.match(/SPU[：:]?(\d{6,})/i)?.[1] || '',
      pending: /小地(?:垫|毯)易燃警示声明/.test(text) && text.includes('待确认'),
      selectedStatement,
      responsibilityChecked: checked,
      confirmReady: Boolean(confirm && !confirm.disabled),
      confirmText: compact(confirm?.innerText),
    };
  },

  clickConfirm() {
    const compact = (value) => String(value || '').replace(/\s+/g, '');
    const rendered = (el) => {
      if (!el || !el.isConnected || el.getClientRects().length === 0) return false;
      for (let node = el; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      }
      return true;
    };
    const drawer = [...document.querySelectorAll('.rocket-drawer-content, [role="dialog"]')]
      .filter(rendered).find((el) => /小地(?:垫|毯)易燃警示声明/.test(compact(el.innerText)));
    const button = drawer && [...drawer.querySelectorAll('button')]
      .find((el) => rendered(el) && compact(el.innerText) === '确认' && !el.disabled);
    if (!button) return false;
    button.scrollIntoView({ block: 'center', inline: 'nearest' });
    button.click();
    return true;
  },

  result(spu) {
    const compact = (value) => String(value || '').replace(/\s+/g, '');
    const rendered = (el) => {
      if (!el || !el.isConnected || el.getClientRects().length === 0) return false;
      for (let node = el; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      }
      return true;
    };
    const drawerOpen = [...document.querySelectorAll('.rocket-drawer-content, [role="dialog"]')]
      .some((el) => rendered(el) && /小地(?:垫|毯)易燃警示声明/.test(compact(el.innerText)));
    const alerts = [...document.querySelectorAll('[role="alert"], .rocket-message, .rocket-notification')]
      .filter(rendered).map((el) => compact(el.innerText));
    const failure = alerts.find((text) => /(提交失败|确认失败|操作失败|系统异常|网络异常)/.test(text)) || '';
    const rows = [...document.querySelectorAll('tr, [role="row"]')].filter(rendered);
    const row = rows.find((el) => compact(el.innerText).match(/SPU(?:ID)?[：:]?(\d{6,})/i)?.[1] === String(spu || ''));
    const group = row ? [row] : [];
    let sibling = row?.nextElementSibling;
    while (sibling && !/SPU(?:ID)?[：:]?\d{6,}/i.test(compact(sibling.innerText))) {
      group.push(sibling);
      sibling = sibling.nextElementSibling;
    }
    // Other requirements (for example California 65) have independent pending states.
    const warningText = group.map((el) => compact(el.innerText))
      .map((text) => text.match(/小地(?:垫|毯)易燃警示声明(.*)/)?.[1] || '').join('');
    const stillPending = warningText.includes('待确认');
    const confirmed = /上传成功|已确认|已完成/.test(warningText) && !stillPending;
    const toastSuccess = alerts.some((text) => /确认成功|提交成功|上传成功|操作成功|已确认/.test(text));
    return {
      done: !drawerOpen && Boolean(row) && confirmed,
      acknowledged: !drawerOpen && toastSuccess,
      drawerOpen,
      rowFound: Boolean(row),
      stillPending,
      warningText: warningText.slice(0, 500),
      failure,
    };
  },

  pageSignature() {
    const compact = (value) => String(value || '').replace(/\s+/g, '');
    const ids = [...document.querySelectorAll('tr, [role="row"]')]
      .map((row) => compact(row.innerText).match(/SPU(?:ID)?[：:]?(\d{6,})/i)?.[1] || '')
      .filter(Boolean);
    const active = document.querySelector('li.rocket-pagination-item-active, .rocket-pagination-item-active, [aria-current="page"]');
    const page = compact(active?.getAttribute('title') || active?.innerText) || 'unknown';
    return `page=${page}|${ids.slice(0, 5).join('|') || `${location.href}|${document.title}`}`;
  },

  nextPage() {
    const compact = (value) => String(value || '').replace(/\s+/g, '');
    const rendered = (el) => {
      if (!el || !el.isConnected) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
        && el.getClientRects().length > 0;
    };
    const semantic = [...document.querySelectorAll('li.rocket-pagination-next, [title="下一页"], [aria-label="下一页"], [aria-label="Next Page"]')];
    const textMatches = [...document.querySelectorAll('button,a,li,[role="button"],div')]
      .filter((el) => compact(el.innerText) === '下一页');
    const candidates = [...new Set([...semantic, ...textMatches])]
      .sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length);
    const next = candidates.find((el) => {
      const classes = `${el.className || ''} ${el.parentElement?.className || ''}`.toLowerCase();
      const button = el.matches('button,a,[role="button"]') ? el : el.querySelector('button,a,[role="button"]');
      return rendered(el) && el.getAttribute('aria-disabled') !== 'true' && !classes.includes('disabled')
        && !el.disabled && (!button || (!button.disabled && button.getAttribute('aria-disabled') !== 'true'));
    });
    if (!next) return false;
    const target = next.matches('button,a,[role="button"]') ? next
      : next.querySelector('button:not([disabled]),a,[role="button"]') || next;
    target.scrollIntoView({ block: 'center', inline: 'nearest' });
    target.click();
    return true;
  },
});

class CdpClient {
  constructor(webSocketUrl) {
    this.url = webSocketUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.ws = null;
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('连接 Chrome 超时')), 15000);
      this.ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('无法连接 Chrome 自动化接口'));
      }, { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message}${message.error.data ? `：${message.error.data}` : ''}`));
      else resolve(message.result || {});
    });
    this.ws.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('Chrome 窗口已关闭'));
      this.pending.clear();
    });
  }

  send(method, params = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Chrome 尚未连接'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close();
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
const log = (message) => {
  const line = `[${stamp()}] ${message}`;
  console.log(line);
  try { fs.appendFileSync(ACTIVE_LOG, `${line}\r\n`, 'utf8'); } catch (_error) { /* ignore */ }
};
const complianceStatusContext = {};
const writeStatus = (stage, details = {}) => {
  try {
    if (COMPLIANCE_MODE) {
      for (const key of ['store', 'processed', 'processedSpus', 'lastSpu']) {
        if (Object.prototype.hasOwnProperty.call(details, key)) complianceStatusContext[key] = details[key];
      }
    }
    fs.writeFileSync(STATUS_FILE, JSON.stringify({
      ...(COMPLIANCE_MODE ? complianceStatusContext : {}),
      updatedAt: new Date().toISOString(),
      stage,
      ...details,
    }, null, 2), 'utf8');
  } catch (_error) { /* ignore */ }
};
const logError = (error) => {
  const message = error?.stack || error?.message || String(error);
  console.error(message);
  try { fs.appendFileSync(ACTIVE_LOG, `[${stamp()}] ERROR: ${message}\r\n`, 'utf8'); } catch (_error) { /* ignore */ }
};

function acquireRunLockAt(lockFile) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  if (fs.existsSync(lockFile)) {
    const previousPid = Number(fs.readFileSync(lockFile, 'utf8').trim());
    if (Number.isInteger(previousPid) && previousPid > 0 && previousPid !== process.pid) {
      try {
        process.kill(previousPid, 0);
        const runningError = new Error(`已有一个上传任务正在运行（进程 ${previousPid}），请勿重复启动。`);
        runningError.code = 'TEMU_UPLOADER_ALREADY_RUNNING';
        throw runningError;
      } catch (error) {
        if (error.code === 'TEMU_UPLOADER_ALREADY_RUNNING') throw error;
      }
    }
  }
  fs.writeFileSync(lockFile, String(process.pid), 'utf8');
  activeLockFile = lockFile;
  lockHeld = true;
}

function acquireRunLock() {
  const candidates = [...new Set([PRIMARY_LOCK_FILE, FALLBACK_LOCK_FILE])];
  let primaryError;
  for (const lockFile of candidates) {
    try {
      acquireRunLockAt(lockFile);
      if (lockFile !== PRIMARY_LOCK_FILE) {
        log('本机状态目录不可写，已自动切换到工作台兼容锁；防重复启动仍然有效。');
      }
      return;
    } catch (error) {
      if (error.code === 'TEMU_UPLOADER_ALREADY_RUNNING') throw error;
      if (!primaryError) primaryError = error;
    }
  }
  throw primaryError || new Error('无法创建上传任务运行锁。');
}

function releaseRunLock() {
  if (!lockHeld) return;
  try {
    if (activeLockFile && fs.existsSync(activeLockFile)
      && fs.readFileSync(activeLockFile, 'utf8').trim() === String(process.pid)) {
      fs.unlinkSync(activeLockFile);
    }
  } catch (_error) { /* ignore */ }
  activeLockFile = '';
  lockHeld = false;
}

async function waitUntil(check, timeoutMs, label, intervalMs = 400) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  throw new Error(`等待${label}超时${lastError ? `：${lastError.message}` : ''}`);
}

function findChrome() {
  const candidates = [
    path.resolve(__dirname, '../../runtime/gpt-chrome/chrome-win64/chrome.exe'),
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

function verifyEnvironment() {
  const errors = [];
  const chrome = findChrome();
  if (!chrome) errors.push('未找到工作台专用浏览器，请重新安装完整工作台。');
  if (!fs.existsSync(STORE_CONFIRM_SCRIPT)) errors.push(`缺少店铺确认窗口：${STORE_CONFIRM_SCRIPT}`);
  const resolvedFiles = {};
  for (const [key, fileName] of Object.entries(CONFIG.files)) {
    const fullPath = path.join(CONFIG.materialFolder, fileName);
    resolvedFiles[key] = fullPath;
    if (!fs.existsSync(fullPath)) {
      errors.push(`缺少素材：${fullPath}`);
      continue;
    }
    const size = fs.statSync(fullPath).size;
    if (key === 'qualificationPdf') {
      if (path.extname(fileName).toLowerCase() !== '.pdf') errors.push(`资质文件必须是 PDF：${fileName}`);
      if (size >= CONFIG.maxPdfBytes) errors.push(`资质 PDF 超过 10MB：${fileName}`);
    } else if (size >= CONFIG.maxFileBytes) {
      errors.push(`图片素材超过 3MB：${fileName}`);
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return { chrome, files: resolvedFiles };
}

function verifyComplianceEnvironment() {
  const chrome = findChrome();
  const errors = [];
  if (!chrome) errors.push('未找到工作台专用浏览器，请重新安装完整工作台。');
  if (!fs.existsSync(STORE_CONFIRM_SCRIPT)) errors.push(`缺少店铺确认窗口：${STORE_CONFIRM_SCRIPT}`);
  if (errors.length) throw new Error(errors.join('\n'));
  return { chrome };
}

function confirmStoreBeforeUpload() {
  writeStatus('awaiting-store-confirmation', {
    message: '请在专用 Chrome 中切换到目标店铺，然后点击确认按钮。',
  });
  log(`请先在专用 Chrome 中切换并确认目标店铺；确认前不会${COMPLIANCE_MODE ? '提交任何合规确认' : '上传任何文件'}。`);
  const result = spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    STORE_CONFIRM_SCRIPT,
  ], {
    cwd: __dirname,
    // This child owns the native confirmation form. Hiding the PowerShell process
    // also hides that form on Windows, so it must be allowed to create a visible window.
    windowsHide: false,
    stdio: 'ignore',
  });
  if (result.error) throw new Error(`无法打开店铺确认窗口：${result.error.message}`);
  if (result.status !== 0) {
    writeStatus('cancelled', { message: '用户取消了店铺确认，本次未开始。' });
    log('已取消店铺确认，本次没有执行平台操作。');
    return false;
  }
  log(`用户已确认目标店铺，${COMPLIANCE_MODE ? '警示声明确认' : '自动上传'}现在开始。`);
  writeStatus('store-confirmed', { confirmedAt: new Date().toISOString() });
  return true;
}

async function endpointAvailable() {
  try {
    const response = await fetch(`http://127.0.0.1:${CONFIG.debugPort}/json/version`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return false;
    const data = await response.json();
    return Boolean(data.webSocketDebuggerUrl);
  } catch (_error) {
    return false;
  }
}

async function listTargets() {
  const response = await fetch(`http://127.0.0.1:${CONFIG.debugPort}/json/list`, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error('无法读取 Chrome 页面列表');
  return response.json();
}

function clearTransientChromeCaches() {
  const profileRoot = path.resolve(CONFIG.profileFolder);
  const cacheNames = [
    'GPUPersistentCache',
    'ShaderCache',
    'GrShaderCache',
    'DawnCache',
    path.join('Default', 'GPUCache'),
    path.join('Default', 'Code Cache'),
  ];
  let removed = 0;
  for (const cacheName of cacheNames) {
    const target = path.resolve(profileRoot, cacheName);
    if (!target.startsWith(`${profileRoot}${path.sep}`)) continue;
    if (!fs.existsSync(target)) continue;
    try {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      removed += 1;
    } catch (error) {
      log(`Chrome 临时缓存清理跳过：${cacheName}（${error.code || error.message}）`);
    }
  }
  if (removed > 0) log(`已清理 ${removed} 项 Chrome 临时缓存；店铺登录资料保持不变。`);
}

async function ensureChrome(chromePath, pageUrl = CONFIG.pageUrl, pagePath = '/govern/upload-qualifications') {
  fs.mkdirSync(CONFIG.profileFolder, { recursive: true });
  if (!(await endpointAvailable())) {
    if (USING_FALLBACK_STATE) {
      log('本机状态目录不可写，专用 Chrome 已切换到工作台内的可写资料目录。');
    }
    log('正在打开专用 Chrome 窗口…');
    clearTransientChromeCaches();
    const chromeLaunchLog = path.join(LOG_FOLDER, 'chrome-launch.log');
    let chromeLogHandle;
    try { chromeLogHandle = fs.openSync(chromeLaunchLog, 'a'); } catch (_error) { /* ignore */ }
    const child = spawn(chromePath, [
      `--remote-debugging-port=${CONFIG.debugPort}`,
      `--user-data-dir=${CONFIG.profileFolder}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-features=TranslateUI',
      '--enable-logging=stderr',
      'about:blank',
    ], {
      detached: true,
      stdio: chromeLogHandle === undefined ? 'ignore' : ['ignore', chromeLogHandle, chromeLogHandle],
    });
    let chromeExitCode;
    child.once('error', (error) => log(`Chrome 启动失败：${error.message}`));
    child.once('exit', (code) => {
      chromeExitCode = code;
      if (code !== 0) log(`Chrome 启动进程提前退出（退出码 ${code}），详情见 chrome-launch.log。`);
    });
    child.unref();
    if (chromeLogHandle !== undefined) fs.closeSync(chromeLogHandle);
    try {
      await waitUntil(endpointAvailable, 20000, 'Chrome 启动', 500);
    } catch (error) {
      if (chromeExitCode !== undefined) {
        throw new Error(`专用 Chrome 启动失败（退出码 ${chromeExitCode}）。请双击工作台目录中的“重启工作台.vbs”后再试。`);
      }
      throw error;
    }
  } else {
    log('已连接上次使用的专用 Chrome 窗口。');
  }

  // Open the Temu target only after the debugging endpoint is stable, avoiding
  // a race between Chrome process startup and the first complex navigation.
  const initialTargets = await listTargets();
  const decodedIncludesTarget = (url) => {
    let value = String(url || '');
    for (let i = 0; i < 3; i += 1) {
      if (value.includes(pageUrl) || value.includes(pagePath)) return true;
      try { value = decodeURIComponent(value); } catch (_error) { break; }
    }
    return false;
  };
  const exact = initialTargets.find((target) => target.type === 'page' && decodedIncludesTarget(target.url));
  if (!exact) {
    await fetch(`http://127.0.0.1:${CONFIG.debugPort}/json/new?${encodeURIComponent(pageUrl)}`, { method: 'PUT' });
  }

  return waitUntil(async () => {
    const targets = await listTargets();
    const decodedIncludesTarget = (url) => {
      let value = String(url || '');
      for (let i = 0; i < 3; i += 1) {
        if (value.includes(pageUrl) || value.includes(pagePath)) return true;
        try { value = decodeURIComponent(value); } catch (_error) { break; }
      }
      return false;
    };
    return targets.find((target) => target.type === 'page'
      && target.url.includes(pagePath))
      || targets.find((target) => target.type === 'page' && decodedIncludesTarget(target.url));
  }, 20000, 'Temu 页面打开', 500);
}

async function evaluate(client, pageFunction, argument) {
  let functionSource = pageFunction.toString();
  // Methods stored on PAGE stringify as "name() {...}", which is not a standalone expression.
  // Convert method shorthand to an ordinary function before sending it to Chrome.
  if (/^[A-Za-z_$][\w$]*\s*\(/.test(functionSource)) functionSource = `function ${functionSource}`;
  const expression = `(${functionSource})(${argument === undefined ? '' : JSON.stringify(argument)})`;
  let response;
  try {
    response = await client.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
  } catch (error) {
    if (/context|Cannot find context|Inspected target navigated/i.test(error.message)) {
      await delay(500);
      response = await client.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      });
    } else {
      throw error;
    }
  }
  if (response.exceptionDetails) {
    const detail = response.exceptionDetails.exception?.description
      || response.exceptionDetails.text
      || '页面脚本执行失败';
    throw new Error(detail);
  }
  return response.result?.value;
}

async function waitForQualificationPage(client) {
  const loginDeadline = Date.now() + 15 * 60 * 1000;
  let pageWaitStarted = null;
  let nextNotice = 0;
  let lastError;
  while (Date.now() < loginDeadline) {
    let summary;
    try {
      if (await evaluate(client, PAGE.ready)) return;
      summary = await evaluate(client, PAGE.summary);
    } catch (error) {
      lastError = error;
    }
    const now = Date.now();
    const loginPage = summary?.loginPage;
    if (loginPage) pageWaitStarted = null;
    else if (pageWaitStarted === null) pageWaitStarted = now;
    const message = loginPage
      ? '当前为登录页面，请在专用 Chrome 完成登录。'
      : summary
        ? '正在等待商品资质页面控件加载；请保留商品资质页，控制台显示“选择”时按 Esc 退出选择。'
        : '暂时无法读取专用 Chrome 页面，正在等待页面连接恢复。';
    if (now >= nextNotice) {
      log(message);
      writeStatus('chrome-connected', { message });
      nextNotice = now + 15000;
    }
    if (pageWaitStarted !== null && now - pageWaitStarted >= 90000) {
      const details = summary
        ? `商品状态筛选框：${summary.statusFilterPresent ? '已找到' : '未找到'}；查询按钮：${summary.queryButtonPresent ? '已找到' : '未找到'}`
        : `页面连接错误：${lastError?.message || '未返回页面状态'}`;
      throw new Error(`商品资质页面在 90 秒内未就绪（${details}）。请检查页面加载、访问权限或页面改版；本次未执行上传。`);
    }
    await delay(1000);
  }
  throw new Error('等待 Temu 登录超时；本次未执行上传。请完成登录后重新启动工具。');
}

async function setLocalFile(client, selector, filePath) {
  const documentResult = await client.send('DOM.getDocument', { depth: 1, pierce: true });
  const rootNodeId = documentResult.root.nodeId;
  const query = await client.send('DOM.querySelector', { nodeId: rootNodeId, selector });
  if (!query.nodeId) throw new Error(`找不到文件输入框：${selector}`);
  await client.send('DOM.setFileInputFiles', { nodeId: query.nodeId, files: [filePath] });
}

async function clickPagePoint(client, point) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new Error('页面点击位置无效');
  }
  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1,
  });
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1,
  });
}

async function ensureUnpublishedFilter(client) {
  let state = await waitUntil(async () => {
    const current = await evaluate(client, PAGE.statusFilterState);
    return current?.ready && current?.point ? current : null;
  }, 90000, '商品状态筛选器', 600);
  if (!state.selected) {
    await clickPagePoint(client, state.point);
    // Rocket Select 会先播放展开动画；动画期间点选项会偶发被吞掉。
    await delay(400);
    const optionPoint = await waitUntil(() => evaluate(client, PAGE.unpublishedOptionPoint), 10000, '“未发布到站点”选项', 250);
    await clickPagePoint(client, optionPoint);
    state = await waitUntil(async () => {
      const current = await evaluate(client, PAGE.statusFilterState);
      return current?.selected ? current : null;
    }, 10000, '商品状态选择生效', 300);
  }
  const signatureBefore = await evaluate(client, PAGE.pageSignature);
  const queryPoint = await waitUntil(() => evaluate(client, PAGE.queryButtonPoint), 10000, '查询按钮', 300);
  await clickPagePoint(client, queryPoint);
  // 已有列表会在查询请求返回前短暂保留；稍等一次，避免把旧页误当成新结果。
  await delay(1200);
  const listState = await waitUntil(async () => {
    const current = await evaluate(client, PAGE.listState);
    if (!current?.selectedUnpublished) return null;
    if (current.productRowCount > 0 || current.totalCount === 0) return current;
    return null;
  }, 90000, '未发布商品列表加载完成', 700);
  const signatureAfter = await evaluate(client, PAGE.pageSignature);
  log(`商品状态已限定为“未发布到站点”${signatureBefore !== signatureAfter ? '，列表已更新' : ''}。`);
  return listState;
}

async function runReadOnlyPageCheck(chromePath) {
  const target = await ensureChrome(chromePath);
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  await client.send('Runtime.enable');
  try {
    const pageSignature = await evaluate(client, PAGE.pageSignature);
    const firstSpu = String(pageSignature || '').split('|')[0];
    const checks = {
      summary: await evaluate(client, PAGE.summary),
      ready: await evaluate(client, PAGE.ready),
      listState: await evaluate(client, PAGE.listState),
      pageSignature,
      qualificationModalInfo: await evaluate(client, PAGE.qualificationModalInfo),
      modalInfo: await evaluate(client, PAGE.modalInfo),
      submitReady: await evaluate(client, PAGE.submitReady),
      resultProbe: await evaluate(client, PAGE.result, firstSpu),
    };
    log(`页面只读检测通过：${JSON.stringify(checks)}`);
    return checks;
  } finally {
    client.close();
  }
}

async function runModalCheck(chromePath) {
  const target = await ensureChrome(chromePath);
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  await client.send('Runtime.enable');
  try {
    const next = await evaluate(client, PAGE.nextPending);
    if (!next?.clicked) throw new Error('当前页没有可用于预检的待传图商品');
    const modal = await waitUntil(async () => {
      const info = await evaluate(client, PAGE.modalInfo);
      return info?.open ? info : null;
    }, 20000, '预检上传窗口打开');
    const specs = [
      { sectionName: 'main', label: '正视图', fallbackIndex: 0 },
      { sectionName: 'main', label: '侧视图', fallbackIndex: 1 },
      { sectionName: 'main', label: '标签图', fallbackIndex: 2 },
      { sectionName: 'package', label: '正视图', fallbackIndex: 0 },
    ];
    const slots = [];
    for (const [index, spec] of specs.entries()) {
      const tagged = await evaluate(client, PAGE.tagSlot, { ...spec, token: `modal-check-${index}` });
      const status = await evaluate(client, PAGE.slotStatus, spec);
      slots.push({ spec, tagged, status });
    }
    if (!slots.every((slot) => slot.tagged?.ok)) throw new Error(`上传槽预检失败：${JSON.stringify(slots)}`);
    log(`上传窗口预检通过：${JSON.stringify({ modal, slots })}`);
    await evaluate(client, PAGE.closeModal);
    await waitUntil(async () => !(await evaluate(client, PAGE.modalInfo)).open, 10000, '关闭预检窗口');
    return { modal, slots };
  } finally {
    client.close();
  }
}

async function uploadSlot(client, files, spec) {
  const before = await evaluate(client, PAGE.slotStatus, spec);
  if (Number.isFinite(before?.count) && before.count > 0) {
    log(`${spec.sectionName === 'main' ? '商品主体' : '外包装'} / ${spec.label} 已有图片，跳过重复上传。`);
    return;
  }
  const token = `codex-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tagged = await evaluate(client, PAGE.tagSlot, { ...spec, token });
  if (!tagged?.ok) throw new Error(tagged?.reason || `无法定位${spec.label}上传槽`);
  await setLocalFile(client, `[data-codex-upload-token="${token}"]`, files[spec.fileKey]);
  log(`${spec.sectionName === 'main' ? '商品主体' : '外包装'} / ${spec.label} ← ${path.basename(files[spec.fileKey])}`);

  await waitUntil(async () => {
    const status = await evaluate(client, PAGE.slotStatus, spec);
    if (status?.failure) throw new Error(status.failure);
    if (!status?.modalOpen) throw new Error('上传窗口意外关闭');
    if (before?.count !== null && status?.count !== null) return status.count > before.count;
    return true;
  }, 60000, `${path.basename(files[spec.fileKey])}上传完成`, 500);
  await delay(350);
}

async function waitForNestedPhotos(client, expectedSpu) {
  const deadline = Date.now() + 5 * 60 * 1000;
  let nextNotice = Date.now() + 15000;
  let acknowledged = false;
  while (Date.now() < deadline) {
    const result = await evaluate(client, PAGE.photoAcknowledgement);
    if (result?.failure) throw new Error(result.failure);
    if (result?.acknowledged && !acknowledged) {
      acknowledged = true;
      log('Temu 已返回识别成功提示，继续等待图片保存和资质窗口恢复，不重复提交。');
    }
    if (result?.done) {
      const outer = await evaluate(client, PAGE.qualificationModalInfo);
      if (expectedSpu && outer?.spu && expectedSpu !== outer.spu) {
        throw new Error(`实拍图返回商品不一致：预期 SPU ${expectedSpu}，当前 ${outer.spu}`);
      }
      if (outer?.open && outer.photoReady && (!expectedSpu || outer.spu === expectedSpu)) return;
    }
    if (Date.now() >= nextNotice) {
      log('实拍图仍在识别或保存中，继续等待；本次不会重复上传图片。');
      writeStatus('uploading-qualification', { spu: expectedSpu, phase: 'recognizing-photos' });
      nextNotice = Date.now() + 15000;
    }
    await delay(700);
  }
  throw new Error('实拍图识别或保存超过 5 分钟；已保留当前窗口，未重复提交，请检查网络或平台提示后继续。');
}

async function processNestedPhotos(client, files, expectedSpu) {
  const modal = await waitUntil(async () => {
    const info = await evaluate(client, PAGE.modalInfo);
    return info?.open && info.fileInputCount >= 8 ? info : null;
  }, 30000, '商品实拍图上传窗口加载');
  if (!modal.hasMain || !modal.hasPackage) throw new Error('商品实拍图上传窗口结构与预期不一致');
  if (expectedSpu && modal.spu && expectedSpu !== modal.spu) {
    throw new Error(`商品校验失败：资质 SPU ${expectedSpu}，实拍图 SPU ${modal.spu}`);
  }

  const slots = [
    { sectionName: 'main', label: '正视图', fallbackIndex: 0, fileKey: 'productFront' },
    { sectionName: 'main', label: '侧视图', fallbackIndex: 1, fileKey: 'productSide' },
    { sectionName: 'main', label: '标签图', fallbackIndex: 2, fileKey: 'washLabel' },
    { sectionName: 'package', label: '正视图', fallbackIndex: 0, fileKey: 'packageFront' },
  ];
  for (const slot of slots) await uploadSlot(client, files, slot);

  await waitUntil(() => evaluate(client, PAGE.submitReady), 60000, '上传并识别按钮可用', 500);
  if (!(await evaluate(client, PAGE.clickSubmit))) throw new Error('无法点击“上传并识别”');
  log('四张实拍图已提交，等待 Temu 识别…');
  await waitForNestedPhotos(client, expectedSpu);
  log('商品实拍图识别成功，已返回资质窗口。');
}

async function uploadQualificationPdf(client, files) {
  const pdfPath = files.qualificationPdf;
  const fileName = path.basename(pdfPath);
  const existing = await evaluate(client, PAGE.qualificationPdfStatus, fileName);
  if (existing?.ready) {
    log(`检测报告已存在：${fileName}，跳过重复上传。`);
    return;
  }
  const token = `codex-pdf-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tagged = await evaluate(client, PAGE.tagQualificationPdf, token);
  if (!tagged?.ok) throw new Error(tagged?.reason || '无法定位检测报告上传槽');
  await setLocalFile(client, `[data-codex-pdf-token="${token}"]`, pdfPath);
  log(`GCC 检测报告 ← ${fileName}`);
  await waitUntil(async () => {
    const status = await evaluate(client, PAGE.qualificationPdfStatus, fileName);
    if (status?.failure) throw new Error(status.failure);
    if (!status?.modalOpen) throw new Error('资质窗口意外关闭');
    return status?.ready ? status : null;
  }, 120000, `${fileName}上传完成`, 600);
}

async function processQualificationOne(client, files, listSpu) {
  const modal = await waitUntil(async () => {
    const info = await evaluate(client, PAGE.qualificationModalInfo);
    return info?.open ? info : null;
  }, 30000, '上传资质窗口打开');
  const spu = modal.spu || listSpu;
  if (!modal.gcc || !modal.pdfInput) throw new Error('资质窗口不是预期的 GCC 小地毯资质结构');
  if (listSpu && modal.spu && listSpu !== modal.spu) {
    throw new Error(`商品校验失败：列表 SPU ${listSpu}，资质窗口 SPU ${modal.spu}`);
  }
  writeStatus('uploading-qualification', { spu, phase: 'live-photos' });
  log(`开始处理 GCC 资质${spu ? ` SPU ${spu}` : ''}。`);

  if (modal.photoReady) {
    log(`商品实拍图已完整存在（${modal.photoImageCount} 张），跳过图片编辑，直接补齐 GCC PDF。`);
  } else {
    if (!modal.photoAction || !(await evaluate(client, PAGE.clickPhotoUpload))) {
      throw new Error('商品实拍图尚未完整，但无法打开上传或编辑窗口');
    }
    if (modal.photoEdit) log('检测到部分或待复核实拍图，进入编辑窗口并仅补齐缺少的槽位。');
    await processNestedPhotos(client, files, spu);
    await waitUntil(async () => (await evaluate(client, PAGE.qualificationModalInfo))?.open,
      30000, '返回上传资质窗口', 500);
  }

  writeStatus('uploading-qualification', { spu, phase: 'qualification-pdf' });
  await uploadQualificationPdf(client, files);
  await waitUntil(() => evaluate(client, PAGE.qualificationSubmitReady), 60000, '资质确认按钮可用', 500);
  if (!(await evaluate(client, PAGE.clickQualificationSubmit))) throw new Error('无法点击资质“确认”按钮');
  log('实拍图和 GCC PDF 已提交，等待资质状态更新…');

  const acknowledgement = await waitUntil(async () => {
    const current = await evaluate(client, PAGE.qualificationResult, spu);
    if (current?.failure) throw new Error(current.failure);
    return current?.done || current?.acknowledged ? current : null;
  }, 180000, `${spu ? `SPU ${spu}` : '商品'}资质提交结果`, 700);

  if (!acknowledgement.done) {
    const synced = await waitUntil(async () => {
      const current = await evaluate(client, PAGE.qualificationResult, spu);
      if (current?.failure) throw new Error(current.failure);
      return current?.done ? current : null;
    }, 30000, '资质列表状态同步', 700).catch(() => null);
    if (!synced) log('Temu 已确认提交；列表状态仍在同步，本次运行不会重复处理该 SPU。');
  }
  log(`${spu ? `SPU ${spu}` : '该商品'}：实拍图及 GCC PDF 提交成功。`);
}

async function processOne(client, files, listSpu) {
  const modal = await waitUntil(async () => {
    const info = await evaluate(client, PAGE.modalInfo);
    return info?.open ? info : null;
  }, 20000, '上传窗口打开');
  if (!modal.open || !modal.hasMain || !modal.hasPackage) throw new Error('上传窗口结构与预期不一致');
  const spu = modal.spu || listSpu;
  const pendingBefore = (await evaluate(client, PAGE.listState))?.pendingCount;
  writeStatus('uploading', { spu, processed: null });
  log(`开始处理${spu ? ` SPU ${spu}` : '当前商品'}。`);

  const slots = [
    { sectionName: 'main', label: '正视图', fallbackIndex: 0, fileKey: 'productFront' },
    { sectionName: 'main', label: '侧视图', fallbackIndex: 1, fileKey: 'productSide' },
    { sectionName: 'main', label: '标签图', fallbackIndex: 2, fileKey: 'washLabel' },
    { sectionName: 'package', label: '正视图', fallbackIndex: 0, fileKey: 'packageFront' },
  ];
  for (const slot of slots) await uploadSlot(client, files, slot);

  await waitUntil(() => evaluate(client, PAGE.submitReady), 60000, '上传并识别按钮可用', 500);
  const clicked = await evaluate(client, PAGE.clickSubmit);
  if (!clicked) throw new Error('无法点击“上传并识别”');
  log('已提交，等待 Temu 返回识别结果…');

  const acknowledgement = await waitUntil(async () => {
    const result = await evaluate(client, PAGE.result, spu);
    if (result?.failure) throw new Error(result.failure);
    return result?.done || result?.acknowledged ? result : null;
  }, 180000, `${spu ? `SPU ${spu}` : '商品'}识别确认`, 700);

  if (!acknowledgement.done) {
    log('Temu 已返回成功提示，等待该 SPU 的列表状态同步…');
    const synced = await waitUntil(async () => {
      const result = await evaluate(client, PAGE.result, spu);
      if (result?.failure) throw new Error(result.failure);
      return result?.done ? true : null;
    }, 20000, '列表状态同步', 700).catch(() => false);

    if (!synced) {
      log('列表状态仍未同步，刷新专用页面并复核，期间不会再次上传该 SPU。');
      await client.send('Page.reload', { ignoreCache: false });
      await waitUntil(() => evaluate(client, PAGE.ready), 90000, '刷新商品实拍图页面', 800);
      await waitUntil(async () => {
        const list = await evaluate(client, PAGE.listState);
        if (!list?.productRowCount && !(list?.pendingLabelFound && list.pendingCount === 0)) return null;
        const result = await evaluate(client, PAGE.result, spu);
        if (result?.failure) throw new Error(result.failure);
        const pendingDecreased = Number.isFinite(pendingBefore)
          && list.pendingLabelFound
          && list.pendingCount < pendingBefore;
        return result?.done || pendingDecreased ? true : null;
      }, 90000, `${spu ? `SPU ${spu}` : '商品'}刷新后确认成功`, 800);
    }
  }
  log(`${spu ? `SPU ${spu}` : '该商品'}：识别成功。`);
}

async function runAutomation(client, files, limit = Infinity) {
  let processed = 0;
  const visited = new Set();
  const processedSpus = new Set();
  let pageMoves = 0;
  while (true) {
    const resumed = await evaluate(client, PAGE.qualificationModalInfo);
    if (resumed?.open) {
      const resumedSpu = resumed.spu || '';
      if (resumedSpu && processedSpus.has(resumedSpu)) {
        throw new Error(`重复保护触发：SPU ${resumedSpu} 已在本次运行处理过，程序已停止。`);
      }
      log(`${resumedSpu ? `SPU ${resumedSpu}` : '当前商品'}的资质窗口已打开，从页面现状继续补齐。`);
      await processQualificationOne(client, files, resumedSpu);
      if (resumedSpu) processedSpus.add(resumedSpu);
      processed += 1;
      writeStatus('running', { processed, lastSpu: resumedSpu, processedSpus: [...processedSpus] });
      if (processed >= limit) return processed;
      continue;
    }
    const next = await evaluate(client, PAGE.nextPending, [...processedSpus]);
    if (next?.clicked) {
      if (next.spu && processedSpus.has(next.spu)) {
        throw new Error(`重复保护触发：SPU ${next.spu} 已在本次运行处理过，程序已停止。`);
      }
      await processQualificationOne(client, files, next.spu);
      if (next.spu) processedSpus.add(next.spu);
      processed += 1;
      writeStatus('running', { processed, lastSpu: next.spu, processedSpus: [...processedSpus] });
      if (processed >= limit) return processed;
      continue;
    }

    const signature = await evaluate(client, PAGE.pageSignature);
    visited.add(signature);
    writeStatus('running', { processed, phase: 'turning-page', page: signature.split('|')[0] });
    let control = await evaluate(client, PAGE.nextPagePoint);
    if (!control?.available || !control.point) {
      log(`已检查到最后一页（${signature.split('|')[0]}），没有更多可处理商品。`);
      return processed;
    }
    await clickPagePoint(client, control.point);
    pageMoves += 1;
    if (pageMoves > 500) throw new Error('翻页次数异常，程序已停止以避免循环');
    let nextSignature = await waitUntil(async () => {
      const current = await evaluate(client, PAGE.pageSignature);
      return current !== signature ? current : '';
    }, 15000, '下一页加载', 500).catch(() => '');
    if (!nextSignature) {
      log(`第 ${control.currentPage || '?'} 页首次翻页未生效，正在重新定位分页按钮并重试。`);
      control = await evaluate(client, PAGE.nextPagePoint);
      if (control?.available && control.point) {
        await clickPagePoint(client, control.point);
        nextSignature = await waitUntil(async () => {
          const current = await evaluate(client, PAGE.pageSignature);
          return current !== signature ? current : '';
        }, 20000, '重试下一页加载', 500).catch(() => '');
      }
    }
    if (!nextSignature) {
      throw new Error(`已点击“下一页”，但商品列表没有更新（${signature.split('|')[0]}）。程序已停止，避免漏检后续页面。`);
    }
    if (visited.has(nextSignature)) {
      log(`平台返回了已检查页面（${nextSignature.split('|')[0]}），自动越过并继续向后翻页。`);
      continue;
    }
    log(`当前页已处理完，已进入下一页（${nextSignature.split('|')[0]}）。`);
  }
}

async function runComplianceReadOnlyPageCheck(chromePath) {
  const target = await ensureChrome(chromePath, COMPLIANCE.pageUrl, COMPLIANCE.path);
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  await client.send('Runtime.enable');
  try {
    const checks = {
      summary: await evaluate(client, COMPLIANCE_PAGE.summary),
      ready: await evaluate(client, COMPLIANCE_PAGE.ready),
      listState: await evaluate(client, COMPLIANCE_PAGE.listState),
      pageSignature: await evaluate(client, COMPLIANCE_PAGE.pageSignature),
      modalInfo: await evaluate(client, COMPLIANCE_PAGE.modalInfo),
    };
    log(`商品合规信息页面只读检测：${JSON.stringify(checks)}`);
    return checks;
  } finally {
    client.close();
  }
}

async function waitForComplianceResult(client, spu) {
  const deadline = Date.now() + 5 * 60 * 1000;
  let nextNotice = Date.now() + 15000;
  let lastResult;
  while (true) {
    lastResult = await evaluate(client, COMPLIANCE_PAGE.result, spu);
    if (lastResult?.failure) throw new Error(lastResult.failure);
    if (lastResult?.done || lastResult?.acknowledged) return lastResult;
    if (Date.now() >= deadline) break;
    if (Date.now() >= nextNotice) {
      const detail = JSON.stringify(lastResult || {});
      log('警示声明已点击确认，仍在等待平台保存或列表同步；不重复点击。状态：' + detail);
      writeStatus('confirming-warning', { spu, phase: 'waiting-confirmation', lastResult });
      nextNotice = Date.now() + 15000;
    }
    await delay(700);
  }
  throw new Error('SPU ' + spu + ' 确认后超过 5 分钟仍无法核实结果；未再次点击。请检查平台状态后继续。最后状态：'
    + JSON.stringify(lastResult || {}));
}

async function processComplianceOne(client, listSpu) {
  let modal = await waitUntil(async () => {
    const current = await evaluate(client, COMPLIANCE_PAGE.modalInfo);
    return current?.open ? current : null;
  }, 30000, '编辑合规信息窗口打开', 500);

  if (!(modal.pending && modal.selectedStatement && modal.responsibilityChecked && modal.confirmReady)) {
    log('编辑窗口内容仍在加载，等待警示声明和确认状态稳定。');
    const initialModal = modal;
    modal = await waitUntil(async () => {
      const current = await evaluate(client, COMPLIANCE_PAGE.modalInfo);
      return current?.open
        && current.pending
        && current.selectedStatement
        && current.responsibilityChecked
        && current.confirmReady
        ? current
        : null;
    }, 20000, '编辑合规信息内容加载', 500).catch(() => initialModal);
  }

  const spu = modal.spu || listSpu;
  if (listSpu && modal.spu && listSpu !== modal.spu) {
    throw new Error(`商品校验失败：列表 SPU ${listSpu}，编辑窗口 SPU ${modal.spu}`);
  }
  if (!modal.pending) throw new Error(`${spu ? `SPU ${spu}` : '当前商品'}没有“待确认”的小地垫易燃警示声明`);
  if (!modal.selectedStatement) throw new Error('警示声明内容未预先选定，程序已停止，避免替您选择未知声明。');
  if (!modal.responsibilityChecked) throw new Error('责任确认框未勾选，程序已停止，避免替您接受新的责任条款。');
  if (!modal.confirmReady) throw new Error('“确认”按钮当前不可用');

  writeStatus('confirming-warning', { spu });
  log(`SPU ${spu || '（页面商品）'}：声明和责任勾选均已存在，正在点击“确认”。`);
  if (!(await evaluate(client, COMPLIANCE_PAGE.clickConfirm))) throw new Error('无法点击合规信息“确认”按钮');

  const acknowledgement = await waitForComplianceResult(client, spu);
  if (!acknowledgement.done) {
    log('Temu 已接收确认；列表状态仍在同步，本次运行不会重复点击该 SPU。');
  }
  log(`SPU ${spu || '（页面商品）'}：小地垫易燃警示声明已确认。`);
  return spu;
}

async function runComplianceAutomation(client, limit = Infinity) {
  let processed = 0;
  const visited = new Set();
  const processedSpus = new Set();
  let pageMoves = 0;
  while (true) {
    const resumed = await evaluate(client, COMPLIANCE_PAGE.modalInfo);
    if (resumed?.open) {
      const resumedSpu = resumed.spu || '';
      if (resumedSpu && processedSpus.has(resumedSpu)) {
        throw new Error(`重复保护触发：SPU ${resumedSpu} 已在本次运行确认过，程序已停止。`);
      }
      log(`${resumedSpu ? `SPU ${resumedSpu}` : '当前商品'}的编辑窗口已打开，从页面现状继续。`);
      const confirmedSpu = await processComplianceOne(client, resumedSpu);
      if (confirmedSpu) processedSpus.add(confirmedSpu);
      processed += 1;
      writeStatus('running', { processed, lastSpu: confirmedSpu, processedSpus: [...processedSpus] });
      if (processed >= limit) return processed;
      continue;
    }

    const next = await evaluate(client, COMPLIANCE_PAGE.nextPending, [...processedSpus]);
    if (next?.clicked) {
      if (next.spu && processedSpus.has(next.spu)) {
        throw new Error(`重复保护触发：SPU ${next.spu} 已在本次运行确认过，程序已停止。`);
      }
      const confirmedSpu = await processComplianceOne(client, next.spu);
      if (confirmedSpu) processedSpus.add(confirmedSpu);
      processed += 1;
      writeStatus('running', { processed, lastSpu: confirmedSpu, processedSpus: [...processedSpus] });
      if (processed >= limit) return processed;
      continue;
    }

    const signature = await evaluate(client, COMPLIANCE_PAGE.pageSignature);
    visited.add(signature);
    writeStatus('running', { processed, phase: 'turning-page', page: signature.split('|')[0] });
    const moved = await evaluate(client, COMPLIANCE_PAGE.nextPage);
    if (!moved) {
      log(`已检查到最后一页（${signature.split('|')[0]}），没有更多待确认声明。`);
      return processed;
    }
    pageMoves += 1;
    if (pageMoves > 500) throw new Error('翻页次数异常，程序已停止以避免循环');
    const nextSignature = await waitUntil(async () => {
      const current = await evaluate(client, COMPLIANCE_PAGE.pageSignature);
      return current !== signature ? current : '';
    }, 30000, '下一页加载', 500).catch(() => '');
    if (!nextSignature) {
      throw new Error(`已点击“下一页”，但合规列表没有更新（${signature.split('|')[0]}）。程序已停止，避免漏检后续页面。`);
    }
    if (visited.has(nextSignature)) {
      log(`平台返回了已检查页面（${nextSignature.split('|')[0]}），自动越过并继续向后翻页。`);
      continue;
    }
    log(`当前页已检查完，继续检查下一页（${nextSignature.split('|')[0]}）。`);
  }
}

async function mainCompliance() {
  console.log('==============================================');
  console.log(` Temu 小地垫警示声明自动确认 v${CONFIG.version}`);
  console.log('==============================================');
  const environment = verifyComplianceEnvironment();
  if (!IS_DIAGNOSTIC) writeStatus('environment-ok', { mode: 'compliance-warning-confirmation' });
  log('专用 Chrome、店铺确认窗口和防重复锁检查通过。');

  if (process.argv.includes('--check')) {
    log('运行环境正常，可以双击“START-COMPLIANCE.cmd”。');
    return;
  }
  if (process.argv.includes('--page-check')) {
    await runComplianceReadOnlyPageCheck(environment.chrome);
    return;
  }

  acquireRunLock();
  process.on('exit', releaseRunLock);
  await ensureChrome(environment.chrome, COMPLIANCE.pageUrl, COMPLIANCE.path);
  if (process.argv.includes('--test-one-confirmed')) {
    log('本次单商品测试已由用户在当前会话确认目标店铺。');
  } else if (!confirmStoreBeforeUpload()) {
    releaseRunLock();
    return;
  }

  const target = await ensureChrome(environment.chrome, COMPLIANCE.pageUrl, COMPLIANCE.path);
  writeStatus('chrome-connected', { targetUrl: target.url });
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  await client.send('Runtime.enable');
  await client.send('DOM.enable');
  await client.send('Page.enable');
  try {
    const initial = await evaluate(client, COMPLIANCE_PAGE.summary);
    if (initial.loginPage || !(await evaluate(client, COMPLIANCE_PAGE.ready))) {
      log('请在专用 Chrome 中完成 Temu 登录；登录后程序会自动进入商品合规信息页面。');
    }
    await waitUntil(() => evaluate(client, COMPLIANCE_PAGE.ready), 15 * 60 * 1000,
      '登录并进入商品合规信息页面', 1000);
    const signatureBeforeFirst = await evaluate(client, COMPLIANCE_PAGE.pageSignature);
    const firstPage = await evaluate(client, COMPLIANCE_PAGE.firstPage);
    if (firstPage?.moved) {
      log('检测到列表停留在后续页，正在返回第 1 页。');
      await waitUntil(async () => {
        const current = await evaluate(client, COMPLIANCE_PAGE.pageSignature);
        return current !== signatureBeforeFirst ? current : '';
      }, 30000, '返回第 1 页', 500);
    }
    const listState = await waitUntil(async () => {
      const current = await evaluate(client, COMPLIANCE_PAGE.listState);
      return current.productRowCount > 0 || current.totalCount === 0 ? current : null;
    }, 90000, '商品合规信息列表加载', 700);
    const summary = await evaluate(client, COMPLIANCE_PAGE.summary);
    log(`店铺 ${summary.store || '（页面已确认）'}；当前页 ${listState.eligibleRowCount} 个地垫声明待确认。`);
    writeStatus('running', { processed: 0, store: summary.store, listState });
    await delay(1200);
    const testOne = process.argv.includes('--test-one') || process.argv.includes('--test-one-confirmed');
    const processed = await runComplianceAutomation(client, testOne ? 1 : Infinity);
    writeStatus(testOne ? 'test-complete' : 'complete', { processed, store: summary.store });
    log(`${testOne ? '单商品实测完成' : '全部完成'}，本次成功确认 ${processed} 个小地垫警示声明。`);
    console.log('可以关闭此窗口；专用 Chrome 会保留登录状态。');
  } finally {
    client.close();
    releaseRunLock();
  }
}

async function main() {
  if (COMPLIANCE_MODE) return mainCompliance();
  console.log('==============================================');
  console.log(` Temu 小地毯实拍图 + GCC资质自动上传 v${CONFIG.version}`);
  console.log('==============================================');
  const environment = verifyEnvironment();
  if (!IS_DIAGNOSTIC) writeStatus('environment-ok', { materialFolder: CONFIG.materialFolder });
  log('四张实拍图、GCC PDF 及 Chrome 检查通过。');
  for (const fileName of Object.values(CONFIG.files)) log(`素材：${fileName}`);

  if (process.argv.includes('--check')) {
    log('运行环境正常，可以双击“START.cmd”。');
    return;
  }

  if (process.argv.includes('--lock-check')) {
    acquireRunLock();
    log('运行锁创建检查通过。');
    releaseRunLock();
    return;
  }

  if (process.argv.includes('--page-check')) {
    await runReadOnlyPageCheck(environment.chrome);
    return;
  }

  if (process.argv.includes('--modal-check')) {
    await runModalCheck(environment.chrome);
    return;
  }

  acquireRunLock();
  process.on('exit', releaseRunLock);
  await ensureChrome(environment.chrome);
  const confirmedDevelopmentTest = process.argv.includes('--test-one-confirmed');
  if (confirmedDevelopmentTest) {
    log('本次测试已由用户在当前会话确认目标店铺。');
  } else if (!confirmStoreBeforeUpload()) {
    releaseRunLock();
    return;
  }
  // The store switch can navigate or recreate the page, so select the live target again
  // only after the user has explicitly confirmed the destination store.
  const target = await ensureChrome(environment.chrome);
  writeStatus('chrome-connected', { targetUrl: target.url });
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  await client.send('Runtime.enable');
  await client.send('DOM.enable');
  await client.send('Page.enable');

  try {
    await waitForQualificationPage(client);
    log('登录及商品资质页面已确认，正在查询“未发布到站点”商品…');
    let recovered = 0;
    const openQualification = await evaluate(client, PAGE.qualificationModalInfo);
    if (openQualification?.open) {
      if ((await evaluate(client, PAGE.modalInfo))?.open) {
        throw new Error('实拍图编辑窗口仍打开，请等待识别保存或关闭编辑窗口后再继续；未重复提交。');
      }
      log('检测到上次中止后保留的资质窗口，先补齐当前商品，再重新检查全部分页。');
      recovered = await runAutomation(client, environment.files, 1);
    }
    let listState = await ensureUnpublishedFilter(client);
    const signatureBeforeFirstPage = await evaluate(client, PAGE.pageSignature);
    const firstPageResult = await evaluate(client, PAGE.firstPage);
    if (firstPageResult?.moved) {
      log('检测到页面停留在后续页，正在返回第 1 页后再开始。');
      await waitUntil(async () => {
        const current = await evaluate(client, PAGE.pageSignature);
        return current !== signatureBeforeFirstPage ? current : '';
      }, 30000, '返回第 1 页', 500);
      listState = await waitUntil(async () => {
        const current = await evaluate(client, PAGE.listState);
        return current?.productRowCount > 0 ? current : null;
      }, 30000, '第 1 页商品加载', 500);
    }
    const summary = await evaluate(client, PAGE.summary);
    log(`店铺 ${summary.store || '（页面已确认）'}；未发布商品共 ${listState.totalCount} 条，当前页 ${listState.eligibleRowCount} 个待传 GCC 地垫、${listState.uploadCount} 个可上传入口。`);
    writeStatus('running', { processed: 0, store: summary.store, listState });
    await delay(1500);
    const testOne = process.argv.includes('--test-one');
    const processed = recovered + (testOne && recovered ? 0
      : await runAutomation(client, environment.files, testOne ? 1 : Infinity));
    writeStatus(testOne ? 'test-complete' : 'complete', { processed, store: summary.store });
    log(`${testOne ? '单商品测试完成' : '全部完成'}，本次成功处理 ${processed} 个商品资质。`);
    console.log('可以关闭此窗口；专用 Chrome 会保留登录状态，供下次继续使用。');
  } finally {
    client.close();
    releaseRunLock();
  }
}

process.on('unhandledRejection', (error) => {
  writeStatus('error', { message: error?.message || String(error) });
  console.error('\n自动上传已停止：');
  logError(error);
  process.exitCode = 1;
});

main().catch((error) => {
  writeStatus('error', { message: error?.message || String(error) });
  console.error('\n自动上传已停止：');
  logError(error);
  console.error(`请不要手动跳过当前失败商品；修正问题后重新双击“${COMPLIANCE_MODE ? 'START-COMPLIANCE.cmd' : 'START.cmd'}”。`);
  process.exitCode = 1;
});
