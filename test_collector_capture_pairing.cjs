const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync('./browser_extension/service-worker.js', 'utf8');

function harness() {
  const listeners = {};
  let now = 1000;
  const chrome = {
    runtime:{onInstalled:{addListener() {}},onMessage:{addListener(fn) {listeners.message = fn;}}},
    tabs:{onUpdated:{addListener(fn) {listeners.update = fn;}},onRemoved:{addListener(fn) {listeners.remove = fn;}}},
    webRequest:{onBeforeRequest:{addListener(fn) {listeners.body = fn;}},onBeforeSendHeaders:{addListener(fn) {listeners.headers = fn;}}}
  };
  const context = {chrome,TextDecoder,Date:{now:() => now},Map,Set};
  vm.createContext(context);
  vm.runInContext(source, context);
  const url = kind => 'https://agentseller-us.temu.com/api/flow/analysis/' + (kind === 'flow_trend' ? 'trend' : 'overview');
  const body = (id, payload, tabId = 1, kind = 'flow') => listeners.body({
    requestId:id,tabId,url:url(kind),requestBody:{raw:[{bytes:new TextEncoder().encode(JSON.stringify(payload)).buffer}]}
  });
  const headers = (id, mall = '123', tabId = 1, kind = 'flow') => listeners.headers({
    requestId:id,tabId,url:url(kind),requestHeaders:[{name:'mallid',value:mall},{name:'cookie',value:'excluded'}]
  });
  const send = (kind = 'flow', tabId = 1, senderTab = tabId, type = 'GET_CAPTURED_HEADERS') => {
    let result;
    listeners.message({type,tabId,kind},{tab:{id:senderTab}},value => {result = value;});
    return result;
  };
  return {body,headers,send,listeners,advance:ms => {now += ms;},context};
}

test('interleaved same-kind requests preserve each request body with its own headers', () => {
  const h = harness();
  h.body('A',{timeDimension:0,siteId:'A'});
  h.body('B',{timeDimension:4,siteId:'B'});
  h.headers('A','111');
  const first = h.send();
  assert.equal(first.requestId,'A');
  assert.equal(first.payload.siteId,'A');
  assert.equal(first.headers.mallid,'111');
  h.headers('B','222');
  const second = h.send();
  assert.equal(second.requestId,'B');
  assert.equal(second.payload.siteId,'B');
  assert.equal(second.headers.mallid,'222');
});

test('late headers from an older request cannot replace newer complete native evidence', () => {
  const h = harness();
  h.body('old',{timeDimension:1});
  h.body('new',{timeDimension:0});
  h.headers('new');
  h.headers('old');
  assert.equal(h.send().requestId,'new');
  assert.equal(h.send().payload.timeDimension,0);
});

test('request start time survives delayed header capture and cannot cross a refresh boundary', () => {
  const h = harness();
  h.body('old',{timeDimension:0});
  h.advance(5000);
  h.headers('old');
  const capture = h.send();
  assert.equal(capture.requestStartedAt,1000);
  assert.equal(capture.capturedAt,6000);
});

test('same request ids remain isolated by tab and endpoint kind, and sender tab wins', () => {
  const h = harness();
  h.body('same',{siteId:'overview'});h.headers('same','111');
  h.body('same',{siteId:'trend'},1,'flow_trend');h.headers('same','111',1,'flow_trend');
  h.body('same',{siteId:'other-tab'},2);h.headers('same','222',2);
  assert.equal(h.send().payload.siteId,'overview');
  assert.equal(h.send('flow_trend').payload.siteId,'trend');
  assert.equal(h.send('flow',2).payload.siteId,'other-tab');
  assert.equal(h.send('flow',2,1).payload.siteId,'overview');
});

test('navigation and explicit clear discard pending bodies as well as published captures', () => {
  for (const clear of [h => h.listeners.update(1,{status:'loading'}),h => h.listeners.remove(1),h => h.send('flow',1,1,'CLEAR_CAPTURED_REQUEST')]) {
    const h = harness();h.body('stale',{siteId:'stale'});clear(h);h.headers('stale');
    assert.equal(h.send().payload,null);
    assert.equal(h.send().requestStartedAt,undefined);
  }
});

test('TTL expires pending bodies and published captures without borrowing an old body', () => {
  const h = harness();h.body('pending',{siteId:'expired'});h.advance(120001);h.headers('pending');
  assert.equal(h.send().payload,null);
  assert.equal(h.send().requestStartedAt,undefined);
  h.body('complete',{siteId:'fresh'});h.headers('complete');h.advance(120001);
  assert.equal(h.send().headers.mallid,undefined);
  assert.equal(vm.runInContext('capturedRequests.size + pendingCapturedRequests.size',h.context),0);
});

test('header-only captures still work for existing consumers and never invent body evidence', () => {
  const h = harness();h.headers('headers-only');
  assert.equal(h.send().headers.mallid,'123');
  assert.equal(h.send().headers.cookie,undefined);
  assert.equal(h.send().payload,null);
  assert.equal(h.send().requestStartedAt,undefined);
});

test('all raw JSON body chunks are decoded together', () => {
  const h = harness();
  const encoded = new TextEncoder().encode(JSON.stringify({siteId:'US',label:'美国'}));
  const split = encoded.indexOf(0xe7) + 1;
  h.listeners.body({requestId:'chunks',tabId:1,url:'https://agentseller-us.temu.com/api/flow/analysis/overview',
    requestBody:{raw:[{bytes:encoded.slice(0,split).buffer},{bytes:encoded.slice(split).buffer}]}});
  h.headers('chunks');
  assert.equal(h.send().payload.label,'美国');
});
