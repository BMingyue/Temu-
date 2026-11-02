/* oxlint-disable typescript/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('./local_tools/dxm-uploader/_internal/playwright/driver/package');
const evidence = path.join(__dirname, 'data/verification/20261103-image-browser-access-ui');
fs.mkdirSync(evidence, { recursive: true });
const originals = [
  { id: 'login-a', label: 'Chrome-A', worker_id: 'worker-login' },
  { id: 'quota-1', label: 'Chrome 生图-1', worker_id: 'worker-quota', managed: true, extension_auto_load: true },
  { id: 'offline-2', label: 'Chrome 生图-2', worker_id: 'worker-offline', managed: true, extension_auto_load: true },
  { id: 'unavailable', label: '不可用配置', available: false, unavailable_reason: '测试环境未安装该浏览器' },
].map((profile) => ({ browser: 'chrome', available: true, include_in_all: true, extension_version: '0.4.9', ...profile }));
let profiles = [...originals];
const workers = [
  { worker_id: 'worker-login', online: true, status: '等待登录', message: '请先登录当前 GPT 账号' },
  { worker_id: 'worker-quota', online: true, status: '已连接', account: { blocked: true, until: 1793664000 } },
  { worker_id: 'worker-offline', online: false, status: '未连接', offline_reason: '浏览器已关闭' },
].map((worker) => ({ browser: 'chrome', version: '0.4.9', ...worker }));
const result = { at: new Date().toISOString(), mode: 'isolated headless; every POST mocked or blocked', checks: [], requests: [], unexpected_writes: [], page_errors: [] };
(async () => {
  const browser = await chromium.launch({ executablePath: path.join(__dirname, 'runtime/gpt-chrome/chrome-win64/chrome.exe'), headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, locale: 'zh-CN' });
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => result.page_errors.push(error.message));
  await page.route('**/api/**', async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() === 'GET') {
      if (url.pathname === '/api/gpt-extension') return route.fulfill({ json: { workers, browser_profiles: profiles, browser_creation: { available: true, max_per_request: 20 } } });
      if (url.pathname === '/api/image-jobs') return route.fulfill({ json: { jobs: [], summary: { total_jobs: 0 } } });
      return route.continue();
    }
    const body = request.postDataJSON();
    result.requests.push({ path: url.pathname, body, header: request.headers()['x-workbench'] });
    if (url.pathname === '/api/gpt-browser-profiles/open') return route.fulfill({ json: { ok: true, message: body.profile_id + ' 模拟打开成功' } });
    if (url.pathname === '/api/gpt-browser-profiles/create') {
      const created = Array.from({ length: body.count }, (_, index) => ({ ...originals[2], id: 'new-' + index, label: body.label_prefix + '-' + (index + 1) }));
      profiles = [...profiles, ...created];
      return route.fulfill({ json: { ok: true, created, browser_profiles: profiles } });
    }
    result.unexpected_writes.push({ path: url.pathname, body });
    return route.abort('blockedbyclient');
  });
  try {
    await page.goto('http://127.0.0.1:5173/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.locator('.connection.connected').waitFor();
    const modes = page.getByRole('group', { name: '工作模式', exact: true });
    await modes.getByRole('button', { name: '普通模式', exact: true }).click();
    await page.getByRole('button', { name: '上新', exact: true }).click();
    await page.getByRole('button', { name: 'GPT 批量生图', exact: true }).click();
    const panel = page.getByRole('region', { name: '生图浏览器管理', exact: true });
    await panel.getByRole('heading', { name: '独立 Chrome 生图浏览器', exact: true }).waitFor();
    assert.equal(await modes.getByRole('button', { name: '普通模式', exact: true }).getAttribute('aria-pressed'), 'true');
    assert(await panel.getByLabel('窗口名称前缀', { exact: true }).isVisible());
    assert(await panel.getByLabel('新增浏览器数量', { exact: true }).isVisible());
    assert(await panel.getByRole('button', { name: '新增并打开 Chrome', exact: true }).isVisible());
    result.checks.push('普通模式保留完整独立Chrome面板与窗口名称/数量/新增入口');
    assert(await panel.getByText('等待登录', { exact: true }).isVisible());
    assert(await panel.getByText('请先登录当前 GPT 账号', { exact: true }).isVisible());
    assert(await panel.getByText('额度停发', { exact: true }).isVisible());
    assert(await panel.getByText(/最早 .* 恢复/).isVisible());
    const offline = panel.locator('article').filter({ hasText: 'Chrome 生图-2' });
    assert(await offline.getByText('未连接', { exact: true }).isVisible());
    assert(await panel.getByRole('button', { name: '打开 不可用配置', exact: true }).isDisabled());
    for (const profile of originals.slice(0, 3)) {
      await panel.getByRole('button', { name: '打开 ' + profile.label, exact: true }).click();
      assert.equal(result.requests.at(-1).body.profile_id, profile.id);
    }
    result.checks.push('普通逐卡登录/额度/离线提示可见，三个可用配置均可单独打开且精确传原profile id');
    await panel.getByRole('button', { name: '打开全部 4 个 Chrome', exact: true }).click();
    assert.equal(result.requests.at(-1).body.profile_id, 'chrome-all');
    result.checks.push('普通模式仍可打开全部已有Chrome');
    await panel.getByLabel('窗口名称前缀', { exact: true }).fill('登录用 Chrome');
    await panel.getByLabel('新增浏览器数量', { exact: true }).fill('2');
    await modes.getByRole('button', { name: '专业模式', exact: true }).click();
    assert.equal(await panel.getByLabel('窗口名称前缀', { exact: true }).inputValue(), '登录用 Chrome');
    await modes.getByRole('button', { name: '普通模式', exact: true }).click();
    assert.equal(await panel.getByLabel('新增浏览器数量', { exact: true }).inputValue(), '2');
    const before = result.requests.length;
    await panel.getByRole('button', { name: '新增并打开 Chrome', exact: true }).click();
    await panel.getByRole('button', { name: '打开 登录用 Chrome-2', exact: true }).waitFor();
    await panel.getByText('new-1 模拟打开成功', { exact: false }).waitFor();
    assert.deepEqual(result.requests.slice(before).map((request) => request.path), ['/api/gpt-browser-profiles/create', '/api/gpt-browser-profiles/open', '/api/gpt-browser-profiles/open']);
    assert.deepEqual(result.requests[before].body, { count: 2, label_prefix: '登录用 Chrome' });
    assert.deepEqual(result.requests.slice(before + 1).map((request) => request.body.profile_id), ['new-0', 'new-1']);
    result.checks.push('跨模式保持窗口参数，普通新增按输入创建并打开每个返回id');
    assert(result.requests.every((request) => request.header === 'local'));
    assert.equal(result.unexpected_writes.length, 0);
    assert.equal(result.page_errors.length, 0);
    await panel.screenshot({ path: path.join(evidence, 'ordinary-full-browser-panel.png') });
    result.passed = true;
  } catch (error) {
    result.passed = false; result.error = error.stack;
    await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
    throw error;
  } finally {
    fs.writeFileSync(path.join(evidence, 'verification.json'), JSON.stringify(result, null, 2));
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
