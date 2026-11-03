// Render the real component with synthetic state; no server, browser or business API.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const source = fs.readFileSync(path.join(__dirname, 'app/image-runner.tsx'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function render(running, online) {
  const state = {
    browser_creation: { available: true },
    browser_profiles: [{ id: 'chrome-synthetic', label: 'Synthetic profile', browser: 'chrome',
      worker_id: 'synthetic-worker', available: true, managed: true, include_in_all: true, running }],
    workers: [{ browser: 'chrome', worker_id: 'synthetic-worker', online,
      status: '执行中', message: 'fresh-heartbeat-ready', metrics: {} }],
  };
  let calls = 0;
  const exports = {};
  const context = { exports, require(name) {
    if (name === 'react') return { ...React, useEffect() {}, useState(initial) {
      return [calls++ === 0 ? state : initial, () => {}];
    } };
    if (name === '@/components/ui/button') return { Button({ variant, size, ...props }) {
      return React.createElement('button', props);
    } };
    if (name === '@/components/ui/input') return { Input: props => React.createElement('input', props) };
    return require(name);
  } };
  vm.runInNewContext(compiled, context, { filename: 'image-runner.compiled.cjs' });
  const html = renderToStaticMarkup(exports.default());
  return { html, text: html.replace(/<[^>]*>/g, ''), cards: (html.match(/<article\b/g) || []).length };
}

const freshUnknown = render(null, true);
assert.equal(freshUnknown.cards, 1);
assert.match(freshUnknown.text, /1 个已连接/);
assert.match(freshUnknown.text, /fresh-heartbeat-ready/);
assert.match(freshUnknown.text, /执行中/);
assert.doesNotMatch(freshUnknown.text, /显示已关闭窗口/);

const offlineUnknown = render(null, false);
assert.equal(offlineUnknown.cards, 1);
assert.match(offlineUnknown.text, /状态待确认/);
assert.doesNotMatch(offlineUnknown.text, /显示已关闭窗口/);

const absent = render(false, true);
assert.equal(absent.cards, 0);
assert.match(absent.text, /0 个已连接/);
assert.match(absent.text, /显示已关闭窗口（1）/);

const present = render(true, true);
assert.equal(present.cards, 1);
assert.match(present.text, /fresh-heartbeat-ready/);
assert.doesNotMatch(present.html, /aria-label="关闭 Synthetic profile"[^>]*disabled/);
console.log('Unknown/known process states and fresh worker heartbeat render correctly: 4 cases passed');
