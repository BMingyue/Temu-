const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync('./browser_extension/service-worker.js','utf8');
const overview = 'https://agentseller-us.temu.com/api/flow/analysis/overview';
function harness() {
  const listeners = {};
  let now = 1000;
  const chrome = {
    runtime:{onInstalled:{addListener() {}},onMessage:{addListener(fn) {listeners.message = fn;}}},
    tabs:{onUpdated:{addListener(fn) {listeners.update = fn;}},onRemoved:{addListener(fn) {listeners.remove = fn;}}},
    webRequest:{onBeforeRequest:{addListener(fn) {listeners.body = fn;}},onBeforeSendHeaders:{addListener(fn) {listeners.headers = fn;}}}
  };
  vm.runInNewContext(source,{chrome,URL,TextDecoder,Date:{now:()=>now},Map,Set});
  const body = (requestBody,extras = {}) => listeners.body({tabId:1,requestId:'native',method:'POST',url:overview,requestBody,...extras});
  const headers = (extras = {}) => listeners.headers({tabId:1,requestId:'native',method:'POST',url:overview,
    requestHeaders:[{name:'mallid',value:'123'}],...extras});
  const read = () => {
    let result;
    listeners.message({type:'GET_CAPTURED_HEADERS',kind:'flow',tabId:1},{tab:{id:1}},value=>{result=value;});
    return result;
  };
  return {body,headers,read,advance:ms=>{now+=ms;}};
}
const raw = text => ({raw:[{bytes:new TextEncoder().encode(text).buffer}]});

test('wire method and exact origin/path come from headers event and exclude query values',()=>{
  const h = harness();h.body(raw('{"timeDimension":1}'),{url:overview+'?bodySecret=hidden',method:'POST'});
  h.advance(250);
  h.headers({url:overview+'-different?token=private-query',method:'GET'});
  const capture = h.read();
  assert.equal(capture.requestMethod,'GET');
  assert.equal(capture.requestPath,overview+'-different');
  assert.equal(capture.headersCapturedAt,1250);
  assert.equal(capture.requestStartedAt,1000);
  assert.equal(capture.requestBodyDiagnostics.method,'POST');
  assert.equal(JSON.stringify(capture).includes('private-query'),false);
  assert.equal(JSON.stringify(capture).includes('bodySecret'),false);
});

test('header-only capture explicitly reports missing beforeRequest and creates no body evidence',()=>{
  const h = harness();h.headers();const capture = h.read();
  assert.equal(capture.requestMethod,'POST');assert.equal(capture.requestPath,overview);
  assert.equal(capture.requestBodyDiagnostics.hasBeforeRequest,false);
  assert.equal(capture.requestBodyDiagnostics.rawPartCount,0);
  assert.equal(capture.requestBodyDiagnostics.parseError,false);
  assert.equal(capture.payload,null);assert.equal(capture.requestStartedAt,undefined);
});

test('native JSON body diagnostics expose counts and no body contents',()=>{
  const h = harness();const text='{"timeDimension":1,"private":"never-log-this"}';
  h.body(raw(text));h.headers();const capture = h.read(),diagnostics=capture.requestBodyDiagnostics;
  assert.equal(capture.payload.timeDimension,1);
  assert.equal(diagnostics.hasBeforeRequest,true);assert.equal(diagnostics.bodyError,null);
  assert.equal(diagnostics.rawPartCount,1);assert.equal(diagnostics.rawByteTotal,new TextEncoder().encode(text).length);
  assert.equal(diagnostics.parseError,false);
  assert.equal(JSON.stringify(diagnostics).includes('never-log-this'),false);
  assert.deepEqual(Object.keys(diagnostics).sort(),['bodyError','hasBeforeRequest','method','parseError','rawByteTotal','rawPartCount']);
});

test('body acquisition errors use fixed categories and never return raw Chrome error text',()=>{
  for (const [error,expected] of [['Permission denied private-token','access_denied'],['Request body unavailable secret','unavailable'],['Failed to read secret','read_failed'],['unclassified private-token','other']]) {
    const h = harness();h.body({error});h.headers();const diagnostics=h.read().requestBodyDiagnostics;
    assert.equal(diagnostics.hasBeforeRequest,true);assert.equal(diagnostics.bodyError,expected);
    assert.equal(JSON.stringify(diagnostics).includes(error),false);assert.equal(diagnostics.parseError,false);
  }
});

test('invalid JSON reports parse failure without exception snippets or raw body',()=>{
  const h = harness();h.body(raw('invalid-private-body'));h.headers();const capture=h.read();
  assert.equal(capture.payload,null);assert.equal(capture.requestBodyDiagnostics.parseError,true);
  assert.equal(capture.requestBodyDiagnostics.rawPartCount,1);
  assert.equal(JSON.stringify(capture.requestBodyDiagnostics).includes('invalid-private-body'),false);
});

test('request body unavailable differs from beforeRequest never observed',()=>{
  const h = harness();h.body(undefined);h.headers();const capture=h.read();
  assert.equal(capture.requestBodyDiagnostics.hasBeforeRequest,true);
  assert.equal(capture.requestBodyDiagnostics.rawPartCount,0);
  assert.equal(capture.requestBodyDiagnostics.bodyError,null);
  assert.equal(capture.payload,null);assert.equal(capture.requestStartedAt,1000);
});
