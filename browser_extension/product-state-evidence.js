/* Observe explicit accelerator labels on the current visible flow page.
 * Only explicit page setup/navigation commands click controls; no submissions, inferred
 * discounts, or absence-as-disabled logic. */
(() => {
  const clean = value => String(value || "").replace(/\s+/g, " ").trim();
  function parse(text, fallbackSite = "") {
    text = clean(text);
    const ids = [...new Set([...text.matchAll(/SPU\s*ID\s*[:：]?\s*(\d{5,})/gi)].map(match=>match[1]))];
    if (ids.length !== 1) return null;
    const siteName = clean(text.match(/经营站点\s*[:：]\s*([^·|，,]+?站)/)?.[1] || fallbackSite);
    if (!siteName) return null;
    const enabled = /流量加速中|流量加速器已开启/.test(text);
    const max = /(?:开启流量加速器.{0,15}Max模式|Max\s*模式待开启)/i.test(text);
    const eligible = /流量加速器待开启|流量加速器未开启|流量加速器.{0,10}立即开启/.test(text);
    const disabled = /流量加速器已关闭/.test(text);
    const status = [enabled, max || eligible, disabled].filter(Boolean).length > 1 ? "unknown"
      : enabled ? "enabled" : max ? "max_eligible" : eligible ? "eligible" : disabled ? "disabled" : "unknown";
    // Only a price explicitly labelled as the accelerator's price is usable.
    // Generic supplier/activity/sale prices and naked numbers are ignored.
    const quotes = [...text.matchAll(/(?:加速器开启后价|加速器价格|流量加速价|加速后申报价)\s*[:：]?\s*(¥|￥|\$|USD|CNY|人民币)\s*(\d+(?:\.\d{1,2})?)(?![\d.])/gi)];
    const skuIds = [...text.matchAll(/(?:^|\s)SKU\s*ID\s*[:：]\s*(\d{5,})/gi)];
    const observed = quotes.length === 1 && skuIds.length <= 1 && status !== "unknown" ? quotes[0] : null;
    const quote = observed && !/^[ ]*[-–~～至]/.test(text.slice(observed.index + observed[0].length)) ? observed : null;
    const price = quote ? Number(quote[2]) : null;
    return {spuId:ids[0], skcId:"", skuId:skuIds.length === 1 ? skuIds[0][1] : "",
      siteName, status, price, currency:quote ? (/^(?:\$|USD)$/i.test(quote[1]) ? "USD" : "CNY") : "",
      priceKind:price == null ? "" : status === "enabled" ? "current" : "offer",
      evidence:[enabled ? "流量加速中" : "", max ? "Max模式待开启" : "", eligible ? "待开启" : "", disabled ? "已关闭" : "", quote?.[0] || ""].filter(Boolean).join(" · ")};
  }
  const excluded = element => element.closest("#temuCollectorRoot,#wbDailyBar,#workbench-flow-tools");
  const visible = element => element.getClientRects().length > 0 && !excluded(element);
  const disabled = element => {
    for(let current=element;current;current=current.parentElement){
      if(current.disabled || current.getAttribute("aria-disabled")==="true" ||
         /(?:^|[ _-])disabled(?:$|[ _-])/i.test(String(current.className||"")))return true;
    }
    return false;
  };
  const paginationAreas = doc => [...doc.querySelectorAll('[class*="pagination" i],[class*="pager" i],[data-testid*="pagination" i],nav,[role="navigation"]')].filter(visible);
  const sizeAreas = (doc,pagers) => [...new Set([...pagers,...doc.querySelectorAll('[class*="PGT_sizeChanger"]')])].filter(visible);
  function readPageSize(doc,pagers) {
    const areas = sizeAreas(doc,pagers);
    const sizes = new Set(areas.flatMap(area=>[...area.querySelectorAll('[class*="PGT_sizeChanger"] input,[data-testid="beast-core-select-htmlInput"],select')])
      .map(element=>clean(element.value)).filter(value=>/^\d+$/.test(value)));
    if (sizes.size===1) return Number([...sizes][0]);
    const footer = areas.map(area=>clean(area.innerText).replace(/\s/g,"").match(/每页(\d+)/)).find(Boolean);
    if (footer) return Number(footer[1]);
    const mirror = areas.flatMap(area=>[...area.querySelectorAll('[class*="PGT_sizeChanger"] [class*="IPT_mirror"]')])
      .map(element=>clean(element.textContent)).find(value=>/^\d+$/.test(value));
    return mirror ? Number(mirror) : null;
  }
  function pageControls(doc) {
    // Match the existing activity reader's pager and accessibility evidence.
    // Merchant components may expose only a test ID or an arrow inside a pager.
    const pagers = paginationAreas(doc);
    const label = element => clean([element.getAttribute("aria-label"),element.getAttribute("title"),
      element.getAttribute("data-testid"),element.className,element.innerText].filter(Boolean).join(" "));
    const explicit = element => /^(?:下一页|下页|Next(?: page)?)$/i.test(clean(element.innerText)) ||
      /下一页|下页|next\s*page|page\s*next|pagination[_\s-]*next/i.test(label(element));
    const candidates = [...new Set(pagers.flatMap(pager=>[pager,...pager.querySelectorAll('button,a,li,[role="button"],[data-testid*="next" i]')]))].filter(visible);
    // Outside a recognized pager, accept only a clearly labelled Next control.
    const labelled = [...doc.querySelectorAll('button,a,li,[role="button"],[rel="next"]')].filter(visible)
      .filter(element=>explicit(element) || element.getAttribute("rel")==="next");
    const nextCandidates = [...new Set([...candidates.filter(explicit),...labelled])];
    const unique = nextCandidates.filter(element=>!nextCandidates.some(other=>other!==element && element.contains(other)));
    const arrowCandidates = candidates.filter(element=>/^(?:>|›|»|→)$/.test(clean(element.innerText)));
    const arrows = arrowCandidates.filter(element=>!arrowCandidates.some(other=>other!==element && element.contains(other)));
    const next = unique.length===1 ? unique[0] : unique.length===0 && arrows.length===1 ? arrows[0] : null;
    // Temu uses PGT_pagerItemActive (Item capital I). CSS [class*="itemActive"] is case-sensitive and misses it.
    const active = pagers.flatMap(pager=>[...pager.querySelectorAll('li,button,a,[role="button"],[aria-current]')])
      .filter(element=>visible(element) && /^\d+$/.test(clean(element.innerText)) && (
        element.getAttribute('aria-current')==='page' ||
        /pagerItemActive|item-?active|ItemActive|(?:^|[\s_])active(?:$|[\s_])/i.test(String(element.className||''))
      ))
      .find(Boolean);
    const totals = pagers.map(pager=>clean(pager.innerText).match(/(?:共有|共)\s*([\d,]+)\s*(?:条|件|个|items?)|\bTotal(?:\s+items?)?\s*[:：]?\s*([\d,]+)/i))
      .filter(Boolean).map(match=>Number((match[1] || match[2]).replace(/,/g,"")));
    return {next, pageNumber:active?Number(clean(active.innerText)):null,pageSize:readPageSize(doc,pagers),
      total:totals.length && new Set(totals).size===1?totals[0]:null,
      diagnostics:{pagerCount:pagers.length,nextCount:unique.length,
        controls:candidates.slice(0,20).map(element=>({
          tag:element.tagName,className:String(element.className||"").slice(0,160),
          testId:String(element.getAttribute("data-testid")||"").slice(0,160),
          disabled:disabled(element)
        }))}};
  }
  function readPage(doc, sourceUrl) {
    const title = [...doc.querySelectorAll("h1,h2,h3,[class*='page-title']")].filter(element=>!excluded(element))
      .map(element=>clean(element.innerText)).find(text=>/商品流量\s*[·・—-]\s*(美国|欧区)/.test(text)) || "";
    const fallback = title.match(/商品流量\s*[·・—-]\s*(美国|欧区)/)?.[1];
    const rows = new Map();
    for (const element of doc.querySelectorAll("tr,[role='row']")) {
      if (!visible(element)) continue;
      const row = parse(element.innerText, fallback ? fallback+"站" : "");
      if (!row) continue;
      const key = [row.spuId,row.siteName,row.skuId].join("|"), previous = rows.get(key);
      if (previous && previous.status!==row.status && row.status!=="unknown" && previous.status!=="unknown") {
        rows.set(key,{...row,sourceUrl,status:"unknown",price:null,currency:"",priceKind:"",evidence:"同页状态冲突"});
      } else if (!previous || previous.status==="unknown" && previous.evidence!=="同页状态冲突") {
        rows.set(key,{...row,sourceUrl});
      }
    }
    const controls = pageControls(doc), values = [...rows.values()];
    const rateLimit = [...doc.querySelectorAll('[role="alert"],[class*="toast"],[class*="message"],[class*="Message"],[class*="notification"]')]
      .filter(visible).map(element=>clean(element.innerText || element.textContent))
      .find(text=>/(?:访问|操作|请求)过于频繁|请求频繁|too many requests/i.test(text)) || "";
    const empty = !values.length && (controls.total===0 || [...doc.querySelectorAll(
      'table [class*="empty" i],[role="table"] [class*="empty" i],[data-testid*="table-empty" i],[class*="TB_empty"]'
    )].filter(visible).some(element=>/暂无(?:数据|商品)|没有(?:相关|符合条件的)?(?:数据|商品)|无数据|no (?:data|results|products)/i.test(clean(element.innerText || element.textContent))));
    return {rows:values,empty,pageNumber:controls.pageNumber,pageSize:controls.pageSize,rateLimit,total:controls.total,pagination:controls.diagnostics,
      hasNext:controls.next ? !disabled(controls.next) : null,
      signature:JSON.stringify(values.map(row=>[row.spuId,row.siteName,row.skuId,row.status,row.price])),
      loading:[...doc.querySelectorAll('[aria-busy="true"],[class*="spin-spinning"],[class*="loading-mask"]')].some(visible)};
  }
  function nextPage(doc) {
    const {next}=pageControls(doc);
    if (!next || disabled(next)) throw Error("未识别到可用的流量页下一页，已保留本轮读取结果");
    next.click();return {success:true};
  }
  function goToPage(doc,n) {
    const target = Number(n);
    if (!Number.isInteger(target) || target<=0) throw Error("流量页目标页码无效");
    const candidates = [...new Set(paginationAreas(doc).flatMap(pager=>[
      ...pager.querySelectorAll('li,button,a,[role="button"],[aria-current]')
    ]))].filter(element=>visible(element) && clean(element.innerText)===String(target) &&
      !element.closest('[class*="PGT_sizeChanger"],[role="listbox"],[role="combobox"]'));
    const unique = candidates.filter(element=>!candidates.some(other=>other!==element && element.contains(other)));
    if (unique.length!==1 || disabled(unique[0])) throw Error("未唯一识别到可用的流量页第 "+target+" 页，已保留本轮读取结果");
    unique[0].click();return {success:true,pageNumber:target};
  }
  async function setPageSize(doc,size=100) {
    const target = Number(size);
    if (!Number.isInteger(target) || target<=0) throw Error("流量页每页条数无效");
    const pagers = paginationAreas(doc);
    if (readPageSize(doc,pagers)===target) return {success:true,pageSize:target,changed:false};
    const areas = sizeAreas(doc,pagers);
    const controls = [...new Set(areas.flatMap(area=>[
      ...(area.matches('[class*="PGT_sizeChanger"]') ? [area] : []),
      ...area.querySelectorAll('[class*="PGT_sizeChanger"],select,[role="combobox"],[data-testid="beast-core-select-htmlInput"]')
    ]))].filter(element=>visible(element) && !disabled(element));
    const control = controls.find(element=>element.matches('[class*="PGT_sizeChanger"]')) || controls[0];
    if (!control) {
      const page=readPage(doc);
      // An explicitly empty table can omit its pager entirely. Do not invent a
      // page size or block the remaining partitions when there are no rows.
      if (page.empty && !page.loading && !page.rateLimit) return {success:true,pageSize:null,empty:true,changed:false};
      throw Error("未找到流量页每页条数控件");
    }
    const matches = element => new RegExp('^(?:每页\\s*)?'+target+'(?:\\s*(?:条|件|个|items?))?(?:\\s*[/／]\\s*页)?$','i')
      .test(clean(element.innerText || element.textContent));
    const select = control.tagName==='SELECT' ? control : control.querySelector('select');
    if (select) {
      if (disabled(select)) throw Error("流量页每页条数控件不可用");
      const option = [...select.options].find(element=>!element.disabled && (Number(element.value)===target || matches(element)));
      if (!option) throw Error("未找到流量页每页 "+target+" 条选项");
      select.value=option.value;
      const EventType = doc.defaultView?.Event || Event;
      for (const type of ['input','change']) select.dispatchEvent(new EventType(type,{bubbles:true}));
      return {success:true,pageSize:target,changed:true};
    }
    const opener = [...control.querySelectorAll('[role="combobox"],[data-testid="beast-core-select-htmlInput"],input')].find(visible) || control;
    opener.click();
    const linkedIds = clean(opener.getAttribute('aria-controls') || opener.getAttribute('aria-owns') || control.getAttribute('aria-controls')).split(' ').filter(Boolean);
    for (let attempt=0;attempt<30;attempt++) {
      const roots = linkedIds.length ? linkedIds.map(id=>doc.getElementById(id)).filter(Boolean) : [doc];
      const options = [...new Set(roots.flatMap(root=>[...root.querySelectorAll('[role="option"],[data-testid*="select-option"],[class*="OPT_item"],[class*="select-option"],[role="listbox"] li')]))]
        .filter(element=>visible(element) && !disabled(element) && matches(element));
      const unique = options.filter(element=>!options.some(other=>other!==element && element.contains(other)));
      if (unique.length===1) {unique[0].click();return {success:true,pageSize:target,changed:true};}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    throw Error("未找到流量页每页 "+target+" 条选项");
  }
  async function ensureStickySort(doc) {
    // Live flux-analysis headers use「SPU信息」; keep older identity/time labels too.
    const preferred = ["SPU信息","商品信息","商品 ID","SPU ID","SPU","创建时间","商品创建时间"];
    const headers = () => [...doc.querySelectorAll('thead th,thead td,table th,[role="columnheader"],thead button,thead [role="button"]')].filter(visible);
    const label = element => clean(element.innerText || element.textContent || element.getAttribute('aria-label') || element.getAttribute('title')).replace(/[↑↓↕▲▼△▽]/g, '').trim();
    const normalize = value => String(value || '').replace(/\s/g,'').toUpperCase();
    const matchesPreferred = (headerText, column) => {
      const header = normalize(headerText), want = normalize(column);
      if (!header || !want) return false;
      if (header === want) return true;
      // Header contains preferred (「SPU信息」contains「SPU」). Prefer longer preferred via find order.
      // Reject accidental short matches inside unrelated metrics (e.g. never match empty).
      if (want.length < 2) return false;
      if (!header.includes(want)) return false;
      // 「支付转化率」must not match「SPU」; only allow contain when header is clearly the identity column.
      if (want === 'SPU' && !/^SPU(?:信息|ID)?$/.test(header) && !header.startsWith('SPU')) return false;
      return true;
    };
    const sortSelector = '[aria-sort],[class*="sort" i],[data-testid*="sort" i],button,[role="button"],svg,i,span';
    const sortAffordance = element => {
      if (!element) return false;
      if (element.getAttribute('aria-sort')!==null) return true;
      return /sort|排序|升序|降序|sorter/i.test([
        element.getAttribute('class') || element.className,element.getAttribute('data-testid'),
        element.getAttribute('aria-label'),element.getAttribute('title')
      ].join(' '));
    };
    const clickable = element => element && !disabled(element) && typeof element.click==='function';
    const matchesExact = (headerText, column) => {
      const header = normalize(headerText), want = normalize(column);
      return Boolean(header && want && header === want);
    };
    const resolveControl = header => {
      const nodes = [...header.querySelectorAll(sortSelector)].filter(visible);
      const button = nodes.find(element=>(element.tagName==='BUTTON' || element.getAttribute('role')==='button') &&
        (sortAffordance(element) || [...element.querySelectorAll(sortSelector)].some(sortAffordance)));
      const icon = nodes.find(element=>sortAffordance(element) && clickable(element));
      // Prefer explicit sort control; else click the th/columnheader itself (Temu often sorts on th).
      return [button, icon, sortAffordance(header) ? header : null, header].find(clickable) || null;
    };
    const find = (column, matcher = matchesPreferred) => {
      const matched = headers().filter(element=>matcher(label(element), column));
      for (const header of matched) {
        const control = resolveControl(header);
        if (control) return {header,control,matchedLabel:label(header)};
      }
      return null;
    };
    const pickPreferred = () => {
      for (const column of preferred) {
        const hit = find(column, matchesExact);
        if (hit) return hit;
      }
      for (const column of preferred) {
        const hit = find(column, matchesPreferred);
        if (hit) return hit;
      }
      return null;
    };
    const direction = header => {
      if (!header) return '';
      const nodes = [header,...header.querySelectorAll('[aria-sort],[class]')].filter(visible);
      for (const node of nodes) {
        const aria = node.getAttribute('aria-sort');
        if (aria==='ascending' || aria==='descending') return aria==='ascending' ? 'asc' : 'desc';
      }
      for (const node of nodes) {
        const classes = String(node.getAttribute('class') || node.className || '');
        if (/inactive|unsorted|disabled/i.test(classes)) continue;
        const active = /active|sorted/i.test(classes) || node===header && /(?:^|[\s_-])sort(?:ing)?[_-](?:asc|desc)(?:ending)?(?:$|[\s_-])/i.test(classes);
        if (/sort|asc|desc/i.test(classes) && active) {
          return /desc|down/i.test(classes) ? 'desc' : /asc|up/i.test(classes) ? 'asc' : 'active';
        }
      }
      return '';
    };
    const seen = [...new Set(headers().map(label).filter(Boolean))].join('、') || '（无可见表头）';
    const clickableSeen = [...new Set(headers().flatMap(header=>{
      const nodes = [header,...header.querySelectorAll('button,[role="button"],[aria-sort],[class*="sort" i]')].filter(visible);
      return nodes.filter(clickable).map(node=>clean(label(node) || node.tagName));
    }).filter(Boolean))].join('、') || '（无）';
    // Live Temu often never sets aria-sort; prove the click by first-page row order changing.
    const pageRowSignature = () => {
      const keys = [];
      for (const element of doc.querySelectorAll("tbody tr,tr,[role='row']")) {
        if (!visible(element)) continue;
        const text = clean(element.innerText || element.textContent);
        if (!text) continue;
        const parsed = parse(text, "");
        if (parsed) {
          keys.push([parsed.spuId, parsed.siteName, parsed.skuId].join("|"));
          continue;
        }
        const id = text.match(/\b(\d{5,})\b/)?.[1] || "";
        const slice = text.slice(0, 64);
        if (id || slice) keys.push(id ? id + "|" + slice : slice);
      }
      return JSON.stringify(keys);
    };
    const listLoading = () => [...doc.querySelectorAll('[aria-busy="true"],[class*="spin-spinning"],[class*="loading-mask"]')].some(visible);
    const waitListStable = async () => {
      let last = pageRowSignature();
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        if (listLoading()) { last = ""; continue; }
        const next = pageRowSignature();
        if (next && next === last) return next;
        last = next;
      }
      return pageRowSignature();
    };
    const picked = pickPreferred();
    if (!picked) throw Error('未找到稳定排序列；已见表头：'+seen+'；已见可点击：'+clickableSeen);
    const column = picked.matchedLabel;
    const refetch = () => find(column, matchesExact) || find(column, matchesPreferred);
    let active = direction(refetch()?.header);
    if (active) return {success:true,column,direction:active};
    const beforeSig = pageRowSignature();
    let clicks = 0;
    let signatureChanged = false;
    let afterSig = beforeSig;
    for (let click = 0; click < 2; click++) {
      const candidate = refetch();
      if (!candidate) break;
      candidate.control.click();
      clicks += 1;
      afterSig = await waitListStable();
      if (afterSig && beforeSig && afterSig !== beforeSig) signatureChanged = true;
      active = direction(refetch()?.header);
      if (active) return {success:true,column,direction:active,clicks,signatureChanged};
      // No aria-sort/class: row order change means the sticky sort click took effect.
      if (signatureChanged) return {success:true,column,direction:'reordered',clicks,signatureChanged};
    }
    throw Error('流量页稳定排序未生效：'+column+'；点击'+clicks+'次；签名'+(signatureChanged?'已变':'未变')+'；已见表头：'+seen+'；已见可点击：'+clickableSeen);
  }

  const PARTITION_SPECS = [
    {key:"enabled", label:"加速中", match:/^(?:流量(?:加速器)?|加速器)?(?:加速中|已开启|已开通)$/},
    {key:"eligible", label:"待开启", match:/^(?:流量(?:加速器)?|加速器)?(?:待开启|未开启|待开通|未开通)$/},
    {key:"disabled", label:"已关闭", match:/^(?:流量(?:加速器)?|加速器)?(?:已关闭|已关停|已停用)$/},
    {key:"max", label:"Max", match:/^(?:流量(?:加速器)?|加速器)?(?:Max(?:模式)?(?:待开启|未开启)?|最大化模式)$/i}
  ];
  function partitionCandidates(doc) {
    // Never treat a product's status/enable button or an overlay as a list
    // filter. Text spans only qualify through their native filter/tab wrapper.
    return [...new Set([...doc.querySelectorAll(
      '[role="tab"],[data-testid*="tab" i],button,[role="button"],[role="radio"],label,[class*="tag" i],[class*="chip" i],[class*="filter" i],[class*="TAB_"]'
    )].filter(visible).filter(element=>!element.closest('tr,td,th,[role="row"],[role="cell"],[role="gridcell"],[role="dialog"],[role="menu"],[role="listbox"]'))
      .map(element=>element.closest('button,[role="tab"],[role="radio"],[role="button"],label') || element))];
  }
  function partitionLabel(element) {
    return clean(element.innerText || element.textContent || element.getAttribute("aria-label") || element.getAttribute("title"));
  }
  function partitionActive(element) {
    const spec=partitionSpec(partitionLabel(element));
    if (!spec) return false;
    for(let current=element;current;current=current.parentElement){
      // Beast puts activity on a wrapper around the label/count. Compare the
      // partition identity, but never inherit a group or another tab's state.
      if (current!==element) {
        const label=partitionLabel(current);
        if (/^(?:tablist|radiogroup|group|navigation)$/.test(current.getAttribute("role") || "") ||
            label && partitionSpec(label)?.key!==spec.key) break;
      }
      const states=["aria-selected","aria-checked","aria-pressed"].map(name=>clean(current.getAttribute(name)).toLowerCase());
      const ariaCurrent=clean(current.getAttribute("aria-current")).toLowerCase();
      const state=clean(current.getAttribute("data-state")).toLowerCase();
      // Split CSS-module camel case as well as token separators, so
      // TAB_filterOptionActive__hash works without matching Unselected.
      const classes=String(current.className || "").replace(/([a-z\d])([A-Z])/g,"$1-$2").toLowerCase();
      if (states.includes("false") || ariaCurrent==="false" || /^(?:inactive|unselected|unchecked|off|false)$/.test(state) ||
          /(?:^|[\s_-])(?:inactive|unselected|unchecked|(?:not|non)[_-](?:active|selected|checked))(?=$|[\s_-])/.test(classes)) return false;
      // Native flux quick filters have no aria state or active class. Their
      // selected card renders a dedicated check icon (Cn/isClick in the seller
      // page). Scope it to this card: a sibling/group/product icon is not proof.
      if (current.matches?.('[class*="quick-overdue-filter_card__"]')) {
        return [...current.querySelectorAll('[class*="quick-overdue-filter_clickIcon__"]')]
          .some(icon=>visible(icon) && icon.closest('[class*="quick-overdue-filter_card__"]')===current);
      }
      const input=current.querySelector?.('input[type="radio"],input[type="checkbox"]');
      if (input && typeof input.checked==="boolean") return input.checked;
      if (typeof current.checked==="boolean" && /^(?:radio|checkbox)$/i.test(current.type || current.getAttribute("type") || "")) return current.checked;
      if (states.includes("true") || /^(?:true|page|step|location|date|time)$/.test(ariaCurrent) ||
          /^(?:active|checked|selected|on)$/.test(state) || current.checked===true ||
          /(?:^|[\s_-])(?:active|selected|checked)(?=$|[\s_-])/.test(classes)) return true;
    }
    return false;
  }
  function partitionName(label) {
    // Counts may precede or follow 商品; normalize full-width counts/parentheses
    // too. Keep matching the whole remaining name to reject actions and groups.
    return clean(label).normalize("NFKC").replace(/[\s\u200b-\u200d]/g, "")
      .replace(/的?商品$/, "")
      .replace(/(?:\([\d,]+\+?(?:条|件|个|商品)?\)|[\d,]+\+?(?:条|件|个)?)$/, "")
      .replace(/的?商品$/, "")
      .replace(/[()]/g, "");
  }
  function partitionSpec(label) {
    const name=partitionName(label);
    return PARTITION_SPECS.find(spec=>spec.match.test(name));
  }
  function partitionMatches(nodes,spec) {
    const matches=nodes.filter(element=>spec.match.test(partitionName(partitionLabel(element))));
    // Native tabs often expose both an outer wrapper and a nested label.
    return matches.filter(element=>!matches.some(other=>other!==element && element.contains(other)));
  }
  function listAcceleratorPartitions(doc = document) {
    const nodes = partitionCandidates(doc);
    const seen = [...new Set(nodes.map(partitionLabel).filter(text => text && text.length <= 40))].slice(0, 40);
    const partitions = [];
    for (const spec of PARTITION_SPECS) {
      const matches=partitionMatches(nodes,spec), hit=matches[0];
      if (!hit) continue;
      partitions.push({key:spec.key, label:partitionLabel(hit) || spec.label, active:matches.length===1 && partitionActive(hit)});
    }
    return {success:true, partitions, seen};
  }
  async function selectAcceleratorPartition(doc = document, target = "") {
    const want = clean(target);
    if (!want) throw Error("加速器分区目标无效");
    const listed = listAcceleratorPartitions(doc);
    const spec = PARTITION_SPECS.find(item=>item.key===want) || partitionSpec(want);
    const matches = spec ? partitionMatches(partitionCandidates(doc),spec) : [];
    const seen=listed.seen.join("、") || "无";
    if (!matches.length) {
      throw Error("未找到加速器分区「"+want+"」；已见筛选项："+seen);
    }
    if (matches.length!==1) throw Error("未唯一识别到加速器分区「"+want+"」；已见筛选项："+seen);
    const match=matches[0];
    if (disabled(match)) throw Error("加速器分区「"+want+"」控件不可用；已见筛选项："+seen);
    if (partitionActive(match)) return {success:true,key:spec.key,label:partitionLabel(match)};
    match.click();
    let stable=0,missing=0;
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      // Re-query React's current control; a detached, previously active node is
      // not evidence that this partition was selected.
      const current=partitionMatches(partitionCandidates(doc),spec);
      // A brief React remount (up to two polls) does not invalidate confirmed
      // activity. Any observed inactive/ambiguous/disabled control does.
      if (!current.length) {
        if (++missing>2) stable=0;
        continue;
      }
      missing=0;
      // Loading/rate-limit recovery belongs to the crawl's stable-page reader.
      if (current.length===1 && !disabled(current[0]) && partitionActive(current[0])) {
        if (++stable>=3) return {success:true,key:spec.key,label:partitionLabel(current[0])};
      } else stable=0;
    }
    const seenAfter=[...new Set([...listAcceleratorPartitions(doc).seen,...listed.seen])];
    throw Error("加速器分区「"+want+"」选择未生效；已见筛选项："+(seenAfter.join("、") || "无"));
  }
  if (typeof module !== "undefined" && module.exports) { module.exports = {parse,readPage,nextPage,goToPage,setPageSize,ensureStickySort,listAcceleratorPartitions,selectAcceleratorPartition}; return; }
  window.TemuAcceleratorEvidence = {readPage:()=>readPage(document,location.origin+location.pathname),nextPage:()=>nextPage(document),goToPage:n=>goToPage(document,n),setPageSize:(size=100)=>setPageSize(document,size),ensureStickySort:()=>ensureStickySort(document),listAcceleratorPartitions:()=>listAcceleratorPartitions(document),selectAcceleratorPartition:target=>selectAcceleratorPartition(document,target)};
  // Complete catalog queries now own status observations. Passive DOM labels
  // can omit an explicit not-enabled label and must not overwrite a freshly
  // confirmed native switch state with unknown after a normal page refresh.
  window.__workbenchProductStateEvidence = true;
})();
