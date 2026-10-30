// 视图元素
const loginView = document.getElementById('loginView');
const registerView = document.getElementById('registerView');
const mainView = document.getElementById('mainView');

// 登录表单元素
const loginForm = document.getElementById('loginForm');
const loginAccountInput = document.getElementById('loginAccount');
const loginPasswordInput = document.getElementById('loginPassword');
const loginError = document.getElementById('loginError');
const showRegisterBtn = document.getElementById('showRegisterBtn');

// 注册表单元素
const registerForm = document.getElementById('registerForm');
const registerAccountInput = document.getElementById('registerAccount');
const registerPasswordInput = document.getElementById('registerPassword');
const registerNameInput = document.getElementById('registerName');
const registerError = document.getElementById('registerError');
const showLoginBtn = document.getElementById('showLoginBtn');

// 主界面元素
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const exportBtn = document.getElementById('exportBtn');
const logoutBtn = document.getElementById('logoutBtn');
const statusEl = document.getElementById('status');
const collectedEl = document.getElementById('collected');
const userAccountEl = document.getElementById('userAccount');
const pageCountInput = document.getElementById('pageCount');
const pageDelayInput = document.getElementById('pageDelay');
const minSalesInput = document.getElementById('minSales');
const maxSalesInput = document.getElementById('maxSales');

// 视图切换函数
function showView(viewName) {
  loginView.style.display = 'none';
  registerView.style.display = 'none';
  mainView.style.display = 'none';

  if (viewName === 'login') {
    loginView.style.display = 'block';
  } else if (viewName === 'register') {
    registerView.style.display = 'block';
  } else if (viewName === 'main') {
    mainView.style.display = 'block';
  }
}

// 页面加载时检查登录状态
(async function checkAuth() {
  const loginStatus = await checkLoginStatus();

  if (!loginStatus.isLoggedIn) {
    // 未登录，显示登录界面
    showView('login');
    return;
  }

  // 已登录，显示主界面
  showView('main');
  userAccountEl.textContent = loginStatus.account;

  // 显示过期时间
  const expireDate = new Date(loginStatus.expireTime);
  console.log('账号到期时间:', expireDate.toLocaleString());
})();

// 登录表单提交
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const account = loginAccountInput.value.trim();
  const password = loginPasswordInput.value.trim();

  if (!account || !password) {
    loginError.textContent = '请输入账号和密码';
    return;
  }

  const submitBtn = loginForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  submitBtn.textContent = '登录中...';
  loginError.textContent = '';

  const result = await login(account, password);

  if (result.success) {
    // 登录成功，显示主界面
    userAccountEl.textContent = account;
    showView('main');

    // 重置表单
    loginForm.reset();
  } else {
    loginError.textContent = result.message;
    submitBtn.disabled = false;
    submitBtn.textContent = '登录';
  }
});

// 注册表单提交
registerForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const account = registerAccountInput.value.trim();
  const password = registerPasswordInput.value.trim();
  const name = registerNameInput.value.trim();

  if (!account || !password) {
    registerError.textContent = '请输入账号和密码';
    return;
  }

  const submitBtn = registerForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  submitBtn.textContent = '注册中...';
  registerError.textContent = '';

  const result = await register(account, password, name);

  if (result.success) {
    alert('注册成功！请联系管理员开通后登录。');
    registerForm.reset();
    showView('login');
  } else {
    registerError.textContent = result.message;
    submitBtn.disabled = false;
    submitBtn.textContent = '注册';
  }
});

// 切换到注册视图
showRegisterBtn.addEventListener('click', (e) => {
  e.preventDefault();
  showView('register');
});

// 切换到登录视图
showLoginBtn.addEventListener('click', (e) => {
  e.preventDefault();
  showView('login');
});

// 加载保存的设置
chrome.storage.local.get(['settings'], (result) => {
  if (result.settings) {
    pageCountInput.value = result.settings.pageCount || 5;
    pageDelayInput.value = result.settings.pageDelay || 3;
    minSalesInput.value = result.settings.minSales || 0;
    maxSalesInput.value = result.settings.maxSales || 999999;
  }
});

// 保存设置
function saveSettings() {
  const settings = {
    pageCount: parseInt(pageCountInput.value),
    pageDelay: parseInt(pageDelayInput.value),
    minSales: parseInt(minSalesInput.value),
    maxSales: parseInt(maxSalesInput.value)
  };
  chrome.storage.local.set({ settings });
}

// 监听输入变化
[pageCountInput, pageDelayInput, minSalesInput, maxSalesInput].forEach(input => {
  input.addEventListener('change', saveSettings);
});

// 开始采集
startBtn.addEventListener('click', async () => {
  // 再次验证登录状态
  const loginStatus = await revalidateLogin();

  if (!loginStatus.isLoggedIn) {
    // 登录失败，退出登录并显示登录页面
    await logout();
    alert(loginStatus.message || '登录已失效，请重新登录');
    showView('login');
    return;
  }

  saveSettings();
  // TODO: 实现采集逻辑
  chrome.storage.local.set({ currentFetchCount: 0 });
  statusEl.textContent = '采集中...';
  startBtn.disabled = true;
  stopBtn.disabled = false;
  console.log('开始采集');
});

// 停止采集
stopBtn.addEventListener('click', () => {
  // TODO: 实现停止逻辑
  statusEl.textContent = '已停止';
  startBtn.disabled = false;
  stopBtn.disabled = true;
  console.log('停止采集');
});

// 导出数据
exportBtn.addEventListener('click', () => {
  // TODO: 实现导出逻辑
  console.log('导出数据');
});

// 退出登录
logoutBtn.addEventListener('click', async () => {
  if (confirm('确定要退出登录吗？')) {
    await logout();
    showView('login');
  }
});

// ====== 实时进度同步（基于 chrome.storage.local）======

// 监听 storage 变更，实时更新已采集数量
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local' && changes.currentFetchCount) {
    collectedEl.textContent = changes.currentFetchCount.newValue;
  }
});

// 初始化：弹窗打开时读取当前数量，防止重开后归零
chrome.storage.local.get(['currentFetchCount'], (result) => {
  if (result.currentFetchCount !== undefined) {
    collectedEl.textContent = result.currentFetchCount;
  }
});
