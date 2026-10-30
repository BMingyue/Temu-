/* Read-only evidence capture for one Temu activity candidate page.
 *
 * Temu renders SPU/SKC once at product level while the specifications and
 * prices are separate child rows. This scraper follows that hierarchy. It may
 * send a candidate without skuId; the local backend recovers it only from a
 * unique, exact same-shop SPU+SKC+daily-price product match.
 */
(() => {
  if (!/\/activity\/marketing-activity\/detail-new/.test(location.pathname)) return;
  if (document.getElementById("temuActivityEvidenceButton")) return;

  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const numeric = (value) => {
    const parsed = Number(String(value ?? "").replace(/,/g, ""));
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  };
  const labelledId = (text, label) => {
    const match = clean(text).match(new RegExp(`${label}(?:\\s*ID)?\\s*[:：]?\\s*(\\d{6,})`, "i"));
    return match ? match[1] : "";
  };
  const firstBareId = (text) => (clean(text).match(/(?:^|\s)(\d{6,})(?:\s|$)/) || [])[1] || "";
  const attrId = (root, names) => {
    if (!root) return "";
    for (const element of [root, ...root.querySelectorAll("*")]) {
      for (const name of names) {
        const value = element.getAttribute?.(name);
        if (/^\d{6,}$/.test(String(value || ""))) return String(value);
      }
    }
    return "";
  };
  const moneyAfter = (text, label) => {
    const match = clean(text).match(new RegExp(`${label}\\s*[:：]?\\s*(?:¥|￥)?\\s*([0-9,]+(?:\\.[0-9]{1,2})?)`, "i"));
    return match ? numeric(match[1]) : null;
  };
  const stockAfter = (text, label) => {
    const match = clean(text).match(new RegExp(`${label}\\s*[:：]?\\s*(\\d+)`, "i"));
    return match ? Number(match[1]) : null;
  };
  const normalizeSpec = (value) => {
    const match = clean(value).replace(/厘米/g, "cm").replace(/英寸|inches?/gi, "in").replace(/[xX*✕]/g, "×")
      .match(/(\d+(?:\.\d+)?)\s*×\s*(\d+(?:\.\d+)?)\s*(cm|in)?/i);
    if (match) return `${match[1]}×${match[2]}${(match[3] || "").toLowerCase()}`;
    const label = clean(value);
    return /^[\p{L}\p{N}_#./-]{1,40}$/u.test(label) && !/^\d{6,}$/.test(label) ? label : "";
  };
  const allSpecs = (text) => {
    const value = clean(text).replace(/厘米/g, "cm").replace(/英寸|inches?/gi, "in").replace(/[xX*✕]/g, "×");
    const found = [];
    for (const match of value.matchAll(/(\d+(?:\.\d+)?)\s*×\s*(\d+(?:\.\d+)?)\s*(cm|in)?/gi)) {
      const spec = `${match[1]}×${match[2]}${(match[3] || "").toLowerCase()}`;
      if (!found.includes(spec)) found.push(spec);
    }
    if (!found.length) {
      // Non-size attributes such as 混合色 are accepted only when the page
      // explicitly labels the following field as 货号.  This avoids treating
      // product titles or prices as SKU specifications.
      for (const match of value.matchAll(/(?:^|\s)([\p{L}\p{N}_#./-]{1,40})\s*货号\s*[:：]/gu)) {
        const spec = normalizeSpec(match[1]);
        if (spec && !found.includes(spec)) found.push(spec);
      }
    }
    return found;
  };
  const allCodes = (text) => [...clean(text).matchAll(/货号\s*[:：]\s*([^\s,，;；]+)/g)].map((match) => {
    const value = match[1] || "";
    if (value === "-" || /^(?:日常价|参考价|自定义|请输入|参考库存|销售库存)/.test(value)) return "";
    // Merchant codes are optional. Drop visually adjacent labels or unsafe
    // punctuation instead of turning one malformed code into a rejected batch.
    return /^[A-Za-z0-9][A-Za-z0-9_.#/-]{0,99}$/.test(value) ? value : "";
  });
  const allPrices = (text) => {
    const value = clean(text);
    const daily = [...value.matchAll(/日常价\s*[:：]?\s*(?:¥|￥)?\s*([0-9,]+(?:\.[0-9]{1,2})?)/g)].map((match) => numeric(match[1]));
    const reference = [...value.matchAll(/参考价\s*[:：]?\s*(?:¥|￥)?\s*([0-9,]+(?:\.[0-9]{1,2})?)/g)].map((match) => numeric(match[1]));
    return {daily, reference};
  };
  const directCells = (row) => [...row.children].filter((node) => node.tagName === "TD");
  const tableColumns = (table) => {
    const headers = [...table.querySelectorAll(":scope > thead th, :scope > thead td")].map((cell) => clean(cell.innerText || cell.textContent));
    const find = (...labels) => headers.findIndex((header) => labels.some((label) => header.includes(label)));
    return {
      product: find("商品信息"), skc: find("SKC信息", "SKC"), variants: find("SKU属性集", "SKU信息"),
      price: find("活动申报价格", "活动价格"), stock: find("库存"),
    };
  };
  const textAt = (cells, index) => index >= 0 && cells[index] ? clean(cells[index].innerText || cells[index].textContent) : "";
  const pageCampaignName = () => {
    const heading = [...document.querySelectorAll("h1,h2")].find((node) => !node.closest("#temuCollectorRoot,#temuActivityEvidenceButton") && clean(node.innerText || node.textContent));
    return clean(heading?.innerText || document.title).replace(/\s*[|｜-]\s*Temu.*$/i, "");
  };
  const nearestMallId = () => (document.cookie.match(/(?:^|;\s*)mallid=([^;]+)/) || [])[1] || "";
  const campaignId = () => new URLSearchParams(location.search).get("thematicId") || new URLSearchParams(location.search).get("activityId") || "";

  function candidatesFromRow(row, columns) {
    const cells = directCells(row);
    if (!cells.length) return [];
    const rowText = clean(row.innerText || row.textContent);
    const productText = textAt(cells, columns.product) || rowText;
    const skcText = textAt(cells, columns.skc);
    const variantText = textAt(cells, columns.variants) || rowText;
    const priceText = textAt(cells, columns.price) || rowText;
    const stockText = textAt(cells, columns.stock) || rowText;
    const spuId = attrId(row, ["data-spu-id", "data-product-id", "data-spuid"]) || labelledId(productText, "SPU");
    const skcId = attrId(row, ["data-skc-id", "data-product-skc-id", "data-skcid"]) || labelledId(skcText || rowText, "SKC") || firstBareId(skcText);
    if (!spuId || !skcId) return [];

    const explicitSkuId = attrId(row, ["data-sku-id", "data-product-sku-id", "data-skuid"]) || labelledId(rowText, "SKU ID");
    const specs = allSpecs(variantText);
    const codes = allCodes(variantText);
    const prices = allPrices(priceText);
    const count = Math.max(specs.length, prices.daily.length, explicitSkuId ? 1 : 0);
    if (!count) return [];
    const referenceStock = stockAfter(stockText, "参考库存");
    const salesStock = stockAfter(stockText, "销售库存");
    return Array.from({length: count}, (_, index) => ({
      spuId, skcId, skuId: count === 1 ? explicitSkuId : "", skuCode: codes[index] || "",
      specification: normalizeSpec(specs[index] || ""),
      dailyPrice: prices.daily[index] ?? moneyAfter(priceText, "日常价"),
      referenceActivityPrice: prices.reference[index] ?? moneyAfter(priceText, "参考价"),
      referenceStock, salesStock,
      eligible: true, candidateStatus: "可报名商品页分层只读快照", adjustable: null,
      source: "temu_activity_hierarchical_dom",
    }));
  }

  function collectCandidates() {
    const rows = [];
    for (const table of document.querySelectorAll("table")) {
      const columns = tableColumns(table);
      if (columns.product < 0 || columns.skc < 0 || (columns.variants < 0 && columns.price < 0)) continue;
      for (const row of table.querySelectorAll(":scope > tbody > tr")) rows.push(...candidatesFromRow(row, columns));
    }
    // Temu currently renders this page with nested layout containers rather
    // than a semantic table. Start at each SPU label and climb only to the
    // smallest ancestor that contains that product's variants and prices.
    if (!rows.length) {
      const anchors = [...document.querySelectorAll("span,div,p,td")].filter((node) => {
        const text = clean(node.innerText || node.textContent);
        return text.length <= 100 && /SPU\s*ID\s*[:：]?\s*\d{6,}/i.test(text);
      });
      for (const anchor of anchors) {
        const spuId = labelledId(anchor.innerText || anchor.textContent, "SPU");
        let container = anchor;
        for (let depth = 0; depth < 12 && container?.parentElement; depth += 1) {
          const candidate = container.parentElement;
          const text = clean(candidate.innerText || candidate.textContent);
          const productIds = new Set([...text.matchAll(/SPU(?:\s*ID)?\s*[:：]?\s*(\d{6,})/gi)].map((match) => match[1]));
          if (productIds.size > 1 || text.length > 30000) break;
          container = candidate;
          if (allSpecs(text).length && allPrices(text).daily.length) break;
        }
        const text = clean(container?.innerText || container?.textContent);
        const specs = allSpecs(text), prices = allPrices(text), codes = allCodes(text);
        if (!spuId || !specs.length || !prices.daily.length) continue;
        const skcId = attrId(container, ["data-skc-id", "data-product-skc-id", "data-skcid"]) || labelledId(text, "SKC");
        const count = Math.max(specs.length, prices.daily.length);
        for (let index = 0; index < count; index += 1) rows.push({
          spuId, skcId, skuId:"", skuCode:codes[index] || "", specification:specs[index] || "",
          dailyPrice:prices.daily[index] ?? null, referenceActivityPrice:prices.reference[index] ?? null,
          referenceStock:stockAfter(text, "参考库存"), salesStock:stockAfter(text, "销售库存"),
          eligible:true, candidateStatus:"可报名商品页分层只读快照", adjustable:null,
          source:"temu_activity_spu_container_dom",
        });
      }
    }
    // Last-resort parser for virtualized/non-semantic layouts: visible page
    // text is divided at each explicit SPU ID.  This does not infer any ID;
    // hidden SKC/SKU values remain blank for unique local reconciliation.
    const pageText = clean(document.body?.innerText || "");
    const productStarts = [...pageText.matchAll(/SPU(?:\s*ID)?\s*[:：]?\s*(\d{6,})/gi)];
    for (let productIndex = 0; productIndex < productStarts.length; productIndex += 1) {
      const match = productStarts[productIndex];
      const block = pageText.slice(match.index, productStarts[productIndex + 1]?.index ?? pageText.length);
      const spuId = match[1], specs = allSpecs(block), prices = allPrices(block), codes = allCodes(block);
      if (!specs.length || !prices.daily.length) continue;
      const skcId = labelledId(block, "SKC");
      const count = Math.max(specs.length, prices.daily.length);
      for (let index = 0; index < count; index += 1) rows.push({
        spuId, skcId, skuId:"", skuCode:codes[index] || "", specification:specs[index] || "",
        dailyPrice:prices.daily[index] ?? null, referenceActivityPrice:prices.reference[index] ?? null,
        referenceStock:stockAfter(block, "参考库存"), salesStock:stockAfter(block, "销售库存"),
        eligible:true, candidateStatus:"可报名商品页可见文本只读快照", adjustable:null,
        source:"temu_activity_visible_text_blocks",
      });
    }
    const unique = new Map();
    for (const row of rows) {
      if (!row.spuId || !row.specification) continue;
      const key = row.skuId
        ? `sku:${row.skuId}`
        : [row.spuId, row.skcId || "", row.skuCode || "", row.specification, row.dailyPrice ?? ""].join("|");
      const score = (row.skuId ? 4 : 0) + (row.skcId ? 2 : 0) + (row.skuCode ? 1 : 0);
      const previous = unique.get(key);
      const previousScore = previous ? (previous.skuId ? 4 : 0) + (previous.skcId ? 2 : 0) + (previous.skuCode ? 1 : 0) : -1;
      if (!previous || score > previousScore) unique.set(key, row);
    }
    return [...unique.values()];
  }

  const candidateKey = (row) => row.skuId
    ? `sku:${row.skuId}`
    : [row.spuId, row.skcId || "", row.skuCode || "", row.specification, row.dailyPrice ?? ""].join("|");
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const requestPageBridge = (command, payload = {}, timeoutMs = 12000) => new Promise((resolve) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { window.removeEventListener("message", receive); resolve({success:false,error:"页面网络批次读取超时"}); }, timeoutMs);
    function receive(event) {
      if ((event.source && event.source !== window) || event.data?.source !== "temu-dashboard-page" || event.data?.id !== id || !event.data.result) return;
      clearTimeout(timer); window.removeEventListener("message", receive); resolve(event.data.result);
    }
    window.addEventListener("message", receive);
    window.postMessage({source:"temu-dashboard-extension", id, command, payload}, "*");
  });
  const networkRows = async (since) => {
    const response = await requestPageBridge("ACTIVITY_NETWORK_EVIDENCE", {since});
    const batches = Array.isArray(response?.responses) ? response.responses : [];
    const diagnostics = Array.isArray(response?.diagnostics) ? response.diagnostics : [];
    return {batches, diagnostics, candidates:batches.flatMap((batch) => Array.isArray(batch?.candidates) ? batch.candidates : [])};
  };
  const reactRows = async () => {
    const response = await requestPageBridge("ACTIVITY_REACT_EVIDENCE", {}, 20000);
    return {rootCount:Number(response?.rootCount || 0), candidates:Array.isArray(response?.candidates) ? response.candidates : []};
  };
  const scrollableDocument = () => document.scrollingElement || document.documentElement || document.body;
  const elementVisible = (element) => {
    if (!element) return false;
    if (element.hidden || element.getAttribute?.("aria-hidden") === "true") return false;
    if (typeof getComputedStyle === "function") {
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return true;
  };
  const controlDisabled = (element) => Boolean(
    element?.disabled || element?.getAttribute?.("disabled") != null || element?.getAttribute?.("aria-disabled") === "true" ||
    /(?:^|[_\s-])disabled(?:$|[_\s-])/i.test(String(element?.className || ""))
  );
  const paginationRoot = (element) => element?.closest?.('[class*="pagination" i], [class*="pager" i], nav, [role="navigation"]') || null;
  const controlText = (element) => clean([
    element?.innerText, element?.textContent, element?.getAttribute?.("aria-label"), element?.getAttribute?.("title"),
    element?.getAttribute?.("data-testid"), element?.className,
  ].filter(Boolean).join(" "));
  function paginationControl(direction) {
    const candidates = [...document.querySelectorAll('button, [role="button"], li, a')]
      .filter((element) => element.id !== "temuActivityEvidenceButton" && elementVisible(element) && !controlDisabled(element));
    const pattern = direction === "next" ? /下一页|下页|next\s*page|page\s*next|pagination[_\s-]*next/i : /上一页|上页|previous\s*page|prev\s*page|page\s*prev|pagination[_\s-]*(?:prev|previous)/i;
    const symbols = direction === "next" ? /^(?:>|›|»|→)$/ : /^(?:<|‹|«|←)$/;
    return candidates.find((element) => pattern.test(controlText(element))) ||
      candidates.find((element) => paginationRoot(element) && symbols.test(clean(element.innerText || element.textContent))) || null;
  }
  function loadMoreControl(includeDisabled = false) {
    return [...document.querySelectorAll('button, [role="button"], a')]
      .filter((element) => element.id !== "temuActivityEvidenceButton" && elementVisible(element) && (includeDisabled || !controlDisabled(element)))
      .find((element) => /^(?:查询更多商品|加载更多商品|查看更多商品|加载更多|查询更多)$/.test(clean(element.innerText || element.textContent))) || null;
  }
  function remainingQueryCount() {
    const text = clean(document.body?.innerText || "");
    const match = text.match(/剩余\s*([0-9,]+)\s*件待查询/);
    return match ? Number(match[1].replace(/,/g, "")) : null;
  }
  function currentPageNumber() {
    const candidates = [...document.querySelectorAll('[aria-current="page"], [class*="pagination" i] [class*="active" i], [class*="pager" i] [class*="active" i]')];
    for (const element of candidates) {
      const value = Number(clean(element.innerText || element.textContent));
      if (Number.isInteger(value) && value > 0) return value;
    }
    return 1;
  }
  function pageNumberControl(number) {
    const label = String(number);
    return [...document.querySelectorAll('button, [role="button"], li, a')]
      .find((element) => paginationRoot(element) && elementVisible(element) && !controlDisabled(element) && clean(element.innerText || element.textContent) === label) || null;
  }
  function pageSignature() {
    const candidates = collectCandidates(), keys = [
      ...candidates.slice(0, 6).map(candidateKey),
      ...candidates.slice(-6).map(candidateKey),
    ];
    const remaining = remainingQueryCount();
    if (keys.length) return [candidates.length, remaining ?? "", ...keys].join("\n");
    return clean(document.body?.innerText || "").slice(0, 1200);
  }
  function clickControl(element) {
    element?.scrollIntoView?.({block:"center", inline:"center"});
    if (typeof MouseEvent === "function") {
      element?.dispatchEvent?.(new MouseEvent("mousedown", {bubbles:true, cancelable:true, view:typeof window !== "undefined" ? window : null}));
      element?.dispatchEvent?.(new MouseEvent("mouseup", {bubbles:true, cancelable:true, view:typeof window !== "undefined" ? window : null}));
    }
    element?.click?.();
  }
  async function waitForPageChange(previous, timeoutMs = 12000) {
    const deadline = Date.now() + timeoutMs;
    await pause(350);
    while (Date.now() < deadline) {
      const signature = pageSignature();
      if (signature && signature !== previous) {
        await pause(450);
        return true;
      }
      await pause(250);
    }
    return false;
  }
  async function waitForMoreProgress(previousRemaining, previousSignature = "", timeoutMs = 12000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const remaining = remainingQueryCount();
      if (remaining === 0) return true;
      if (previousRemaining != null && remaining != null && remaining < previousRemaining) return true;
      // The counter temporarily disappears while Temu appends a new batch.
      // A changed page signature is progress even when the previous counter
      // was visible and the current counter is temporarily absent.
      if (previousSignature && pageSignature() !== previousSignature) return true;
      await pause(100);
    }
    return false;
  }
  async function waitForMoreReady(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    let sawControl = false;
    while (Date.now() < deadline) {
      const remaining = remainingQueryCount(), control = loadMoreControl(true);
      sawControl ||= Boolean(control);
      if (remaining === 0) return {done:true, remaining};
      if (control && !controlDisabled(control)) return {done:false, control, remaining};
      if (remaining == null && !control && !sawControl) return {done:true, remaining};
      button.textContent = `Temu 正在加载更多商品，请稍候…${remaining == null ? "" : `剩余 ${remaining} 件`}`;
      await pause(100);
    }
    return {done:false, stalled:true, remaining:remainingQueryCount()};
  }
  async function expandAllProducts(maxClicks = 200) {
    let clicks = 0, stalled = false, transientRetries = 0;
    while (clicks < maxClicks) {
      const ready = await waitForMoreReady(clicks ? 15000 : 2500);
      if (ready.done) break;
      if (ready.stalled || !ready.control) { stalled = true; break; }
      const remaining = ready.remaining, more = ready.control;
      button.textContent = `正在连续查询更多商品…已点击 ${clicks} 次${remaining == null ? "" : `，剩余 ${remaining} 件`}`;
      const previousSignature = pageSignature();
      clickControl(more);
      clicks += 1;
      if (await waitForMoreProgress(remaining, previousSignature, 20000)) { transientRetries = 0; continue; }
      // Temu occasionally accepts a query while the remaining counter and
      // virtual list stay unchanged until the button becomes ready again.
      // Retry that transient state twice instead of declaring the full scan
      // finished after the first slow response.
      transientRetries += 1;
      if (transientRetries <= 2) {
        await pause(1200);
        continue;
      }
      stalled = true;
      break;
    }
    const remaining = remainingQueryCount();
    return {clicks, stalled, remaining, limitReached:clicks >= maxClicks && remaining !== 0 && Boolean(loadMoreControl(true))};
  }
  async function restorePage(originalPage, traversedPages) {
    if (traversedPages <= 1) return;
    const direct = pageNumberControl(originalPage);
    if (direct) {
      const before = pageSignature();
      clickControl(direct);
      await waitForPageChange(before, 6000);
      return;
    }
    for (let step = 1; step < traversedPages; step += 1) {
      const previous = paginationControl("previous");
      if (!previous) break;
      const before = pageSignature();
      clickControl(previous);
      if (!await waitForPageChange(before, 6000)) break;
    }
  }
  async function collectAcrossVirtualScroll() {
    const merged = new Map();
    // page-bridge storage is scoped to this activity-page lifetime, so include
    // every response since navigation. A manual rescan after two minutes must
    // still retain the initial/head batch that Temu may never request again.
    const networkSince = 0;
    let networkBatchCount = 0, networkResponseCount = 0, networkCandidateCount = 0, reactRootCount = 0, reactCandidateCount = 0, domCandidateCount = 0, signatureChanges = 0;
    let networkEndpoints = [];
    const addRows = (rows, sourceKind) => {
      const before = merged.size;
      for (const row of rows) {
        // Generic network/React extraction is diagnostic, not eligibility
        // evidence. Never upload guessed prices or an unverified eligible flag.
        if (row.identityOnly || row.eligible !== true) continue;
        const key = candidateKey(row), previous = merged.get(key);
        const score = (row.skuId ? 4 : 0) + (row.skcId ? 2 : 0) + (row.skuCode ? 1 : 0);
        const oldScore = previous ? (previous.skuId ? 4 : 0) + (previous.skcId ? 2 : 0) + (previous.skuCode ? 1 : 0) : -1;
        if (!previous || score > oldScore) merged.set(key, row);
      }
      const added = merged.size - before;
      if (sourceKind === "network") networkCandidateCount += added;
      else if (sourceKind === "react") reactCandidateCount += added;
      else domCandidateCount += added;
      return added;
    };
    const addVisible = () => addRows(collectCandidates(), "dom");
    const addNetwork = async () => {
      const evidence = await networkRows(networkSince);
      networkBatchCount = evidence.batches.length;
      networkResponseCount = evidence.diagnostics.length;
      networkEndpoints = [...new Set(evidence.diagnostics.map((item) => String(item?.url || "")).filter(Boolean))].slice(0,20);
      return addRows(evidence.candidates, "network");
    };
    const addReact = async () => {
      const evidence = await reactRows();
      reactRootCount = evidence.rootCount;
      return addRows(evidence.candidates, "react");
    };
    const visibleSignature = () => [...document.querySelectorAll("tr,[role='row'],div,span")]
      .map((element) => clean(element.innerText || element.textContent))
      .filter((text) => text.length < 4000 && /SPU\s*(?:ID)?\s*[:：]?\s*\d{6,}/i.test(text))
      .slice(0, 80).map((text) => (text.match(/SPU\s*(?:ID)?\s*[:：]?\s*(\d{6,})/i) || [])[1] || "").filter(Boolean).join("|");
    const depthOf = (element) => {
      let depth = 0;
      for (let current = element; current?.parentElement; current = current.parentElement) depth += 1;
      return depth;
    };
    const originalPage = currentPageNumber();
    let positions = 0, totalScrollers = 0, scanPasses = 0, pageTurns = 0, loadMoreClicks = 0;
    let pageLimitReached = false, loadMoreStalled = false, failedLoadAttempts = 0, unknownStablePasses = 0, finalRemaining = null;
    const seenPages = new Set();
    while (scanPasses < 200) {
      scanPasses += 1;
      const sizeAtPassStart = merged.size;
      button.textContent = `正在扫描第 ${scanPasses} 批已加载商品…已识别 ${merged.size} 个规格`;
      addVisible();
      await addNetwork();
      await addReact();
      const possible = [...document.querySelectorAll("*")].filter((element) => {
        if (element === document.documentElement || element === document.body) return false;
        const height = Number(element.clientHeight || 0), width = Number(element.clientWidth || 0);
        const distance = Number(element.scrollHeight || 0) - height;
        if (height < 120 || width < 280 || distance < 80) return false;
        const text = clean(element.innerText || element.textContent);
        const classText = clean([element.className, element.getAttribute?.('data-testid'), element.getAttribute?.('role')].filter(Boolean).join(' '));
        return /SPU\s*ID|日常价|商品信息/.test(text) || /table|list|virtual|scroll|body/i.test(classText);
      }).sort((left, right) => depthOf(right) - depthOf(left) || (right.scrollHeight - right.clientHeight) - (left.scrollHeight - left.clientHeight));
      const scrollers = [];
      for (const element of possible) {
        // Prefer the deepest virtual-list body. An outer container that wraps
        // an already selected inner list does not drive row virtualization.
        if (!scrollers.some((selected) => element.contains?.(selected))) scrollers.push(element);
        if (scrollers.length >= 4) break;
      }
      const documentScroller = scrollableDocument();
      if (documentScroller && Number(documentScroller.scrollHeight || 0) - Number(documentScroller.clientHeight || 0) >= 120 && !scrollers.includes(documentScroller)) scrollers.push(documentScroller);
      totalScrollers += scrollers.length;
      let loadedNextBatch = false;
      for (const element of scrollers) {
        const isDocument = element === documentScroller;
        const original = isDocument && typeof window !== "undefined" ? Number(window.scrollY || element.scrollTop || 0) : Number(element.scrollTop || 0);
        let top = 0, stableBottomPasses = 0, localPositions = 0, unchangedSignatureSteps = 0;
        let previousVisibleSignature = visibleSignature();
        while (localPositions < 1200) {
          const height = Math.max(180, Number(isDocument && typeof window !== "undefined" ? window.innerHeight : element.clientHeight) || 0);
          const maximum = Math.max(0, Number(element.scrollHeight || 0) - height);
          const target = Math.min(top, maximum);
          if (isDocument && typeof window !== "undefined") window.scrollTo(0, target); else element.scrollTop = target;
          element.dispatchEvent?.(new Event("scroll", {bubbles:true}));
          await pause(220);
          addVisible();
          await addNetwork();
          const currentVisibleSignature = visibleSignature();
          if (currentVisibleSignature && currentVisibleSignature !== previousVisibleSignature) {
            signatureChanges += 1;
            unchangedSignatureSteps = 0;
            previousVisibleSignature = currentVisibleSignature;
          } else unchangedSignatureSteps += 1;
          positions += 1; localPositions += 1;
          button.textContent = `正在扫描第 ${scanPasses} 批…累计 ${merged.size} 个规格 · 有效切换 ${signatureChanges} 次`;
          // This element scrolls but does not drive the product rows. Stop
          // wasting hundreds of positions on the same 430-row DOM snapshot.
          if (unchangedSignatureSteps >= 8 && target < maximum) break;
          if (target >= maximum) {
            stableBottomPasses += 1;
            if (stableBottomPasses >= 2) break;
          } else stableBottomPasses = 0;
          top = target + Math.max(160, Math.floor(height * 0.72));
        }
        // Crucial ordering: preserve the current batch before clicking once.
        // Temu may recycle all earlier virtual rows as soon as the next batch
        // is appended, so expanding everything before scanning loses the head.
        await pause(350);
        addVisible();
        await addNetwork();
        const bottomMore = loadMoreControl(true), bottomRemaining = remainingQueryCount();
        if (bottomRemaining != null) finalRemaining = bottomRemaining;
        if (bottomMore && !controlDisabled(bottomMore) && bottomRemaining !== 0 && loadMoreClicks < 200) {
          const previousSignature = pageSignature();
          button.textContent = `第 ${scanPasses} 批已保存，正在查询下一批…${bottomRemaining == null ? '' : `剩余 ${bottomRemaining} 件`}`;
          clickControl(bottomMore);
          loadMoreClicks += 1;
          const progressed = await waitForMoreProgress(bottomRemaining, previousSignature, 20000);
          if (progressed) {
            failedLoadAttempts = 0;
            const afterRemaining = remainingQueryCount();
            finalRemaining = afterRemaining;
            await pause(300);
            await addNetwork();
            loadedNextBatch = true;
          } else {
            failedLoadAttempts += 1;
            if (failedLoadAttempts >= 3) loadMoreStalled = true;
          }
        }
        if (isDocument && typeof window !== "undefined") window.scrollTo(0, original); else element.scrollTop = original;
        element.dispatchEvent?.(new Event("scroll", {bubbles:true}));
        await pause(100);
        if (loadedNextBatch || loadMoreStalled) break;
      }
      addVisible();
      await addNetwork();
      if (loadedNextBatch) {
        unknownStablePasses = 0;
        await pause(500);
        continue;
      }
      if (loadMoreStalled) break;

      const signature = pageSignature();
      if (signature) seenPages.add(signature);
      const remainingAfterScan = remainingQueryCount(), lateMore = loadMoreControl(true);
      if (remainingAfterScan != null) finalRemaining = remainingAfterScan;
      if (Number(remainingAfterScan || 0) > 0 || (lateMore && remainingAfterScan !== 0)) {
        failedLoadAttempts += 1;
        if (failedLoadAttempts >= 3) { loadMoreStalled = true; break; }
        await pause(800);
        continue;
      }
      const nextPage = paginationControl("next");
      if (nextPage) {
        button.textContent = `第 ${scanPasses} 批扫描完成，正在打开下一页…`;
        clickControl(nextPage);
        if (!await waitForPageChange(signature)) break;
        pageTurns += 1;
        const nextSignature = pageSignature();
        if (!nextSignature || seenPages.has(nextSignature)) break;
        unknownStablePasses = 0;
        continue;
      }
      if (remainingAfterScan === 0) { finalRemaining = 0; break; }
      unknownStablePasses = merged.size === sizeAtPassStart ? unknownStablePasses + 1 : 0;
      if (unknownStablePasses >= 2) { finalRemaining = null; break; }
      await pause(600);
    }
    if (scanPasses >= 200 || loadMoreClicks >= 200) pageLimitReached = true;
    await addNetwork();
    await addReact();
    await restorePage(originalPage, pageTurns + 1);
    return {candidates:[...merged.values()], scrollers:totalScrollers, positions, pages:pageTurns+1, scanPasses, pageTurns, loadMoreClicks, loadMoreStalled, remaining:finalRemaining, pageLimitReached, networkBatchCount, networkResponseCount, networkEndpoints, networkCandidateCount, reactRootCount, reactCandidateCount, domCandidateCount, signatureChanges};
  }

  async function capture() {
    button.disabled = true;
    button.textContent = "正在扫描全部商品…";
    const warnings = [];
    const scan = await collectAcrossVirtualScroll();
    const candidates = scan.candidates;
    if (!candidates.length) warnings.push("当前页面未识别到同时包含 SPU、规格和价格的商品容器，请等待商品加载完成后重试");
    if (scan.pageLimitReached) warnings.push("活动商品超过 200 轮查询，已安全停止；请联系维护人员扩大单次扫描范围");
    if (Number(scan.remaining || 0) > 0 && !scan.loadMoreStalled) warnings.push(`本次扫描结束时页面仍显示 ${scan.remaining} 件待查询，结果不完整，请点击状态继续扫描`);
    if (scan.loadMoreStalled) warnings.push(Number(scan.remaining || 0) > 0
      ? `Temu 多次等待后仍未恢复“查询更多商品”按钮，至少还有 ${scan.remaining} 件未展开`
      : 'Temu 的“查询更多商品”按钮多次未恢复，剩余数量也未显示；本次结果可能不完整，请点击状态再次续扫');
    if (scan.loadMoreClicks > 0 && scan.networkBatchCount === 0) warnings.push(scan.networkResponseCount > 0
      ? `已监听到 ${scan.networkResponseCount} 个活动相关接口响应，但解析出的商品批次为 0；接口：${scan.networkEndpoints.join('、') || '未知'}`
      : '页面已查询更多商品，但未捕获到活动商品网络批次；本次只能使用 DOM 结果，不能证明全量');
    if (scan.positions > 20 && scan.signatureChanges === 0) warnings.push(`页面滚动 ${scan.positions} 个位置但可见 SPU 签名从未变化，已判定滚动容器无效`);
    const hiddenSkuCount = candidates.filter((row) => !row.skuId).length;
    const hiddenSkcCount = candidates.filter((row) => !row.skcId).length;
    if (hiddenSkuCount || hiddenSkcCount) warnings.push(`${hiddenSkuCount} 个规格隐藏 SKU、${hiddenSkcCount} 个规格隐藏 SKC；仅在本地商品库唯一匹配时补全`);
    const response = await chrome.runtime.sendMessage({type:"WORKBENCH_ACTIVITY_EVIDENCE", body:{
      mall_id: nearestMallId(), campaign_id: campaignId(), campaign_name: pageCampaignName(),
      source_url: location.href, captured: new Date().toISOString(), candidates, warnings,
      capture_quality: !candidates.length || scan.loadMoreStalled || scan.pageLimitReached || scan.remaining !== 0 || (scan.loadMoreClicks > 0 && scan.networkCandidateCount === 0)
        ? "incomplete_dom"
        : (scan.networkBatchCount > 0 ? "network_batches_with_dom" : scan.scrollers || scan.pages > 1 ? "full_paginated_virtual_scroll" : "hierarchical_dom"),
      scan_stats: {scroll_containers:scan.scrollers, positions:scan.positions, pages:scan.pages, scan_passes:scan.scanPasses, page_turns:scan.pageTurns, load_more_clicks:scan.loadMoreClicks, load_more_stalled:scan.loadMoreStalled, remaining_query_count:scan.remaining, page_limit_reached:scan.pageLimitReached, network_batches:scan.networkBatchCount, network_responses_seen:scan.networkResponseCount, network_endpoints:scan.networkEndpoints, network_candidates_added:scan.networkCandidateCount, react_roots_seen:scan.reactRootCount, react_candidates_added:scan.reactCandidateCount, dom_candidates_added:scan.domCandidateCount, visible_signature_changes:scan.signatureChanges},
      collector_version: chrome.runtime.getManifest().version,
    }}).catch((error) => ({error:String(error)}));
    button.disabled = false;
    if (response?.error) {
      const reason = clean(response.error).replace(/^Error:\s*/i, "") || "未知错误";
      const serviceOffline = /工作台数据服务未启动|failed to fetch|network|timeout|abort/i.test(reason);
      button.textContent = serviceOffline ? "工作台未连接，点击重试" : "采集失败，点击查看原因";
      button.title = reason;
      button.dataset.error = reason;
    } else {
      const recovered = Number(response.recovered || 0), unresolved = Number(response.unresolved || 0);
      const saved = Number(response.rows || 0), scanned = Number(response.scanned || saved + unresolved);
      const remainingSuffix = Number(scan.remaining || 0) > 0 ? ` · 仍剩 ${scan.remaining} 件未展开` : scan.loadMoreStalled ? ' · 查询更多中断，结果可能不完整' : "";
      const sourceSuffix = ` · 网络批次 ${scan.networkBatchCount} / React新增 ${scan.reactCandidateCount} / 有效滚动 ${scan.signatureChanges}`;
      button.textContent = unresolved
        ? `已解析规格 ${scanned} · 已同步 ${saved} · 待核对 ${unresolved} · 查询更多 ${scan.loadMoreClicks} 次${sourceSuffix}${remainingSuffix}${response.needs_product_refresh ? " · 请刷新商品目录" : ""}`
        : `已同步本活动 ${saved} 个规格 · 查询更多 ${scan.loadMoreClicks} 次${sourceSuffix}${recovered ? `（补全 ${recovered}）` : ""}${remainingSuffix}`;
      button.title = unresolved
        ? `${unresolved} 个规格的隐藏 SKU ID 无法从本地商品目录唯一匹配，已保留在工作台“待补资料”中；${response.needs_product_refresh ? "本地商品目录超过 12 小时未刷新，请先运行“商品与活动采集”再重试。" : "可在工作台核对具体原因。"}当前活动数据不等于店铺全部 SKU。`
        : "当前活动全部已识别分页已保存到本地工作台；这里不代表店铺全部 SKU";
      delete button.dataset.error;
    }
  }

  const button = document.createElement("button");
  button.id = "temuActivityEvidenceButton";
  button.type = "button";
  button.textContent = "活动页只读采集";
  button.title = "分层读取当前活动商品的 SPU、SKC、规格、价格和库存，不填写或提交";
  Object.assign(button.style, {
    position:"fixed", right:"22px", bottom:"82px", zIndex:"2147483646",
    border:"1px solid #d85f2c", borderRadius:"8px", background:"#fff7f0",
    color:"#a7441e", padding:"10px 14px", maxWidth:"520px", whiteSpace:"normal", fontSize:"13px", boxShadow:"0 4px 18px rgba(0,0,0,.12)", cursor:"pointer",
  });
  button.addEventListener("click", capture);
  document.documentElement.appendChild(button);
  // One safe, read-only refresh per activity-page load. This keeps enrollment
  // evidence fresh without asking the operator to find the floating button.
  if (typeof setTimeout === "function") setTimeout(() => {
    if (!button.disabled && typeof document.querySelector === "function" && document.querySelector("table tbody tr")) capture();
  }, 2500);
})();
