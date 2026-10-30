const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const source = fs.readFileSync(path.join(__dirname, 'local_tools/qualification/temu-local-uploader.js'), 'utf8');
const fragment = source.slice(source.indexOf('function findChrome() {'), source.indexOf('\nfunction verifyEnvironment()'));
function resolveBrowser(dirname, exists, env = {}) {
  return vm.runInNewContext(fragment+'\nfindChrome();', {
    __dirname: dirname, path, process: {env}, fs: {existsSync: p => exists.has(p)},
  });
}

test('a new colleague computer needs no installed Chrome', () => {
  const dirname = path.resolve('D:/新同事 工作台/local_tools/qualification');
  const bundled = path.resolve(dirname, '../../runtime/gpt-chrome/chrome-win64/chrome.exe');
  assert.equal(resolveBrowser(dirname, new Set([bundled])), bundled);
});

test('the bundled browser is preferred when regular Chrome also exists', () => {
  const dirname = path.resolve('C:/Tools/Workbench/local_tools/qualification');
  const bundled = path.resolve(dirname, '../../runtime/gpt-chrome/chrome-win64/chrome.exe');
  const installed = path.join('C:/Programs', 'Google/Chrome/Application/chrome.exe');
  assert.equal(resolveBrowser(dirname, new Set([bundled, installed]), {PROGRAMFILES:'C:/Programs'}), bundled);
});

test('standalone tool retains installed Chrome compatibility', () => {
  const dirname = path.resolve('C:/Tools/qualification');
  const installed = path.join('C:/Local', 'Google/Chrome/Application/chrome.exe');
  assert.equal(resolveBrowser(dirname, new Set([installed]), {LOCALAPPDATA:'C:/Local'}), installed);
});

test('no browser is reported missing without trying to install or launch anything', () => {
  assert.equal(resolveBrowser(path.resolve('C:/Tools/qualification'), new Set()), '');
});
