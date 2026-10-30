// Read business identifiers from the table's existing data. No request or page action is made.
(function () {
  'use strict';
  if (location.origin !== 'https://agentseller-us.temu.com' || location.pathname !== '/main/flux-analysis' || window.__trafficIdentityReaderV1) return;
  window.__trafficIdentityReaderV1 = true;
  document.addEventListener('traffic-identity-request-v1', event => {
    const requestId = event.detail?.requestId;
    if (typeof requestId !== 'string' || requestId.length > 80) return;
    let records = [], supported = false;
    const row = [...document.querySelectorAll('tr')].find(el => /SPU\s*ID\s*[:：]\s*\d+/i.test(el.textContent || ''));
    const key = row && Object.keys(row).find(name => name.startsWith('__reactFiber$'));
    for (let fiber = key ? row[key] : null, depth = 0; fiber && depth < 40; fiber = fiber.return, depth++) {
      const data = fiber.memoizedProps?.dataSource;
      if (Array.isArray(data) && data.length && data.every(item => item && /^\d+$/.test(String(item.productId)) && /^\d+$/.test(String(item.goodsId)))) {
        records = data.map(item => ({id:String(item.productId), goodsId:String(item.goodsId)})); supported = true; break;
      }
    }
    document.dispatchEvent(new CustomEvent('traffic-identity-response-v1', {detail:{requestId, supported, records}}));
  });
})();
