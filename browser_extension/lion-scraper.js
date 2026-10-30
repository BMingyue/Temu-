// 清理旧实例（扩展重新加载时，旧的 UI 残留在页面上）
(function cleanupOldInstances() {
  const oldElements = [
    'temu-scraper-float-btn', 'temu-scraper-panel', 'temu-log-window',
    'temu-scraping-overlay', 'temu-preview-window', 'temu-confirm',
    'temu-alert', 'temu-image-modal', 'temu-toast'
  ];
  oldElements.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.remove();
  });
})();

// 显示自定义提示框
function showToast(message, type = 'info', duration = 3000) {
  // 移除已存在的提示框
  const existingToast = document.getElementById('temu-toast');
  if (existingToast) {
    existingToast.remove();
  }
  
  // 创建提示框
  const toast = document.createElement('div');
  toast.id = 'temu-toast';
  toast.className = `temu-toast temu-toast-${type}`;
  toast.textContent = message;
  
  document.body.appendChild(toast);
  
  // 显示动画
  setTimeout(() => {
    toast.classList.add('show');
  }, 10);
  
  // 自动隐藏
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => {
      toast.remove();
    }, 300);
  }, duration);
}

// 显示确认对话框
function showConfirm(message, onConfirm) {
  // 创建确认框
  const confirmBox = document.createElement('div');
  confirmBox.id = 'temu-confirm';
  confirmBox.innerHTML = `
    <div class="temu-confirm-overlay"></div>
    <div class="temu-confirm-box">
      <div class="temu-confirm-message">${message}</div>
      <div class="temu-confirm-buttons">
        <button class="temu-confirm-btn temu-confirm-cancel">取消</button>
        <button class="temu-confirm-btn temu-confirm-ok">确定</button>
      </div>
    </div>
  `;
  
  document.body.appendChild(confirmBox);
  
  // 取消按钮
  confirmBox.querySelector('.temu-confirm-cancel').addEventListener('click', () => {
    confirmBox.remove();
  });
  
  // 确定按钮
  confirmBox.querySelector('.temu-confirm-ok').addEventListener('click', () => {
    confirmBox.remove();
    onConfirm();
  });
  
  // 点击遮罩关闭
  confirmBox.querySelector('.temu-confirm-overlay').addEventListener('click', () => {
    confirmBox.remove();
  });
}

// 显示提示对话框（只有确定按钮）
function showAlert(message) {
  const alertBox = document.createElement('div');
  alertBox.id = 'temu-alert';
  alertBox.innerHTML = `
    <div class="temu-confirm-overlay"></div>
    <div class="temu-confirm-box">
      <div class="temu-confirm-message">${message}</div>
      <div class="temu-confirm-buttons">
        <button class="temu-confirm-btn temu-confirm-ok">确定</button>
      </div>
    </div>
  `;
  
  document.body.appendChild(alertBox);
  
  // 确定按钮
  alertBox.querySelector('.temu-confirm-ok').addEventListener('click', () => {
    alertBox.remove();
  });
  
  // 点击遮罩关闭
  alertBox.querySelector('.temu-confirm-overlay').addEventListener('click', () => {
    alertBox.remove();
  });
}

// 显示日志窗口
function showLogWindow() {
  // 如果已存在，直接返回
  if (document.getElementById('temu-log-window')) {
    return;
  }

  const logWindow = document.createElement('div');
  logWindow.id = 'temu-log-window';
  logWindow.innerHTML = `
    <div class="temu-log-header">
      <div class="temu-log-title">📋 执行日志</div>
      <button class="temu-log-close">×</button>
    </div>
    <div class="temu-log-body" id="temu-log-content"></div>
  `;

  document.body.appendChild(logWindow);

  // 加载保存的位置
  chrome.storage.local.get(['logWindowPosition'], (result) => {
    if (result.logWindowPosition) {
      logWindow.style.left = result.logWindowPosition.left;
      logWindow.style.top = result.logWindowPosition.top;
      logWindow.style.right = 'auto';
      logWindow.style.bottom = 'auto';
    }
  });

  // 关闭按钮
  logWindow.querySelector('.temu-log-close').addEventListener('click', () => {
    logWindow.remove();
  });

  // 拖拽功能
  let isDragging = false;
  let startX, startY, startLeft, startTop;
  const header = logWindow.querySelector('.temu-log-header');

  header.addEventListener('mousedown', (e) => {
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    const rect = logWindow.getBoundingClientRect();
    startLeft = rect.left;
    startTop = rect.top;
    header.style.cursor = 'grabbing';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const deltaX = e.clientX - startX;
    const deltaY = e.clientY - startY;
    const newLeft = startLeft + deltaX;
    const newTop = startTop + deltaY;
    logWindow.style.left = newLeft + 'px';
    logWindow.style.top = newTop + 'px';
    logWindow.style.right = 'auto';
    logWindow.style.bottom = 'auto';
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      header.style.cursor = 'grab';
      // 保存位置
      const rect = logWindow.getBoundingClientRect();
      chrome.storage.local.set({
        logWindowPosition: {
          left: rect.left + 'px',
          top: rect.top + 'px'
        }
      });
    }
  });

  // 监听窗口大小变化，确保日志窗口始终在可见范围内
  window.addEventListener('resize', () => {
    constrainLogWindowPosition(logWindow);
  });

  // 初始化时也检查一次位置
  setTimeout(() => {
    constrainLogWindowPosition(logWindow);
  }, 100);
}

// 确保日志窗口在可见范围内
function constrainLogWindowPosition(logWindow) {
  const rect = logWindow.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  let newLeft = rect.left;
  let newTop = rect.top;
  let needsUpdate = false;

  // 检查右边界
  if (rect.right > viewportWidth) {
    newLeft = viewportWidth - rect.width - 10;
    needsUpdate = true;
  }

  // 检查左边界
  if (rect.left < 0) {
    newLeft = 10;
    needsUpdate = true;
  }

  // 检查底边界
  if (rect.bottom > viewportHeight) {
    newTop = viewportHeight - rect.height - 10;
    needsUpdate = true;
  }

  // 检查顶边界
  if (rect.top < 0) {
    newTop = 10;
    needsUpdate = true;
  }

  // 如果需要更新位置
  if (needsUpdate) {
    logWindow.style.left = newLeft + 'px';
    logWindow.style.top = newTop + 'px';
    logWindow.style.right = 'auto';
    logWindow.style.bottom = 'auto';

    // 保存新位置
    chrome.storage.local.set({
      logWindowPosition: {
        left: newLeft + 'px',
        top: newTop + 'px'
      }
    });
  }
}

// 隐藏日志窗口
function hideLogWindow() {
  const logWindow = document.getElementById('temu-log-window');
  if (logWindow) {
    logWindow.remove();
  }
}

// 添加日志
function addLog(message, type = 'info') {
  const logContent = document.getElementById('temu-log-content');
  if (!logContent) return;
  
  const logItem = document.createElement('div');
  logItem.className = `temu-log-item temu-log-${type}`;
  
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  logItem.innerHTML = `<span class="temu-log-time">[${time}]</span> ${message}`;
  
  logContent.appendChild(logItem);
  
  // 仅当用户已在底部附近时才自动滚动
  const isNearBottom = logContent.scrollHeight - logContent.scrollTop - logContent.clientHeight < 60;
  if (isNearBottom) {
    logContent.scrollTop = logContent.scrollHeight;
  }
}

// 清空日志
function clearLog() {
  const logContent = document.getElementById('temu-log-content');
  if (logContent) {
    logContent.innerHTML = '';
  }
}

// 创建悬浮球
function createFloatButton() {
  const floatBtn = document.createElement('div');
  floatBtn.id = 'temu-scraper-float-btn';

  // 添加图标图片
  const icon = document.createElement('img');
  icon.src = chrome.runtime.getURL('lion-icon.png');
  icon.style.width = '40px';
  icon.style.height = '40px';
  icon.style.objectFit = 'contain';
  floatBtn.appendChild(icon);

  document.body.appendChild(floatBtn);

  // 加载保存的位置
  chrome.storage.local.get(['floatBtnPosition'], (result) => {
    if (result.floatBtnPosition) {
      floatBtn.style.left = result.floatBtnPosition.left;
      floatBtn.style.top = result.floatBtnPosition.top;
      floatBtn.style.right = 'auto';
      floatBtn.style.bottom = 'auto';
    }
  });

  // 点击悬浮球显示面板
  floatBtn.addEventListener('click', () => {
    showPanel();
  });

  // 拖拽功能
  let isDragging = false;
  let startX, startY, startLeft, startTop;

  floatBtn.addEventListener('mousedown', (e) => {
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    const rect = floatBtn.getBoundingClientRect();
    startLeft = rect.left;
    startTop = rect.top;
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const deltaX = e.clientX - startX;
    const deltaY = e.clientY - startY;
    const newLeft = startLeft + deltaX;
    const newTop = startTop + deltaY;
    floatBtn.style.left = newLeft + 'px';
    floatBtn.style.top = newTop + 'px';
    floatBtn.style.right = 'auto';
    floatBtn.style.bottom = 'auto';
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      // 保存位置
      const rect = floatBtn.getBoundingClientRect();
      chrome.storage.local.set({
        floatBtnPosition: {
          left: rect.left + 'px',
          top: rect.top + 'px'
        }
      });
    }
  });

  // 监听窗口大小变化，确保悬浮窗始终在可见范围内
  window.addEventListener('resize', () => {
    constrainFloatButtonPosition(floatBtn);
  });

  // 初始化时也检查一次位置
  setTimeout(() => {
    constrainFloatButtonPosition(floatBtn);
  }, 100);
}

// 确保悬浮窗在可见范围内
function constrainFloatButtonPosition(floatBtn) {
  const rect = floatBtn.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  let newLeft = rect.left;
  let newTop = rect.top;
  let needsUpdate = false;

  // 检查右边界
  if (rect.right > viewportWidth) {
    newLeft = viewportWidth - rect.width - 10;
    needsUpdate = true;
  }

  // 检查左边界
  if (rect.left < 0) {
    newLeft = 10;
    needsUpdate = true;
  }

  // 检查底边界
  if (rect.bottom > viewportHeight) {
    newTop = viewportHeight - rect.height - 10;
    needsUpdate = true;
  }

  // 检查顶边界
  if (rect.top < 0) {
    newTop = 10;
    needsUpdate = true;
  }

  // 如果需要更新位置
  if (needsUpdate) {
    floatBtn.style.left = newLeft + 'px';
    floatBtn.style.top = newTop + 'px';
    floatBtn.style.right = 'auto';
    floatBtn.style.bottom = 'auto';

    // 保存新位置
    chrome.storage.local.set({
      floatBtnPosition: {
        left: newLeft + 'px',
        top: newTop + 'px'
      }
    });
  }
}

// 不同页面的配置
const PAGE_CONFIG = {
  search: {
    name: '搜索商品'
  },
  recommend: {
    name: '为您精选'
  },
  shop: {
    name: '店铺商品'
  },
  explore: {
    name: '探索好物'
  }
};

// 创建功能面板
function createPanel() {
  // 创建面板
  const panel = document.createElement('div');
  panel.id = 'temu-scraper-panel';
  panel.innerHTML = `
    <div class="temu-panel-header">
      <div class="temu-panel-title"><img class="temu-panel-title-icon" src="${chrome.runtime.getURL('lion-icon.png')}" alt="小狮子图标"><span>小狮子获取器 · 工作台买断版</span></div>
      <div class="temu-panel-close">×</div>
    </div>

    <!-- 登录视图 -->
    <div id="panel-login-view" style="display: none;">
      <div class="temu-login-form">
        <h3 class="temu-login-title">账号登录</h3>
        <div class="temu-form-item">
          <label>账号</label>
          <input type="text" id="panel-login-account" placeholder="请输入账号" class="temu-setting-input">
        </div>
        <div class="temu-form-item">
          <label>密码</label>
          <input type="password" id="panel-login-password" placeholder="请输入密码" class="temu-setting-input">
        </div>
        <div class="temu-login-error" id="panel-login-error"></div>
        <button class="temu-btn temu-btn-start" id="panel-login-submit" style="width: 100%; margin-bottom: 10px;">登录</button>
        <button class="temu-btn temu-btn-export" id="panel-register-link" style="width: 100%;">注册账号</button>
      </div>
    </div>

    <!-- 注册视图 -->
    <div id="panel-register-view" style="display: none;">
      <div class="temu-login-form">
        <h3 class="temu-login-title">账号注册</h3>
        <div class="temu-form-item">
          <label>账号</label>
          <input type="text" id="panel-register-account" placeholder="请输入账号" class="temu-setting-input">
        </div>
        <div class="temu-form-item">
          <label>密码</label>
          <input type="password" id="panel-register-password" placeholder="请输入密码" class="temu-setting-input">
        </div>
        <div class="temu-form-item">
          <label>名称（可选）</label>
          <input type="text" id="panel-register-name" placeholder="请输入名称" class="temu-setting-input">
        </div>
        <div class="temu-register-hint">注册成功后需要管理员开通才能使用</div>
        <div class="temu-login-error" id="panel-register-error"></div>
        <button class="temu-btn temu-btn-start" id="panel-register-submit" style="width: 100%; margin-bottom: 10px;">注册</button>
        <button class="temu-btn temu-btn-export" id="panel-back-login" style="width: 100%;">返回登录</button>
      </div>
    </div>

    <!-- 主功能视图 -->
    <div id="panel-main-view" style="display: none;">
      <!-- 登录状态显示 -->
      <div class="temu-user-info">
        <span class="temu-user-account" id="panel-user-account">工作台买断授权</span>
        <button class="temu-btn temu-btn-logout-small" id="panel-logout-btn" style="display:none">退出</button>
      </div>

      <div class="temu-setting-item">
        <label class="temu-setting-label">获取页面</label>
        <div class="temu-radio-group">
          <label class="temu-radio-label">
            <input type="radio" name="pageType" value="search" checked>
            <span class="temu-radio-text">搜索商品</span>
          </label>
          <label class="temu-radio-label">
            <input type="radio" name="pageType" value="recommend">
            <span class="temu-radio-text">为您精选</span>
          </label>
          <label class="temu-radio-label">
            <input type="radio" name="pageType" value="shop">
            <span class="temu-radio-text">店铺商品</span>
          </label>
          <label class="temu-radio-label">
            <input type="radio" name="pageType" value="explore">
            <span class="temu-radio-text">探索好物</span>
          </label>
        </div>
      </div>

      <div class="temu-setting-item">
        <label class="temu-setting-label">翻页次数</label>
        <input type="number" class="temu-setting-input" id="panel-pageCount" min="1" max="100" value="10">
      </div>

      <div class="temu-setting-item">
        <label class="temu-setting-label">翻页延迟 (秒)</label>
        <div class="temu-input-group">
          <input type="number" class="temu-setting-input temu-input-half" id="panel-minDelay" min="1" max="60" value="2" placeholder="最小">
          <span class="temu-input-separator">-</span>
          <input type="number" class="temu-setting-input temu-input-half" id="panel-maxDelay" min="1" max="60" value="5" placeholder="最大">
        </div>
      </div>

      <div class="temu-setting-item">
        <button class="temu-btn temu-btn-export" id="panel-filterBtn" style="width: 100%;">🔍 筛选条件</button>
      </div>

      <div class="temu-setting-item">
        <label class="temu-carousel-toggle" for="panel-carouselMode">
          <input type="checkbox" id="panel-carouselMode">
          <span class="temu-toggle-switch"></span>
          <span class="temu-toggle-text">同时获取轮播图 <span class="temu-toggle-hint"></span></span>
        </label>
      </div>

      <div class="temu-button-group temu-button-row">
        <button class="temu-btn temu-btn-toggle" id="panel-toggleBtn">▶ 开始获取</button>
        <button class="temu-btn temu-btn-preview" id="panel-previewBtn">👁 预览</button>
      </div>

      <div class="temu-button-group temu-button-row">
        <button class="temu-btn temu-btn-clear" id="panel-clearBtn">🗑 清空</button>
        <button class="temu-btn temu-btn-export" id="panel-exportBtn">↓ 导出</button>
      </div>

      <div class="temu-status" id="panel-status">状态: 就绪<br>已获取: 0</div>
    </div>
  `;
  document.body.appendChild(panel);

  // 关闭按钮
  panel.querySelector('.temu-panel-close').addEventListener('click', hidePanel);

  // 点击面板外部关闭
  document.addEventListener('click', (e) => {
    const panel = document.getElementById('temu-scraper-panel');
    const floatBtn = document.getElementById('temu-scraper-float-btn');
    if (panel && panel.classList.contains('show') &&
        !panel.contains(e.target) &&
        !floatBtn.contains(e.target)) {
      hidePanel();
    }
  });

  // 登录表单事件
  setupLoginForm();

  // 注册表单事件
  setupRegisterForm();

  // 主功能按钮事件
  const toggleBtn = panel.querySelector('#panel-toggleBtn');
  const previewBtn = panel.querySelector('#panel-previewBtn');
  const clearBtn = panel.querySelector('#panel-clearBtn');
  const exportBtn = panel.querySelector('#panel-exportBtn');
  const filterBtn = panel.querySelector('#panel-filterBtn');
  const logoutBtn = panel.querySelector('#panel-logout-btn');

  if (toggleBtn) toggleBtn.addEventListener('click', toggleScraping);
  if (previewBtn) previewBtn.addEventListener('click', previewData);
  if (clearBtn) clearBtn.addEventListener('click', clearData);
  if (exportBtn) exportBtn.addEventListener('click', exportData);
  if (filterBtn) filterBtn.addEventListener('click', showFilterDialog);
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      showConfirm('确定要退出登录吗？', async () => {
        await logoutUser();
        switchPanelView('login');
        showToast('已退出登录', 'info');
      });
    });
  }

  // 监听设置变化,自动保存
  const inputs = panel.querySelectorAll('input');
  inputs.forEach(input => {
    input.addEventListener('change', saveSettings);
  });

  // 加载保存的设置
  loadSettings();

  // 检查登录状态并切换视图
  checkAndSwitchView();
}

// 设置登录表单事件
function setupLoginForm() {
  const loginSubmit = document.getElementById('panel-login-submit');
  const registerLink = document.getElementById('panel-register-link');
  const loginPassword = document.getElementById('panel-login-password');

  if (loginSubmit) {
    loginSubmit.addEventListener('click', async () => {
      const account = document.getElementById('panel-login-account').value.trim();
      const password = document.getElementById('panel-login-password').value.trim();
      const errorEl = document.getElementById('panel-login-error');

      if (!account || !password) {
        errorEl.textContent = '请输入账号和密码';
        return;
      }

      loginSubmit.disabled = true;
      loginSubmit.textContent = '登录中...';
      errorEl.textContent = '';

      const result = await loginAPI(account, password);

      if (result.success) {
        showToast('登录成功', 'success');
        switchPanelView('main');
        // 清空输入
        document.getElementById('panel-login-account').value = '';
        document.getElementById('panel-login-password').value = '';
      } else {
        errorEl.textContent = result.message;
        loginSubmit.disabled = false;
        loginSubmit.textContent = '登录';
      }
    });
  }

  if (registerLink) {
    registerLink.addEventListener('click', () => {
      switchPanelView('register');
    });
  }

  // 回车登录
  if (loginPassword) {
    loginPassword.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        loginSubmit.click();
      }
    });
  }
}

// 设置注册表单事件
function setupRegisterForm() {
  const registerSubmit = document.getElementById('panel-register-submit');
  const backLogin = document.getElementById('panel-back-login');

  if (registerSubmit) {
    registerSubmit.addEventListener('click', async () => {
      const account = document.getElementById('panel-register-account').value.trim();
      const password = document.getElementById('panel-register-password').value.trim();
      const name = document.getElementById('panel-register-name').value.trim();
      const errorEl = document.getElementById('panel-register-error');

      if (!account || !password) {
        errorEl.textContent = '请输入账号和密码';
        return;
      }

      registerSubmit.disabled = true;
      registerSubmit.textContent = '注册中...';
      errorEl.textContent = '';

      const result = await registerAPI(account, password, name);

      if (result.success) {
        showToast('注册成功！请联系管理员开通后登录', 'success', 5000);
        // 清空输入
        document.getElementById('panel-register-account').value = '';
        document.getElementById('panel-register-password').value = '';
        document.getElementById('panel-register-name').value = '';
        switchPanelView('login');
      } else {
        errorEl.textContent = result.message;
        registerSubmit.disabled = false;
        registerSubmit.textContent = '注册';
      }
    });
  }

  if (backLogin) {
    backLogin.addEventListener('click', () => {
      switchPanelView('login');
    });
  }
}

// 切换面板视图
function switchPanelView(view) {
  const loginView = document.getElementById('panel-login-view');
  const registerView = document.getElementById('panel-register-view');
  const mainView = document.getElementById('panel-main-view');

  if (!loginView || !registerView || !mainView) return;

  loginView.style.display = 'none';
  registerView.style.display = 'none';
  mainView.style.display = 'none';

  if (view === 'login') {
    loginView.style.display = 'block';
    // 重置登录表单状态
    const loginSubmit = document.getElementById('panel-login-submit');
    const loginError = document.getElementById('panel-login-error');
    if (loginSubmit) {
      loginSubmit.disabled = false;
      loginSubmit.textContent = '登录';
    }
    if (loginError) {
      loginError.textContent = '';
    }
  } else if (view === 'register') {
    registerView.style.display = 'block';
    // 重置注册表单状态
    const registerSubmit = document.getElementById('panel-register-submit');
    const registerError = document.getElementById('panel-register-error');
    if (registerSubmit) {
      registerSubmit.disabled = false;
      registerSubmit.textContent = '注册';
    }
    if (registerError) {
      registerError.textContent = '';
    }
  } else if (view === 'main') {
    mainView.style.display = 'block';
    // 更新用户信息显示
    updateUserDisplay();
  }
}

// 检查登录状态并切换视图
async function checkAndSwitchView() {
  switchPanelView('main');
}

// 更新用户信息显示
async function updateUserDisplay() {
  const userAccountEl = document.getElementById('panel-user-account');
  if (!userAccountEl) return;
  userAccountEl.textContent = '工作台买断授权';
}

// 保存设置
async function saveSettings() {
  const pageTypeRadio = document.querySelector('input[name="pageType"]:checked');
  const settings = {
    pageType: pageTypeRadio ? pageTypeRadio.value : 'search',
    pageCount: parseInt(document.getElementById('panel-pageCount')?.value || 10),
    minDelay: parseInt(document.getElementById('panel-minDelay')?.value || 2),
    maxDelay: parseInt(document.getElementById('panel-maxDelay')?.value || 5),
    minSales: parseInt(document.getElementById('panel-minSales')?.value || 0),
    maxSales: parseInt(document.getElementById('panel-maxSales')?.value || 99999),
    minPrice: parseFloat(document.getElementById('panel-minPrice')?.value || 0),
    maxPrice: parseFloat(document.getElementById('panel-maxPrice')?.value || 99999),
    carouselMode: document.getElementById('panel-carouselMode')?.checked || false
  };

  try {
    await chrome.storage.local.set({ settings: settings });
    console.log('设置已保存:', settings);
  } catch (error) {
    console.error('保存设置失败:', error);
  }
}

// 加载设置
async function loadSettings() {
  try {
    const result = await chrome.storage.local.get(['settings']);
    if (result.settings) {
      const settings = result.settings;
      
      // 恢复页面类型
      const pageTypeRadio = document.querySelector(`input[name="pageType"][value="${settings.pageType}"]`);
      if (pageTypeRadio) {
        pageTypeRadio.checked = true;
      }
      
      // 恢复其他设置
      const pageCountInput = document.getElementById('panel-pageCount');
      if (pageCountInput) pageCountInput.value = settings.pageCount || 10;
      
      const minDelayInput = document.getElementById('panel-minDelay');
      if (minDelayInput) minDelayInput.value = settings.minDelay || 2;
      
      const maxDelayInput = document.getElementById('panel-maxDelay');
      if (maxDelayInput) maxDelayInput.value = settings.maxDelay || 5;
      
      const minSalesInput = document.getElementById('panel-minSales');
      if (minSalesInput) minSalesInput.value = settings.minSales || 0;

      const maxSalesInput = document.getElementById('panel-maxSales');
      if (maxSalesInput) maxSalesInput.value = settings.maxSales || 99999;

      const minPriceInput = document.getElementById('panel-minPrice');
      if (minPriceInput) minPriceInput.value = settings.minPrice || 0;

      const maxPriceInput = document.getElementById('panel-maxPrice');
      if (maxPriceInput) maxPriceInput.value = settings.maxPrice || 99999;

      const carouselCheckbox = document.getElementById('panel-carouselMode');
      if (carouselCheckbox) carouselCheckbox.checked = settings.carouselMode || false;

      console.log('设置已加载:', settings);
    }
  } catch (error) {
    console.error('加载设置失败:', error);
  }
}

// 显示面板
function showPanel() {
  const panel = document.getElementById('temu-scraper-panel');
  const floatBtn = document.getElementById('temu-scraper-float-btn');

  if (panel.classList.contains('show')) {
    hidePanel();
  } else {
    // 根据悬浮球位置调整面板位置
    const btnRect = floatBtn.getBoundingClientRect();
    const panelWidth = 320;
    const panelHeight = 400;

    // 默认显示在悬浮球左侧
    let left = btnRect.left - panelWidth - 20;
    let bottom = window.innerHeight - btnRect.bottom;

    // 如果左侧空间不够，显示在右侧
    if (left < 20) {
      left = btnRect.right + 20;
    }

    // 如果右侧也不够，显示在悬浮球上方
    if (left + panelWidth > window.innerWidth - 20) {
      left = btnRect.left;
      bottom = window.innerHeight - btnRect.top + 20;
    }

    panel.style.left = left + 'px';
    panel.style.bottom = bottom + 'px';
    panel.style.right = 'auto';

    panel.classList.add('show');

    // 保存面板状态
    chrome.storage.local.set({ panelOpen: true });
  }
}

// 隐藏面板
function hidePanel() {
  document.getElementById('temu-scraper-panel').classList.remove('show');

  // 保存面板状态
  chrome.storage.local.set({ panelOpen: false });
}

// 显示筛选条件对话框
async function showFilterDialog() {
  // 加载当前的筛选条件
  const result = await chrome.storage.local.get(['bannedWords', 'keywords', 'minSales', 'maxSales', 'minPrice', 'maxPrice']);
  const bannedWords = result.bannedWords || [];
  const keywords = result.keywords || [];
  const minSales = result.minSales !== undefined ? result.minSales : 0;
  const maxSales = result.maxSales !== undefined ? result.maxSales : 99999;
  const minPrice = result.minPrice !== undefined ? result.minPrice : 0;
  const maxPrice = result.maxPrice !== undefined ? result.maxPrice : 99999;

  const dialog = document.createElement('div');
  dialog.id = 'temu-banned-words-dialog';
  dialog.innerHTML = `
    <div class="temu-confirm-overlay"></div>
    <div class="temu-banned-words-box">
      <div class="temu-banned-words-header">
        <div class="temu-banned-words-title">🔍 筛选条件设置</div>
        <button class="temu-banned-words-close">×</button>
      </div>
      <div class="temu-banned-words-body">
        <div class="temu-filter-section">
          <label class="temu-filter-label">销量范围</label>
          <div class="temu-filter-input-group">
            <input type="number" class="temu-filter-input" id="filterMinSales" min="0" value="${minSales}" placeholder="最小销量">
            <span class="temu-filter-separator">-</span>
            <input type="number" class="temu-filter-input" id="filterMaxSales" min="0" value="${maxSales}" placeholder="最大销量">
          </div>
        </div>

        <div class="temu-filter-section">
          <label class="temu-filter-label">价格范围 (元)</label>
          <div class="temu-filter-input-group">
            <input type="number" class="temu-filter-input" id="filterMinPrice" min="0" step="0.01" value="${minPrice}" placeholder="最小价格">
            <span class="temu-filter-separator">-</span>
            <input type="number" class="temu-filter-input" id="filterMaxPrice" min="0" step="0.01" value="${maxPrice}" placeholder="最大价格">
          </div>
        </div>

        <div class="temu-filter-section">
          <label class="temu-filter-label">关键词 (包含关键词的商品才获取)</label>
          <div class="temu-banned-words-hint">每行输入一个关键词，只获取标题包含这些关键词的商品。留空则不限制。</div>
          <textarea class="temu-banned-words-textarea" id="keywordsTextarea" placeholder="例如：\n连衣裙\n夏季\n新款">${keywords.join('\n')}</textarea>
        </div>

        <div class="temu-filter-section">
          <label class="temu-filter-label">违规词 (包含违规词的商品不获取)</label>
          <div class="temu-banned-words-hint">每行输入一个违规词，标题包含这些词的商品将被过滤</div>
          <textarea class="temu-banned-words-textarea" id="bannedWordsTextarea" placeholder="例如：\n假货\n仿品\n山寨">${bannedWords.join('\n')}</textarea>
        </div>
      </div>
      <div class="temu-banned-words-footer">
        <button class="temu-confirm-btn temu-confirm-cancel">取消</button>
        <button class="temu-confirm-btn temu-confirm-ok">保存</button>
      </div>
    </div>
  `;

  document.body.appendChild(dialog);

  // 关闭按钮
  dialog.querySelector('.temu-banned-words-close').addEventListener('click', () => {
    dialog.remove();
  });

  // 取消按钮
  dialog.querySelector('.temu-confirm-cancel').addEventListener('click', () => {
    dialog.remove();
  });

  // 保存按钮
  dialog.querySelector('.temu-confirm-ok').addEventListener('click', async () => {
    const bannedWordsText = document.getElementById('bannedWordsTextarea').value.trim();
    const bannedWords = bannedWordsText ? bannedWordsText.split('\n').map(w => w.trim()).filter(w => w.length > 0) : [];

    const keywordsText = document.getElementById('keywordsTextarea').value.trim();
    const keywords = keywordsText ? keywordsText.split('\n').map(w => w.trim()).filter(w => w.length > 0) : [];

    const minSales = parseInt(document.getElementById('filterMinSales').value) || 0;
    const maxSales = parseInt(document.getElementById('filterMaxSales').value) || 99999;
    const minPrice = parseFloat(document.getElementById('filterMinPrice').value) || 0;
    const maxPrice = parseFloat(document.getElementById('filterMaxPrice').value) || 99999;

    // 保存到storage
    await chrome.storage.local.set({
      bannedWords: bannedWords,
      keywords: keywords,
      minSales: minSales,
      maxSales: maxSales,
      minPrice: minPrice,
      maxPrice: maxPrice
    });

    console.log('筛选条件已保存:', { bannedWords, keywords, minSales, maxSales, minPrice, maxPrice });

    let message = '筛选条件已保存';
    if (keywords.length > 0) message += `\n关键词: ${keywords.length} 个`;
    if (bannedWords.length > 0) message += `\n违规词: ${bannedWords.length} 个`;

    showToast(message, 'success');
    dialog.remove();
  });

  // 点击遮罩关闭
  dialog.querySelector('.temu-confirm-overlay').addEventListener('click', () => {
    dialog.remove();
  });
}

// 采集状态
let isScrapingActive = false;
let scrapedData = [];
let currentPage = 0;
let collectedIds = new Set(); // 用于记录已采集的商品ID，防止重复

// 从storage加载数据
async function loadDataFromStorage() {
  try {
    const result = await chrome.storage.local.get(['scrapedData', 'collectedIds', 'isScrapingActive', 'currentPage']);
    
    if (result.scrapedData) {
      scrapedData = result.scrapedData;
      console.log('从storage加载了', scrapedData.length, '条数据');
    }
    
    if (result.collectedIds) {
      collectedIds = new Set(result.collectedIds);
      console.log('从storage加载了', collectedIds.size, '个商品ID');
    }
    
    if (result.currentPage) {
      currentPage = result.currentPage;
    }
    
    // 更新状态显示
    updateStatusDisplay();
  } catch (error) {
    console.error('加载数据失败:', error);
  }
}

// 保存数据到storage
async function saveDataToStorage() {
  try {
    await chrome.storage.local.set({
      scrapedData: scrapedData,
      collectedIds: Array.from(collectedIds),
      isScrapingActive: isScrapingActive,
      currentPage: currentPage
    });
    console.log('数据已保存到storage');
  } catch (error) {
    console.error('保存数据失败:', error);
  }
}

// 清空storage数据
async function clearStorageData() {
  try {
    await chrome.storage.local.remove(['scrapedData', 'collectedIds', 'isScrapingActive', 'currentPage']);
    console.log('已清空storage数据');
  } catch (error) {
    console.error('清空数据失败:', error);
  }
}

// 更新状态显示
function updateStatusDisplay() {
  const statusEl = document.getElementById('panel-status');
  if (statusEl) {
    if (isScrapingActive) {
      statusEl.innerHTML = `状态: 获取中...<br>已获取: ${scrapedData.length}`;
    } else {
      statusEl.innerHTML = `状态: 就绪<br>已获取: ${scrapedData.length}`;
    }
  }
}

// 切换采集状态
function toggleScraping() {
  if (isScrapingActive) {
    stopScraping();
  } else {
    startScraping();
  }
}

// 更新切换按钮状态
function updateToggleButton() {
  const toggleBtn = document.getElementById('panel-toggleBtn');
  if (toggleBtn) {
    if (isScrapingActive) {
      toggleBtn.textContent = '■ 停止获取';
      toggleBtn.classList.remove('temu-btn-start');
      toggleBtn.classList.add('temu-btn-stop');
    } else {
      toggleBtn.textContent = '▶ 开始获取';
      toggleBtn.classList.remove('temu-btn-stop');
      toggleBtn.classList.add('temu-btn-start');
    }
  }
}

// 开始采集
async function startScraping() {
  if (isScrapingActive) return;

  const pageTypeRadio = document.querySelector('input[name="pageType"]:checked');
  const pageType = pageTypeRadio ? pageTypeRadio.value : 'search';
  const pageCount = parseInt(document.getElementById('panel-pageCount').value);
  const minDelay = parseInt(document.getElementById('panel-minDelay').value);
  const maxDelay = parseInt(document.getElementById('panel-maxDelay').value);
  const carouselMode = document.getElementById('panel-carouselMode')?.checked || false;

  // 从storage加载筛选条件
  const filterResult = await chrome.storage.local.get(['bannedWords', 'keywords', 'minSales', 'maxSales', 'minPrice', 'maxPrice']);
  const bannedWords = filterResult.bannedWords || [];
  const keywords = filterResult.keywords || [];
  const minSales = filterResult.minSales !== undefined ? filterResult.minSales : 0;
  const maxSales = filterResult.maxSales !== undefined ? filterResult.maxSales : 99999;
  const minPrice = filterResult.minPrice !== undefined ? filterResult.minPrice : 0;
  const maxPrice = filterResult.maxPrice !== undefined ? filterResult.maxPrice : 99999;

  console.log('开始获取', { pageType, pageCount, minDelay, maxDelay, minSales, maxSales, minPrice, maxPrice, bannedWords, keywords });

  // 立即设置为获取状态并更新按钮
  isScrapingActive = true;
  updateToggleButton();

  // 反检测：防止页面因失焦而暂停渲染/加载
  enableAntiVisibilityDetection();

  // 显示遮罩层，防止用户误操作
  showScrapingOverlay();

  const isNewSession = scrapedData.length === 0;

  // 显示日志窗口
  showLogWindow();
  if (isNewSession) {
    clearLog();
    addLog('🚀 开始新的获取任务', 'success');
  } else {
    addLog('➕ 继续累加获取数据（自动去重）', 'info');
  }
  
  addLog(`📄 页面类型: ${PAGE_CONFIG[pageType]?.name || pageType}`, 'info');
  addLog(`📊 计划翻页: ${pageCount} 次`, 'info');
  addLog(`⏱️ 翻页延迟: ${minDelay}-${maxDelay} 秒`, 'info');
  addLog(`📈 销量范围: ${minSales}-${maxSales}`, 'info');
  addLog(`💰 价格范围: ${minPrice}-${maxPrice} 元`, 'info');
  if (keywords.length > 0) {
    addLog(`🔑 关键词筛选: ${keywords.length} 个`, 'info');
  }
  if (bannedWords.length > 0) {
    addLog(`🚫 违规词过滤: ${bannedWords.length} 个`, 'info');
  }
  if (carouselMode) {
    addLog(`🖼️ 轮播图采集: 已开启（每个商品会打开详情页，速度较慢）`, 'info');
  }
  if (!isNewSession) {
    addLog(`📦 当前已有: ${scrapedData.length} 条数据`, 'info');
  }
  
  document.getElementById('panel-status').innerHTML = `状态: 准备中...<br>已获取: ${scrapedData.length}`;

  // 先检查页面是否加载完成
  console.log('检查页面是否加载完成...');
  addLog('🔍 检查页面是否加载完成...', 'info');
  const pageLoaded = await waitForPageLoad(pageType, 30000);
  if (!pageLoaded) {
    // waitForPageLoad 函数内部已经添加了详细的错误日志
    showToast('页面加载失败，获取已停止', 'error', 4000);
    isScrapingActive = false;
    document.getElementById('panel-status').innerHTML = `状态: 页面加载失败<br>已获取: ${scrapedData.length}`;
    updateToggleButton();
    return;
  }

  addLog('✅ 页面加载完成', 'success');
  document.getElementById('panel-status').innerHTML = `状态: 获取中...<br>已获取: ${scrapedData.length}`;
  
  try {
    for (let i = 0; i < pageCount; i++) {
      if (!isScrapingActive) {
        addLog('⏸️ 用户手动停止获取', 'warning');
        break;
      }

      currentPage = i + 1;
      addLog(`📖 开始获取第 ${currentPage} 页...`, 'info');
      document.getElementById('panel-status').innerHTML = `状态: 获取第${currentPage}页<br>已获取: ${scrapedData.length}`;

      // 获取当前页面数据
      const beforeCount = scrapedData.length;
      await scrapePage(pageType, minSales, maxSales, minPrice, maxPrice, bannedWords, keywords, carouselMode);
      const newCount = scrapedData.length - beforeCount;
      addLog(`✅ 第 ${currentPage} 页获取完成，新增 ${newCount} 条数据（总计: ${scrapedData.length}）`, 'success');
      
      // 保存数据到storage
      await saveDataToStorage();
      
      // 如果不是最后一页，翻页
      if (i < pageCount - 1) {
        addLog(`📄 准备翻页到第 ${currentPage + 1} 页...`, 'info');
        const hasNextPage = await goToNextPage(pageType);
        if (!hasNextPage) {
          addLog('⚠️ 没有更多页面了，获取结束', 'warning');
          console.log('没有更多页面了');
          break;
        }

        // 随机延迟时间
        const randomDelay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
        addLog(`⏳ 等待 ${randomDelay} 秒后继续...`, 'info');
        console.log(`等待 ${randomDelay} 秒后继续...`);

        // 分段等待，每100ms检查一次是否停止
        const delayMs = randomDelay * 1000;
        const startDelayTime = Date.now();
        while (Date.now() - startDelayTime < delayMs) {
          if (!isScrapingActive) {
            addLog('⏸️ 用户在延迟等待中停止获取', 'warning');
            break;
          }
          await sleep(100);
        }
      }
    }

    document.getElementById('panel-status').innerHTML = `状态: 获取完成<br>已获取: ${scrapedData.length}`;
    addLog(`🎉 获取任务完成！共获取 ${scrapedData.length} 条商品数据`, 'success');
    console.log('获取完成，共获取', scrapedData.length, '条数据');

    // 显示完成对话框
    showAlert(`<div style="text-align: center; line-height: 1.8;">
      <div style="font-size: 48px; margin-bottom: 10px;">🎉</div>
      <div style="font-size: 16px; font-weight: 600; margin-bottom: 10px;">获取完成！</div>
      <div style="font-size: 14px; color: #ffd700;">共获取 <span style="font-size: 18px; font-weight: 700;">${scrapedData.length}</span> 条商品数据</div>
    </div>`);
    
    // 最终保存
    await saveDataToStorage();
  } catch (error) {
    console.error('获取出错:', error);
    addLog(`❌ 获取出错: ${error.message}`, 'error');
    document.getElementById('panel-status').innerHTML = `状态: 获取出错<br>已获取: ${scrapedData.length}`;
    
    // 出错也保存数据
    await saveDataToStorage();
  } finally {
    isScrapingActive = false;
    await saveDataToStorage();
    updateToggleButton();
    // 隐藏遮罩层
    hideScrapingOverlay();
    // 恢复原始的 visibility 检测
    disableAntiVisibilityDetection();
  }
}

// 等待页面加载完成
async function waitForPageLoad(pageType, timeout = 30000) {
  const startTime = Date.now();
  
  // 根据页面类型确定容器XPath
  let containerXPath;
  if (pageType === 'search') {
    containerXPath = "//div[@class='js-search-goodsList']";
  } else if (pageType === 'explore') {
    containerXPath = "//div[@id='goodsRecommend']/div[@class='js-goods-list']";
  } else if (pageType === 'recommend') {
    // 为您精选页面：第一个子div不是role="region"（是标题div）
    containerXPath = "//div[@class='js-goods-list'][./div[1][not(@role='region')]]";
  } else if (pageType === 'shop') {
    // 店铺商品：第一个子div就是role="region"（直接是商品列表）
    containerXPath = "//div[@class='js-goods-list'][./div[1][@role='region']]";
  } else {
    console.log('暂不支持该页面类型');
    addLog('❌ 不支持的页面类型', 'error');
    return false;
  }

  console.log('等待页面加载完成...');

  let lastLogTime = Date.now();
  const logInterval = 5000; // 每5秒输出一次等待日志

  while (Date.now() - startTime < timeout) {
    // 检查是否用户停止了获取
    if (!isScrapingActive) {
      console.log('用户停止了获取，中断页面加载检测');
      addLog('⏸️ 用户停止了获取', 'warning');
      return false;
    }
    
    // 每5秒输出一次等待日志
    const elapsed = Date.now() - startTime;
    if (Date.now() - lastLogTime >= logInterval) {
      const remainingSeconds = Math.ceil((timeout - elapsed) / 1000);
      addLog(`⏳ 正在等待页面加载... (剩余 ${remainingSeconds} 秒)`, 'info');
      lastLogTime = Date.now();
    }
    
    // 检查容器是否存在
    const containerResult = document.evaluate(containerXPath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    const container = containerResult.singleNodeValue;

    // 调试日志
    if (Date.now() - lastLogTime >= logInterval) {
      console.log(`[调试] 容器XPath: ${containerXPath}`);
      console.log(`[调试] 找到容器: ${!!container}`);
    }

    if (container) {
      // 检查是否有商品
      const itemsXPath = pageType === 'search'
        ? "//div[@class='js-search-goodsList']//div[@role='group']"
        : pageType === 'explore'
        ? "//div[@id='goodsRecommend']/div[@class='js-goods-list']//div[@role='group']"
        : pageType === 'recommend'
        ? "//div[@class='js-goods-list'][./div[1][not(@role='region')]]//div[@role='group']"
        : "//div[@class='js-goods-list'][./div[1][@role='region']]//div[@role='group']";

      const itemsResult = document.evaluate(itemsXPath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      const itemsCount = itemsResult.snapshotLength;

      // 调试日志
      if (Date.now() - lastLogTime >= logInterval) {
        console.log(`[调试] 商品XPath: ${itemsXPath}`);
        console.log(`[调试] 找到商品数量: ${itemsCount}`);
      }

      if (itemsCount > 0) {
        console.log(`✓ 页面加载完成，找到 ${itemsCount} 个商品`);
        return true;
      }
    }
    
    // 等待100ms后重试
    await sleep(100);
  }
  
  console.log('✗ 页面加载超时');
  addLog(`❌ 页面加载超时（等待了 ${timeout / 1000} 秒）`, 'error');
  addLog('💡 请确认：1) 当前页面类型是否正确 2) 页面是否已完全加载', 'warning');
  return false;
}

// 获取单页数据
async function scrapePage(pageType, minSales, maxSales, minPrice, maxPrice, bannedWords = [], keywords = [], carouselMode = false) {
  // 等待页面加载完成
  const loaded = await waitForPageLoad(pageType, 30000);
  if (!loaded) {
    console.log('页面未加载完成，跳过获取');
    return;
  }
  
  // 额外等待确保所有元素渲染完成
  await sleep(1000);

  // 轮播图连续失败计数器
  let carouselFailCount = 0;
  
  // 根据页面类型使用不同的XPath
  let itemsXPath;
  if (pageType === 'search') {
    itemsXPath = "//div[@class='js-search-goodsList']//div[@role='group']";
  } else if (pageType === 'explore') {
    itemsXPath = "//div[@id='goodsRecommend']/div[@class='js-goods-list']//div[@role='group']";
  } else if (pageType === 'recommend') {
    // 为您精选页面：第一个子div不是role="region"（是标题div）
    itemsXPath = "//div[@class='js-goods-list'][./div[1][not(@role='region')]]//div[@role='group']";
  } else if (pageType === 'shop') {
    // 店铺商品：第一个子div就是role="region"（直接是商品列表）
    itemsXPath = "//div[@class='js-goods-list'][./div[1][@role='region']]//div[@role='group']";
  } else {
    console.log('暂不支持该页面类型');
    return;
  }
  
  // 使用XPath获取所有商品
  const itemsResult = document.evaluate(itemsXPath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
  const itemsCount = itemsResult.snapshotLength;
  console.log(`找到 ${itemsCount} 个商品`);
  
  for (let index = 0; index < itemsCount; index++) {
    // 检查是否用户停止了获取
    if (!isScrapingActive) {
      addLog('⏸️ 用户已停止获取，中断当前页采集', 'warning');
      break;
    }

    try {
      const item = itemsResult.snapshotItem(index);
      if (!item) continue;
      
      // 1. 获取链接和商品ID
      const linkXPath = ".//a[contains(@href, '.html')]";
      const linkResult = document.evaluate(linkXPath, item, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      const linkEl = linkResult.singleNodeValue;
      const link = linkEl?.href || '';
      let goodsId = '';
      
      if (link) {
        // 尝试匹配 g-数字.html 格式
        let match = link.match(/g-(\d+)\.html/);
        if (match) {
          goodsId = match[1];
        } else {
          // 尝试匹配 goods_id=数字 格式
          match = link.match(/goods_id=(\d+)/);
          if (match) {
            goodsId = match[1];
          }
        }
      }
      
      // 如果没有商品ID，跳过
      if (!goodsId) {
        console.log(`✗ 跳过商品 ${index + 1}（无法获取商品ID）, 链接: ${link}`);
        continue;
      }
      
      // 检查是否重复
      if (collectedIds.has(goodsId)) {
        console.log(`✗ 跳过商品 ${index + 1}（重复ID: ${goodsId}）`);
        continue;
      }
      
      // 2. 获取标题 - 使用XPath查找h2或h3下的span,排除提示文本
      let title = '';
      const titleXPath = ".//h2/span | .//h3/span";
      const titleResult = document.evaluate(titleXPath, item, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      
      for (let i = 0; i < titleResult.snapshotLength; i++) {
        const span = titleResult.snapshotItem(i);
        const text = span?.textContent?.trim() || '';
        // 排除提示文本
        if (text && !text.includes('Open in') && !text.includes('Local') && 
            !text.includes('Top pick') && !text.includes('在新标签页') && 
            !text.includes('新标签')) {
          title = text;
          break;
        }
      }
      
      // 如果没有标题，跳过
      if (!title) {
        console.log(`✗ 跳过商品 ${index + 1}（无法获取标题）`);
        continue;
      }

      // 检查关键词筛选（如果设置了关键词，则必须包含至少一个关键词）（不区分大小写）
      if (keywords.length > 0) {
        let hasKeyword = false;
        const lowerTitle = title.toLowerCase();
        for (const keyword of keywords) {
          if (lowerTitle.includes(keyword.toLowerCase())) {
            hasKeyword = true;
            break;
          }
        }
        if (!hasKeyword) {
          console.log(`✗ 跳过商品 ${index + 1}（标题不包含关键词）`);
          continue;
        }
      }

      // 检查标题是否包含违规词（不区分大小写）
      if (bannedWords.length > 0) {
        let hasBannedWord = false;
        let matchedWord = '';
        const lowerTitle = title.toLowerCase();
        for (const word of bannedWords) {
          if (lowerTitle.includes(word.toLowerCase())) {
            hasBannedWord = true;
            matchedWord = word;
            break;
          }
        }
        if (hasBannedWord) {
          console.log(`✗ 跳过商品 ${index + 1}（标题包含违规词: ${matchedWord}）`);
          continue;
        }
      }

      // 3. 获取主图URL - 使用XPath
      const imageXPath = ".//img[@data-js-main-img='true']";
      const imageResult = document.evaluate(imageXPath, item, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      const imageEl = imageResult.singleNodeValue;
      let imageUrl = imageEl?.getAttribute('data-src') || imageEl?.src || '';
      
      // 优化为高清图
      if (imageUrl) {
        imageUrl = imageUrl.replace(/\/w\/\d+\//, '/w/800/').replace(/\/q\/\d+\//, '/q/90/');
      }
      
      // 如果没有图片，使用占位符而不是跳过
      if (!imageUrl) {
        console.log(`⚠ 商品 ${index + 1} 没有图片，使用占位符`);
        imageUrl = 'no-image';
      }
      
      // 4. 获取价格 - 使用XPath
      const priceXPath = ".//*[@data-type='price']//*[@aria-hidden='true']//span";
      const priceResult = document.evaluate(priceXPath, item, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      let price = '';
      let priceValue = 0;
      if (priceResult.snapshotLength >= 2) {
        const parts = [];
        for (let i = 0; i < priceResult.snapshotLength; i++) {
          const span = priceResult.snapshotItem(i);
          parts.push(span?.textContent?.trim() || '');
        }
        price = parts.join('');

        // 提取价格数值
        const priceMatch = price.match(/([\d.,]+)/);
        if (priceMatch) {
          priceValue = parseFloat(priceMatch[1].replace(/,/g, ''));
        }
      }

      // 5. 获取销量 - 使用XPath
      const salesXPath = ".//*[@data-type='saleTips']//span[@aria-hidden='true']";
      const salesResult = document.evaluate(salesXPath, item, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      let salesText = '无销量';
      let sales = 0;
      
      if (salesResult.snapshotLength >= 2) {
        // 遍历所有span,找到包含数字的那个
        for (let i = 0; i < salesResult.snapshotLength; i++) {
          const spanText = salesResult.snapshotItem(i)?.textContent?.trim() || '';
          
          // 跳过"已售"、"Sold"这样的前缀
          if (spanText === '已售' || spanText === 'Sold' || spanText === '已售出' || spanText === 'sold') {
            continue;
          }
          
          // 检查是否包含数字
          if (/\d/.test(spanText)) {
            salesText = spanText;
            
            // 提取销量数字，处理各种格式
            const match = spanText.match(/([\d.,]+)\s*([K+万件]?)/i);
            if (match) {
              let num = parseFloat(match[1].replace(/,/g, ''));
              const unit = match[2];
              
              if (unit && unit.toUpperCase().includes('K')) {
                num = num * 1000;
              } else if (unit && unit.includes('万')) {
                num = num * 10000;
              }
              
              sales = Math.floor(num);
            }
            break;
          }
        }
      }
      
      if (sales === 0) {
        console.log(`⚠ 商品 ${index + 1} (ID: ${goodsId}) 没有销量信息`);
      }

      // 6. 根据销量和价格范围过滤
      const salesMatch = sales >= minSales && sales <= maxSales;
      const priceMatch = priceValue >= minPrice && priceValue <= maxPrice;

      if (salesMatch && priceMatch) {
        const itemData = {
          id: goodsId,
          title: title,
          image: imageUrl,
          images: [], // 轮播图数组，后续填充
          price: price,
          sales: sales,
          salesText: salesText // 保存销量文本用于显示
        };

        if (carouselMode && isScrapingActive) {
          // 轮播图模式：必须获取到轮播图才保存
          addLog(`🖼️ 正在获取商品 (${goodsId}) 的轮播图...`, 'info');
          let carouselOk = false;
          try {
            const carouselImages = await fetchCarouselFromDialog(item);
            if (carouselImages && carouselImages.length > 0) {
              itemData.images = carouselImages;
              carouselOk = true;
              carouselFailCount = 0;
            }
          } catch (e) {
            if (e.message === 'VIDEO_CARD_SKIP') {
              // 视频卡片：购物车未弹窗且为视频卡片，跳过防止页面跳转
  
              collectedIds.add(goodsId);
              continue;
            }
            if (e.message === 'NO_SKU_DIALOG') {
              // 弹窗没出现 → 先检查是否被验证码拦截
              if (isCaptchaPresent()) {
                hideScrapingOverlay();
                const passed = await waitForManualVerification();
                showScrapingOverlay();
                if (passed) {
                  carouselFailCount = 0;
                  index--; // 回退索引，重试当前商品
                  continue;
                } else {
                  isScrapingActive = false;
                  break;
                }
              } else {
                // 确实没有弹窗，判定为单规格商品，跳过
                collectedIds.add(goodsId);
                await closeSkuDialog();
                continue;
              }
            }
            addLog(`⚠️ 轮播图获取异常: ${e.message}`, 'warning');
          }

          if (carouselOk) {
            // 成功：保存商品并标记ID
            collectedIds.add(goodsId);
            scrapedData.push(itemData);
            chrome.storage.local.set({ currentFetchCount: scrapedData.length });
            document.getElementById('panel-status').innerHTML = `状态: 获取中...<br>已获取: ${scrapedData.length}`;
            addLog(`✅ 获取到 ${itemData.images.length} 张轮播图，商品已保存 (${scrapedData.length})`, 'success');
          } else {
            // 失败：标记ID永久跳过
            collectedIds.add(goodsId);
            carouselFailCount++;
            addLog(`⚠️ 轮播图获取失败，连续失败 ${carouselFailCount} 次`, 'warning');

            // 连续失败时主动检查是否有验证码
            if (carouselFailCount >= 3) {
              if (isCaptchaPresent()) {
                addLog(`🚨 连续失败 ${carouselFailCount} 次，检测到验证码！脚本暂停...`, 'error');
                await closeSkuDialog();
                hideScrapingOverlay();
                const passed = await waitForManualVerification();
                showScrapingOverlay();
                if (passed) {
                  addLog(`✅ 验证已通过，自动恢复采集`, 'success');
                  carouselFailCount = 0;
                } else {
                  addLog(`🛑 验证等待超时，终止采集`, 'error');
                  isScrapingActive = false;
                  break;
                }
              } else {
                addLog(`⚠️ 连续 ${carouselFailCount} 次失败但未检测到验证码，继续尝试`, 'warning');
              }
            }
          }

          // 拟人延迟 1.5~3 秒
          const delayTime = 1500 + Math.random() * 1500;
          const delayStart = Date.now();
          while (Date.now() - delayStart < delayTime) {
            if (!isScrapingActive) break;
            await sleep(200);
          }
        } else if (!carouselMode) {
          // 非轮播图模式：直接保存
          collectedIds.add(goodsId);
          scrapedData.push(itemData);
          chrome.storage.local.set({ currentFetchCount: scrapedData.length });
          document.getElementById('panel-status').innerHTML = `状态: 获取中...<br>已获取: ${scrapedData.length}`;
          console.log(`✓ 获取商品 ${scrapedData.length}:`, {
            id: goodsId,
            title: title.substring(0, 30) + '...',
            price,
            sales: salesText
          });
          // 让出主线程，使浏览器有机会渲染 DOM 更新和触发 storage 事件
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      } else {
        const reasons = [];
        if (!salesMatch) reasons.push(`销量不符: ${sales} (范围: ${minSales}-${maxSales})`);
        if (!priceMatch) reasons.push(`价格不符: ${priceValue} (范围: ${minPrice}-${maxPrice})`);
        console.log(`✗ 跳过商品:`, {
          id: goodsId,
          reasons: reasons.join(', ')
        });
      }
    } catch (error) {
      console.error(`获取第 ${index + 1} 个商品出错:`, error);
    }
  }

  console.log(`当前页获取完成，总计获取 ${scrapedData.length} 条数据（去重后）`);
  console.log(`已记录 ${collectedIds.size} 个不重复的商品ID`);
}

// 模拟人类滚动行为
// 模拟人类滚动到元素位置
async function humanLikeScroll(element) {
  const elementRect = element.getBoundingClientRect();
  const elementTop = elementRect.top + window.pageYOffset;
  const elementCenter = elementTop - (window.innerHeight / 2) + (elementRect.height / 2);

  const startPosition = window.pageYOffset;
  const distance = elementCenter - startPosition;

  // 如果元素已经在视口中心附近，就不需要滚动
  if (Math.abs(distance) < 100) {
    console.log('按钮已在视口中心，无需滚动');
    await sleep(200 + Math.random() * 300); // 随机等待200-500ms
    return;
  }

  console.log(`开始人类化滚动，距离: ${distance.toFixed(0)}px`);

  // 滚动参数
  const duration = 800 + Math.random() * 600; // 总时长800-1400ms
  const startTime = Date.now();

  // 使用缓动函数（ease-in-out）模拟人类滚动
  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  // 触发滚动开始事件
  window.dispatchEvent(new Event('scroll', { bubbles: true }));

  // 执行滚动动画
  while (true) {
    const elapsed = Date.now() - startTime;
    const progress = Math.min(elapsed / duration, 1);

    // 应用缓动函数
    const easedProgress = easeInOutCubic(progress);
    const currentPosition = startPosition + (distance * easedProgress);

    // 添加轻微的随机抖动，模拟人手不稳
    const jitter = (Math.random() - 0.5) * 3;

    // 使用 scrollTo 并触发 scroll 事件
    window.scrollTo({
      top: currentPosition + jitter,
      behavior: 'auto'
    });

    // 触发滚动事件
    window.dispatchEvent(new Event('scroll', { bubbles: true }));

    if (progress >= 1) {
      break;
    }

    // 每帧等待约16ms（60fps）
    await sleep(16);
  }

  console.log('滚动完成');

  // 滚动完成后随机停顿一下，模拟人类反应时间
  await sleep(300 + Math.random() * 400); // 随机等待300-700ms
}

// 翻页（点击"查看更多"按钮加载更多商品）
async function goToNextPage(pageType) {
  console.log('尝试加载更多商品...');
  
  let xpathChinese, xpathEnglish, containerXPath;
  
  // 根据页面类型选择不同的XPath
  if (pageType === 'search') {
    // 搜索商品页面
    xpathChinese = "//div[@class='js-search-goodsList']//div[@role='region']//span[text()='查看更多']";
    xpathEnglish = "//div[@class='js-search-goodsList']//div[@role='region']//span[text()='See more']";
    containerXPath = "//div[@class='js-search-goodsList']//div[@role='group']";
  } else if (pageType === 'explore') {
    // 探索好物页面
    xpathChinese = "//div[@id='goodsRecommend']/div[@class='js-goods-list']//div[@role='region']//span[text()='查看更多']";
    xpathEnglish = "//div[@id='goodsRecommend']/div[@class='js-goods-list']//div[@role='region']//span[text()='View more']";
    containerXPath = "//div[@id='goodsRecommend']/div[@class='js-goods-list']//div[@role='group']";
  } else if (pageType === 'recommend') {
    // 为您精选页面：第一个子div不是role="region"（是标题div）
    xpathChinese = "//div[@class='js-goods-list'][./div[1][not(@role='region')]]//div[@role='region']//span[text()='查看更多']";
    xpathEnglish = "//div[@class='js-goods-list'][./div[1][not(@role='region')]]//div[@role='region']//span[text()='See more']";
    containerXPath = "//div[@class='js-goods-list'][./div[1][not(@role='region')]]//div[@role='group']";
  } else if (pageType === 'shop') {
    // 店铺商品页面：第一个子div就是role="region"（直接是商品列表）
    xpathChinese = "//div[@class='js-goods-list'][./div[1][@role='region']]//div[@role='region']//span[text()='查看更多']";
    xpathEnglish = "//div[@class='js-goods-list'][./div[1][@role='region']]//div[@role='region']//span[text()='See more']";
    containerXPath = "//div[@class='js-goods-list'][./div[1][@role='region']]//div[@role='group']";
  } else {
    console.log('暂不支持该页面类型的翻页');
    return false;
  }
  
  let loadMoreButton = null;
  
  // 先尝试中文
  let result = document.evaluate(xpathChinese, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
  let spanElement = result.singleNodeValue;
  
  // 如果没找到，尝试英文
  if (!spanElement) {
    result = document.evaluate(xpathEnglish, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    spanElement = result.singleNodeValue;
  }
  
  if (!spanElement) {
    console.log('未找到"查看更多"按钮，可能已经到底了');
    return false;
  }
  
  console.log('找到"查看更多"文本元素:', spanElement.textContent);
  
  // 向上查找可点击的父元素
  let clickable = spanElement;
  while (clickable && clickable !== document.body) {
    if (clickable.getAttribute('role') === 'button' || 
        clickable.tagName === 'BUTTON' ||
        clickable.onclick) {
      loadMoreButton = clickable;
      break;
    }
    clickable = clickable.parentElement;
  }
  
  if (!loadMoreButton) {
    console.log('未找到可点击的按钮元素');
    return false;
  }
  
  console.log('找到可点击按钮:', loadMoreButton);

  // 模拟人类滚动行为：慢慢滚动到按钮位置
  await humanLikeScroll(loadMoreButton);

  // 记录点击前的商品数量
  const beforeResult = document.evaluate(containerXPath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
  const beforeCount = beforeResult.snapshotLength;
  console.log('点击前商品数量:', beforeCount);

  // 模拟人类点击行为
  console.log('模拟人类点击"查看更多"按钮...');

  // 1. 鼠标移动到按钮上（触发 mouseover 和 mouseenter）
  loadMoreButton.dispatchEvent(new MouseEvent('mouseover', {
    view: window,
    bubbles: true,
    cancelable: true,
    clientX: loadMoreButton.getBoundingClientRect().left + loadMoreButton.offsetWidth / 2,
    clientY: loadMoreButton.getBoundingClientRect().top + loadMoreButton.offsetHeight / 2
  }));
  loadMoreButton.dispatchEvent(new MouseEvent('mouseenter', {
    view: window,
    bubbles: true,
    cancelable: true
  }));

  // 随机停顿，模拟人类反应时间（100-300ms）
  await sleep(100 + Math.random() * 200);

  // 2. 鼠标按下（mousedown）
  loadMoreButton.dispatchEvent(new MouseEvent('mousedown', {
    view: window,
    bubbles: true,
    cancelable: true,
    button: 0,
    buttons: 1,
    clientX: loadMoreButton.getBoundingClientRect().left + loadMoreButton.offsetWidth / 2,
    clientY: loadMoreButton.getBoundingClientRect().top + loadMoreButton.offsetHeight / 2
  }));

  // 随机按住时间（50-150ms）
  await sleep(50 + Math.random() * 100);

  // 3. 鼠标抬起（mouseup）
  loadMoreButton.dispatchEvent(new MouseEvent('mouseup', {
    view: window,
    bubbles: true,
    cancelable: true,
    button: 0,
    buttons: 0,
    clientX: loadMoreButton.getBoundingClientRect().left + loadMoreButton.offsetWidth / 2,
    clientY: loadMoreButton.getBoundingClientRect().top + loadMoreButton.offsetHeight / 2
  }));

  // 4. 点击事件（click）
  loadMoreButton.dispatchEvent(new MouseEvent('click', {
    view: window,
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: loadMoreButton.getBoundingClientRect().left + loadMoreButton.offsetWidth / 2,
    clientY: loadMoreButton.getBoundingClientRect().top + loadMoreButton.offsetHeight / 2
  }));

  // 随机停顿后移开鼠标（50-150ms）
  await sleep(50 + Math.random() * 100);

  // 5. 鼠标移开（mouseout 和 mouseleave）
  loadMoreButton.dispatchEvent(new MouseEvent('mouseout', {
    view: window,
    bubbles: true,
    cancelable: true
  }));
  loadMoreButton.dispatchEvent(new MouseEvent('mouseleave', {
    view: window,
    bubbles: true,
    cancelable: true
  }));

  // 等待新商品加载 - 使用更智能的等待策略
  console.log('等待新商品加载...');
  let loadSuccess = false;
  const maxWaitTime = 10000; // 最多等待10秒
  const checkInterval = 500; // 每500ms检查一次
  const startWaitTime = Date.now();
  
  while (Date.now() - startWaitTime < maxWaitTime) {
    // 检查是否用户停止了获取
    if (!isScrapingActive) {
      console.log('用户停止了获取，中断翻页等待');
      return false;
    }
    
    await sleep(checkInterval);
    
    // 检查商品数量是否增加
    const currentResult = document.evaluate(containerXPath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    const currentCount = currentResult.snapshotLength;
    
    if (currentCount > beforeCount) {
      console.log(`成功加载更多商品，新增 ${currentCount - beforeCount} 个，总计 ${currentCount} 个`);
      loadSuccess = true;
      break;
    }
  }
  
  if (!loadSuccess) {
    console.log('等待超时，未加载到新商品，可能已经到底了');
    return false;
  }
  
  // 额外等待一下确保所有商品渲染完成
  await sleep(500);
  
  return true;
}

// ========== 验证码检测与智能挂起 ==========

/**
 * 检测页面上是否存在验证码弹窗（全球版本兼容）
 * 采用多维探测法：多语言词库 + 通用属性 + 视觉遮障
 */
function isCaptchaPresent() {
  // ── 多语言验证码关键词库 ──
  const CAPTCHA_KEYWORDS = [
    // 中文简体/繁体
    '安全验证', '验证码', '人机验证', '滑动验证', '拖动验证',
    '确认您是人类', '拖动相应的形状', '请完成安全验证',
    '安全檢測', '驗證碼', '人機驗證',
    // 英语
    'security verification', 'verify you are human',
    'confirm you are not a robot', 'slide to verify',
    'drag to verify', 'captcha', 'human verification',
    'complete the security check', 'prove you are human',
    // 日语
    'セキュリティ検証', '認証', 'ロボットではない',
    // 韩语
    '보안 인증', '사람인지 확인',
    // 法语
    'vérification de sécurité', 'confirmez que vous êtes humain',
    // 德语
    'sicherheitsüberprüfung', 'bestätigen sie, dass sie ein mensch sind',
    // 西班牙语
    'verificación de seguridad', 'confirma que eres humano',
    // 葡萄牙语
    'verificação de segurança', 'confirme que é humano',
    // 意大利语
    'verifica di sicurezza',
    // 阿拉伯语
    'التحقق الأمني',
  ];

  // ── 维度1：特征 ID / 属性快速命中 ──
  if (document.querySelector('#Slider[role="dialog"]')) return true;

  // ── 维度2：通用属性探测（dialog / aria-modal 内的语义属性）──
  const modalEls = document.querySelectorAll('[role="dialog"], [aria-modal="true"]');
  for (const el of modalEls) {
    // 排除我们自己的脚本弹窗
    if (el.id === 'skuSelector') continue;
    // 检查 aria-label
    const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
    if (CAPTCHA_KEYWORDS.some(kw => ariaLabel.includes(kw.toLowerCase()))) return true;
    // 检查 dialog 内可见文本（TreeWalker 只遍历可见文本节点，高效且精确）
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        // 跳过隐藏元素内的文本
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const style = getComputedStyle(parent);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let textNode;
    while ((textNode = walker.nextNode())) {
      const text = textNode.textContent.trim().toLowerCase();
      if (text.length < 2 || text.length > 200) continue; // 跳过空白和超长文本
      if (CAPTCHA_KEYWORDS.some(kw => text.includes(kw.toLowerCase()))) return true;
    }
  }

  // ── 维度3：视觉遮障探测 ──
  // 检查 body overflow 是否被锁死（验证码弹窗通常会阻止页面滚动）
  const bodyStyle = getComputedStyle(document.body);
  const bodyLocked = bodyStyle.overflow === 'hidden' || bodyStyle.overflowY === 'hidden';

  if (bodyLocked) {
    // body 被锁 → 检查是否存在高 z-index 全屏遮罩（排除我们自己的元素）
    const OWN_IDS = new Set(['temu-scraping-overlay', '__captcha_warning_banner__', 'skuSelector']);
    const allFixed = document.querySelectorAll('body > div, body > section, body > aside');
    for (const el of allFixed) {
      if (OWN_IDS.has(el.id)) continue;
      const style = getComputedStyle(el);
      if (style.position !== 'fixed' && style.position !== 'absolute') continue;
      const zIndex = parseInt(style.zIndex) || 0;
      if (zIndex < 9999) continue; // 低 z-index 的忽略
      const rect = el.getBoundingClientRect();
      const coversScreen = rect.width >= window.innerWidth * 0.8 && rect.height >= window.innerHeight * 0.8;
      if (coversScreen) return true;
    }
  }

  return false;
}

/**
 * 智能挂起：显示红色警告条，轮询等待用户手动完成验证
 * @param {number} maxWait 最大等待时间（毫秒），默认 5 分钟
 * @returns {Promise<boolean>} true=验证已通过，false=等待超时
 */
function waitForManualVerification(maxWait = 5 * 60 * 1000) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const timer = setInterval(() => {
      if (!isCaptchaPresent()) {
        // 验证已通过
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() - startTime > maxWait) {
        // 超时
        clearInterval(timer);
        resolve(false);
      }
    }, 1500);
  });
}

// ========== SKU 弹窗关闭 ==========

// 通过点击购物车按钮打开 SKU 弹窗，从中提取轮播图
async function closeSkuDialog() {
  const dialog = document.querySelector('#skuSelector');
  if (!dialog) return;

  // 策略1：找到关闭按钮，用完整鼠标事件序列点击
  const outerDialog = dialog.closest('div[role="dialog"]');
  const closeBtn = outerDialog?.querySelector('div[aria-label="close"]')
    || document.querySelector('div[aria-label="close"]');
  if (closeBtn) {
    const rect = closeBtn.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const eventOpts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0 };
    closeBtn.dispatchEvent(new MouseEvent('mousedown', eventOpts));
    closeBtn.dispatchEvent(new MouseEvent('mouseup', eventOpts));
    closeBtn.dispatchEvent(new MouseEvent('click', eventOpts));
    await sleep(400);
    if (!document.querySelector('#skuSelector')) return; // 已关闭
  }

  // 策略2：点击遮罩层（弹窗外区域）
  const overlay = dialog.closest('div[role="dialog"]')?.parentElement;
  if (overlay) {
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 0, clientY: 0 }));
    await sleep(400);
    if (!document.querySelector('#skuSelector')) return;
  }

  // 策略3：发送 Escape 键
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
  document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
  await sleep(400);
  if (!document.querySelector('#skuSelector')) return;

  // 策略4：直接移除弹窗 DOM（最后手段）
  const wrapper = dialog.closest('div[role="dialog"]')?.parentElement || dialog.parentElement;
  if (wrapper && wrapper !== document.body) {
    wrapper.remove();
  }
}

async function fetchCarouselFromDialog(itemEl) {
  // ⓪ 先关闭可能残留的上一个 SKU 弹窗
  await closeSkuDialog();

  // 滚动到商品位置，确保卡片可见
  itemEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await sleep(500);

  // === 第一步：尝试点击购物车按钮 ===
  const cartBtn = itemEl.querySelector('svg[aria-label="Add to cart"]')
    || itemEl.querySelector('svg[aria-label="加入购物车"]');

  let dialog = null;

  if (cartBtn) {
    const clickTarget = cartBtn.closest('div[aria-hidden="true"]') || cartBtn.parentElement || cartBtn;
    clickTarget.click();

    // 等待 SKU 弹窗出现（最多 3 秒）
    const cartStart = Date.now();
    while (Date.now() - cartStart < 3000) {
      dialog = document.querySelector('#skuSelector');
      if (dialog) break;
      await sleep(200);
    }
  }

  // === 第二步：购物车没弹窗 → 区分视频卡片 / 普通卡片 ===
  if (!dialog) {
    const hasVideo = itemEl.querySelector('video') !== null;

    if (hasVideo) {
      // 视频卡片：购物车也没弹窗，且 hover 会播放视频导致跳转，直接跳过
      console.log('视频卡片，购物车未弹窗，跳过以避免页面跳转');
      throw new Error('VIDEO_CARD_SKIP');
    }

    // 非视频卡片：hover 后等待 Quick look 按钮出现并点击
    console.log('购物车未弹窗且非视频卡片，尝试 hover → Quick look');
    const hoverRect = itemEl.getBoundingClientRect();
    const hoverCx = hoverRect.left + hoverRect.width / 2;
    const hoverCy = hoverRect.top + hoverRect.height / 2;
    const hoverOpts = { bubbles: true, cancelable: true, clientX: hoverCx, clientY: hoverCy };
    itemEl.dispatchEvent(new MouseEvent('mouseenter', hoverOpts));
    itemEl.dispatchEvent(new MouseEvent('mouseover', hoverOpts));
    await sleep(800);

    // 查找 Quick look 按钮
    let quickLookBtn = null;
    const allButtons = itemEl.querySelectorAll('button, [role="button"]');
    for (const btn of allButtons) {
      const btnText = (btn.textContent || '').trim().toLowerCase();
      if (btnText.includes('quick look') || btnText.includes('quicklook') || btnText.includes('quick_look')) {
        quickLookBtn = btn;
        break;
      }
    }
    if (!quickLookBtn) {
      quickLookBtn = itemEl.querySelector('[aria-label="Quick look"]')
        || itemEl.querySelector('[aria-label="quick look"]')
        || itemEl.querySelector('[aria-label="Quick Look"]');
    }

    // 取消 hover
    itemEl.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
    itemEl.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));

    if (!quickLookBtn) {
      console.log('Quick look 按钮也未找到，放弃该商品');
      throw new Error('NO_SKU_DIALOG');
    }

    // 点击 Quick look（完整鼠标事件序列）
    const qlRect = quickLookBtn.getBoundingClientRect();
    const qlCx = qlRect.left + qlRect.width / 2;
    const qlCy = qlRect.top + qlRect.height / 2;
    const clickOpts = { bubbles: true, cancelable: true, clientX: qlCx, clientY: qlCy, button: 0 };
    quickLookBtn.dispatchEvent(new MouseEvent('mousedown', clickOpts));
    quickLookBtn.dispatchEvent(new MouseEvent('mouseup', clickOpts));
    quickLookBtn.dispatchEvent(new MouseEvent('click', clickOpts));

    // 等待 SKU 弹窗出现（最多 4 秒）
    const qlStart = Date.now();
    while (Date.now() - qlStart < 4000) {
      dialog = document.querySelector('#skuSelector');
      if (dialog) break;
      await sleep(200);
    }

    if (!dialog) {
      console.log('Quick look 点击后弹窗仍未出现');
      throw new Error('NO_SKU_DIALOG');
    }
  }

  // ④ 等待图片加载（额外等 1200ms，确保懒加载图片就绪）
  await sleep(1200);

  // 提取图片URL的通用函数（支持 <img>、background-image、<picture>/<source>、data-bg 等多种 DOM 结构）
  function extractImageUrl(el) {
    if (!el) return null;

    function cleanUrl(url) {
      if (!url || url.includes('data:') || url.includes('svg')) return null;
      try {
        const parsed = new URL(url);
        return parsed.origin + parsed.pathname + parsed.search;
      } catch {
        return url;
      }
    }

    // 策略1：优先从 <img> 标签提取（直接子级或递归查找）
    const img = el.tagName === 'IMG' ? el : el.querySelector('img');
    if (img) {
      const url = img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-lazy-src');
      const result = cleanUrl(url);
      if (result) return result;
    }

    // 策略2：<picture> 内的 <source> 标签（srcset）
    const source = el.querySelector('picture source, source');
    if (source) {
      const srcset = source.getAttribute('srcset') || '';
      // srcset 可能包含多个 URL + 宽度描述符，取第一个
      const firstSrc = srcset.split(',')[0]?.trim()?.split(/\s+/)[0];
      const result = cleanUrl(firstSrc);
      if (result) return result;
    }

    // 策略3：background-image（递归查找任何带 background-image 的子元素）
    const bgCandidates = el.tagName === 'DIV' ? [el] : [];
    bgCandidates.push(...el.querySelectorAll('[style*="background-image"], [style*="background:"]'));
    for (const bgEl of bgCandidates) {
      const style = bgEl.getAttribute('style') || '';
      const bgMatch = style.match(/background(?:-image)?\s*:[^;]*url\(["']?([^"')]+)["']?\)/);
      if (bgMatch && bgMatch[1]) {
        const result = cleanUrl(bgMatch[1]);
        if (result) return result;
      }
    }

    // 策略4：data-bg / data-background 等自定义属性
    const dataEl = el.querySelector('[data-bg], [data-background], [data-image]') || el;
    const dataBg = dataEl.getAttribute('data-bg') || dataEl.getAttribute('data-background') || dataEl.getAttribute('data-image');
    if (dataBg) {
      const result = cleanUrl(dataBg);
      if (result) return result;
    }

    return null;
  }

  // ⑤ 锁定初始主图：找到默认选中的缩略图
  let trueMainImageUrl = null;
  const selectedOption = dialog.querySelector('div[role="option"][aria-selected="true"]');
  if (!selectedOption && dialog.parentElement) {
    // 向上一级查找
    const selectedOption2 = dialog.parentElement.querySelector('div[role="option"][aria-selected="true"]');
    if (selectedOption2) {
      trueMainImageUrl = extractImageUrl(selectedOption2);
    }
  } else if (selectedOption) {
    trueMainImageUrl = extractImageUrl(selectedOption);
  }
  console.log(`[轮播图] 默认选中缩略图（trueMainImageUrl）: ${trueMainImageUrl}`);

  // ⑥ 抓取全量图片数组：遍历所有 div[role="option"]
  const images = [];
  const seen = new Set();
  let allOptions = Array.from(dialog.querySelectorAll('div[role="option"]'));
  if (allOptions.length === 0 && dialog.parentElement) {
    allOptions = Array.from(dialog.parentElement.querySelectorAll('div[role="option"]'));
  }

  // 如果 option 没有 data-index，按 DOM 顺序；有 data-index 则按数值排序
  const hasDataIndex = allOptions.some(el => el.dataset.index !== undefined);
  if (hasDataIndex) {
    allOptions.sort((a, b) => parseInt(a.dataset.index || '0') - parseInt(b.dataset.index || '0'));
  }

  allOptions.forEach(option => {
    const cleanUrl = extractImageUrl(option);
    if (cleanUrl && !seen.has(cleanUrl)) {
      seen.add(cleanUrl);
      images.push(cleanUrl);
    }
  });
  console.log(`[轮播图] 从 div[role="option"] 提取 ${images.length} 张图片:`, images);

  // 兜底：如果 div[role="option"] 没拿到图，回退到旧的 listbox + ol li 双源策略
  if (images.length === 0) {
    console.log(`[轮播图] div[role="option"] 无结果，尝试 listbox/ol li 兜底`);

    // 来源A：div[role="listbox"] 缩略图
    const listboxImages = [];
    const listboxSeen = new Set();
    let thumbnailDivs = Array.from(dialog.querySelectorAll('div[role="listbox"] div[data-index]'));
    if (thumbnailDivs.length === 0 && dialog.parentElement) {
      thumbnailDivs = Array.from(dialog.parentElement.querySelectorAll('div[role="listbox"] div[data-index]'));
    }
    thumbnailDivs.sort((a, b) => parseInt(a.dataset.index) - parseInt(b.dataset.index));
    thumbnailDivs.forEach(div => {
      const cleanUrl = extractImageUrl(div);
      if (cleanUrl && !listboxSeen.has(cleanUrl)) {
        listboxSeen.add(cleanUrl);
        listboxImages.push(cleanUrl);
      }
    });

    // 来源B：ol li[data-index] 主图轮播
    const carouselImages = [];
    const carouselSeen = new Set();
    let mainLis = Array.from(dialog.querySelectorAll('ol li[data-index]'));
    if (mainLis.length === 0 && dialog.parentElement) {
      mainLis = Array.from(dialog.parentElement.querySelectorAll('ol li[data-index]'));
    }
    mainLis.sort((a, b) => parseInt(a.dataset.index) - parseInt(b.dataset.index));
    mainLis.forEach(li => {
      const cleanUrl = extractImageUrl(li);
      if (cleanUrl && !carouselSeen.has(cleanUrl)) {
        carouselSeen.add(cleanUrl);
        carouselImages.push(cleanUrl);
      }
    });

    const fallback = (carouselImages.length >= listboxImages.length && carouselImages.length > 0)
      ? carouselImages : listboxImages;
    fallback.forEach(url => { if (!seen.has(url)) { seen.add(url); images.push(url); } });
    console.log(`[轮播图] 兜底结果: ${images.length} 张`);
  }

  console.log(`[轮播图] 最终提取 ${images.length} 张:`, images);

  // ⑦ 校准：确保 trueMainImageUrl 排在第一位
  if (images.length > 1 && trueMainImageUrl) {
    let matchIndex = -1;
    const refBase = trueMainImageUrl.split('?')[0];
    const refFileName = refBase.split('/').pop();
    const refBaseName = refFileName.replace(/\.[^.]+$/, '');
    const normalizedRef = refBase
      .replace(/\/w\/\d+\//g, '/')
      .replace(/\/q\/\d+\//g, '/')
      .replace(/\/h\/\d+\//g, '/');

    for (let i = 0; i < images.length; i++) {
      const imgBase = images[i].split('?')[0];
      const imgFileName = imgBase.split('/').pop();
      // 策略1：精确匹配文件名
      if (imgFileName === refFileName) { matchIndex = i; break; }
      // 策略2：基础名匹配（忽略扩展名差异）
      const imgBaseName = imgFileName.replace(/\.[^.]+$/, '');
      if (refBaseName && imgBaseName && refBaseName === imgBaseName) { matchIndex = i; break; }
      // 策略3：归一化路径匹配
      const normalizedImg = imgBase
        .replace(/\/w\/\d+\//g, '/')
        .replace(/\/q\/\d+\//g, '/')
        .replace(/\/h\/\d+\//g, '/');
      if (normalizedRef === normalizedImg) { matchIndex = i; break; }
    }

    if (matchIndex > 0) {
      console.log(`[轮播图] 主图在位置 ${matchIndex}，移到第一位`);
      const mainImage = images.splice(matchIndex, 1)[0];
      images.unshift(mainImage);
    } else if (matchIndex === 0) {
      console.log(`[轮播图] 主图已在首位，无需调整`);
    } else {
      console.log(`[轮播图] trueMainImageUrl 未在 images 中匹配到，保持原始顺序`);
    }
  }

  // ⑧ 关闭弹窗
  await closeSkuDialog();

  console.log(`从 SKU 弹窗提取到 ${images.length} 张轮播图`);
  return images.length > 0 ? images : null;
}

// 延迟函数
// 反检测：覆盖 document.hidden 和 visibilityState，防止 Temu 页面因失焦暂停渲染
let _antiVisibilityListener = null;

function enableAntiVisibilityDetection() {
  // 覆盖 document.hidden → 永远返回 false
  Object.defineProperty(document, 'hidden', {
    get: () => false,
    configurable: true
  });

  // 覆盖 visibilityState → 永远返回 "visible"
  Object.defineProperty(document, 'visibilityState', {
    get: () => 'visible',
    configurable: true
  });

  // 拦截 visibilitychange 事件，阻止页面感知失焦
  _antiVisibilityListener = (e) => {
    e.stopImmediatePropagation();
  };
  document.addEventListener('visibilitychange', _antiVisibilityListener, true);

  console.log('[反检测] 已启用 visibility 反检测');
}

function disableAntiVisibilityDetection() {
  // 恢复原始行为
  delete document.hidden;
  delete document.visibilityState;

  if (_antiVisibilityListener) {
    document.removeEventListener('visibilitychange', _antiVisibilityListener, true);
    _antiVisibilityListener = null;
  }

  console.log('[反检测] 已恢复 visibility 检测');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 显示采集遮罩层
function showScrapingOverlay() {
  // 检查是否已存在
  let overlay = document.getElementById('temu-scraping-overlay');
  if (overlay) return;

  overlay = document.createElement('div');
  overlay.id = 'temu-scraping-overlay';
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.3);
    z-index: 9999998;
    pointer-events: auto;
    backdrop-filter: blur(2px);
  `;

  // 阻止滚轮事件
  overlay.addEventListener('wheel', (e) => {
    e.preventDefault();
    e.stopPropagation();
  }, { passive: false });

  // 阻止触摸滚动
  overlay.addEventListener('touchmove', (e) => {
    e.preventDefault();
    e.stopPropagation();
  }, { passive: false });

  // 添加提示文字
  const hint = document.createElement('div');
  hint.style.cssText = `
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: rgba(0, 0, 0, 0.8);
    color: #ffd700;
    padding: 20px 40px;
    border-radius: 10px;
    font-size: 16px;
    font-weight: 600;
    text-align: center;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
    pointer-events: none;
  `;
  hint.innerHTML = '小狮子正在采集中，请勿操作页面...<br><span style="font-size: 12px; color: rgba(255, 215, 0, 0.7); margin-top: 8px; display: block;">可以使用悬浮窗和日志窗口</span>';
  overlay.appendChild(hint);

  document.body.appendChild(overlay);

  // 禁止页面滚动
  document.body.style.overflow = 'hidden';
}

// 隐藏采集遮罩层
function hideScrapingOverlay() {
  const overlay = document.getElementById('temu-scraping-overlay');
  if (overlay) {
    overlay.remove();
  }
  // 恢复页面滚动
  document.body.style.overflow = '';
}

// 停止获取
function stopScraping() {
  isScrapingActive = false;
  console.log('停止获取');
  addLog('⏹️ 用户停止获取', 'warning');
  document.getElementById('panel-status').innerHTML = `状态: 已停止<br>已获取: ${scrapedData.length}`;
  updateToggleButton();
  showToast('已停止获取', 'info');
  // 隐藏遮罩层
  hideScrapingOverlay();

  // 保存数据
  saveDataToStorage();
}

// 预览数据
function previewData() {
  if (scrapedData.length === 0) {
    showToast('暂无数据可预览', 'warning');
    return;
  }

  let currentPreviewPage = 1;
  const itemsPerPage = 140;
  const totalPages = Math.ceil(scrapedData.length / itemsPerPage);

  // 创建预览窗口
  const previewWindow = document.createElement('div');
  previewWindow.id = 'temu-preview-window';

  // 渲染预览内容
  function renderPreview() {
    const startIndex = (currentPreviewPage - 1) * itemsPerPage;
    const endIndex = Math.min(startIndex + itemsPerPage, scrapedData.length);
    const currentPageData = scrapedData.slice(startIndex, endIndex);

    previewWindow.innerHTML = `
      <div class="temu-preview-overlay"></div>
      <div class="temu-preview-content">
        <div class="temu-preview-header">
          <div class="temu-preview-header-left">
            <h3>数据预览 (共 ${scrapedData.length} 条)</h3>
            <span class="temu-preview-selected-count" id="selectedCount">已选择: 0</span>
          </div>
          <div class="temu-preview-actions">
            <button class="temu-preview-btn temu-preview-select-all" id="selectAllBtn">全选</button>
            <button class="temu-preview-btn temu-preview-invert" id="invertBtn">反选</button>
            <button class="temu-preview-btn temu-preview-delete" id="deleteSelectedBtn">删除选中</button>
            <div class="temu-preview-pagination-inline">
              <button class="temu-preview-page-btn" id="firstPageBtn" ${currentPreviewPage === 1 ? 'disabled' : ''}>首页</button>
              <button class="temu-preview-page-btn" id="prevPageBtn" ${currentPreviewPage === 1 ? 'disabled' : ''}>上一页</button>
              <span class="temu-preview-page-info">第 ${currentPreviewPage}/${totalPages} 页 (${startIndex + 1}-${endIndex})</span>
              <button class="temu-preview-page-btn" id="nextPageBtn" ${currentPreviewPage === totalPages ? 'disabled' : ''}>下一页</button>
              <button class="temu-preview-page-btn" id="lastPageBtn" ${currentPreviewPage === totalPages ? 'disabled' : ''}>末页</button>
            </div>
            <button class="temu-preview-btn temu-preview-export" id="previewExportBtn">↓ 导出</button>
            <button class="temu-preview-close">×</button>
          </div>
        </div>
        <div class="temu-preview-body">
          <div class="temu-preview-grid">
            ${currentPageData.map((item, index) => {
              const actualIndex = startIndex + index;
              const hasCarousel = item.images && item.images.length > 1;
              const imgSrc = hasCarousel ? item.images[0] : (item.image && item.image !== 'no-image' ? item.image : '');
              const imgCount = item.images ? item.images.length : (imgSrc ? 1 : 0);
              return `
                <div class="temu-preview-card" data-index="${actualIndex}">
                  <input type="checkbox" class="temu-preview-checkbox" data-index="${actualIndex}">
                  <div class="temu-preview-card-image" style="position:relative; overflow:hidden;">
                    ${imgSrc
                      ? `<img src="${imgSrc}" alt="${item.title}" data-img-index="0" onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22200%22 height=%22200%22%3E%3Crect fill=%22%23f0f0f0%22 width=%22200%22 height=%22200%22/%3E%3Ctext x=%2250%25%22 y=%2250%25%22 text-anchor=%22middle%22 dy=%22.3em%22 fill=%22%23999%22 font-size=%2214%22%3E无图片%3C/text%3E%3C/svg%3E'">`
                      : `<div class="temu-preview-no-image">无图片</div>`}
                    ${hasCarousel ? `
                      <button class="temu-carousel-btn temu-carousel-prev" data-card-index="${actualIndex}" title="上一张">‹</button>
                      <button class="temu-carousel-btn temu-carousel-next" data-card-index="${actualIndex}" title="下一张">›</button>
                      <span class="temu-carousel-counter">1/${imgCount}</span>
                    ` : (imgCount === 1 ? `<span class="temu-carousel-counter">1张</span>` : '')}
                  </div>
                  <div class="temu-preview-card-info">
                    <div class="temu-preview-card-title" title="${item.title}">${item.title}</div>
                    <div class="temu-preview-card-meta">
                      <div class="temu-preview-card-price">${item.price || '价格未知'}</div>
                      <div class="temu-preview-card-sales">销量: ${item.salesText || item.sales || '0'}</div>
                    </div>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      </div>
    `;

    // 绑定事件
    bindPreviewEvents();
  }

  // 绑定事件
  function bindPreviewEvents() {
    // 更新选择数量显示
    function updateSelectedCount() {
      const checkboxes = previewWindow.querySelectorAll('.temu-preview-checkbox:checked');
      const selectedCount = previewWindow.querySelector('#selectedCount');
      if (selectedCount) {
        selectedCount.textContent = `已选择: ${checkboxes.length}`;
      }
    }

    // 监听所有复选框的变化
    const checkboxes = previewWindow.querySelectorAll('.temu-preview-checkbox');
    checkboxes.forEach(cb => {
      cb.addEventListener('change', updateSelectedCount);
    });

    // 全选按钮
    const selectAllBtn = previewWindow.querySelector('#selectAllBtn');
    selectAllBtn.addEventListener('click', () => {
      const checkboxes = previewWindow.querySelectorAll('.temu-preview-checkbox');
      const allChecked = Array.from(checkboxes).every(cb => cb.checked);
      checkboxes.forEach(cb => cb.checked = !allChecked);
      selectAllBtn.textContent = allChecked ? '全选' : '取消全选';
      updateSelectedCount();
    });

    // 反选按钮
    previewWindow.querySelector('#invertBtn').addEventListener('click', () => {
      const checkboxes = previewWindow.querySelectorAll('.temu-preview-checkbox');
      checkboxes.forEach(cb => cb.checked = !cb.checked);
      updateSelectedCount();
    });

    // 删除选中按钮
    previewWindow.querySelector('#deleteSelectedBtn').addEventListener('click', () => {
      const checkboxes = previewWindow.querySelectorAll('.temu-preview-checkbox:checked');
      if (checkboxes.length === 0) {
        showToast('请先选择要删除的商品', 'warning');
        return;
      }

      showConfirm(`确定要删除选中的 ${checkboxes.length} 条商品数据吗？`, async () => {
        // 获取要删除的索引（从大到小排序，避免删除时索引错乱）
        const indicesToDelete = Array.from(checkboxes)
          .map(cb => parseInt(cb.dataset.index))
          .sort((a, b) => b - a);

        // 删除数据
        indicesToDelete.forEach(index => {
          const item = scrapedData[index];
          if (item) {
            collectedIds.delete(item.id);
            scrapedData.splice(index, 1);
          }
        });

        // 保存数据
        await saveDataToStorage();
        updateStatusDisplay();

        showToast(`已删除 ${checkboxes.length} 条商品`, 'success');

        // 重新渲染预览
        const newTotalPages = Math.ceil(scrapedData.length / itemsPerPage);
        if (currentPreviewPage > newTotalPages) {
          currentPreviewPage = Math.max(1, newTotalPages);
        }

        if (scrapedData.length === 0) {
          previewWindow.remove();
        } else {
          renderPreview();
        }
      });
    });

    // 导出按钮
    previewWindow.querySelector('#previewExportBtn').addEventListener('click', () => {
      const checkboxes = previewWindow.querySelectorAll('.temu-preview-checkbox:checked');

      // 如果有选中的商品，导出选中的；否则导出全部
      let dataToExport;
      if (checkboxes.length > 0) {
        const selectedIndices = Array.from(checkboxes).map(cb => parseInt(cb.dataset.index));
        dataToExport = selectedIndices.map(index => scrapedData[index]).filter(item => item);
      } else {
        dataToExport = scrapedData;
      }

      if (dataToExport.length === 0) {
        showToast('暂无数据可导出', 'warning');
        return;
      }

      // 导出为TXT格式: ID-----图片1URL-----图片2URL-----...-----标题
      let txtContent = '';
      dataToExport.forEach(item => {
        const images = (item.images && item.images.length > 0 ? item.images : [item.image])
          .map(url => url.split('?')[0]);
        txtContent += `${item.id}-----${images.join('-----')}-----${item.title}\n`;
      });

      const blob = new Blob([txtContent], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `temu_data_${new Date().getTime()}.txt`;
      a.click();
      URL.revokeObjectURL(url);

      const exportMsg = checkboxes.length > 0
        ? `成功导出选中的 ${dataToExport.length} 条商品数据`
        : `成功导出全部 ${dataToExport.length} 条商品数据`;
      showToast(exportMsg, 'success');
    });

    // 分页按钮
    const firstPageBtn = previewWindow.querySelector('#firstPageBtn');
    const prevPageBtn = previewWindow.querySelector('#prevPageBtn');
    const nextPageBtn = previewWindow.querySelector('#nextPageBtn');
    const lastPageBtn = previewWindow.querySelector('#lastPageBtn');

    firstPageBtn?.addEventListener('click', () => {
      currentPreviewPage = 1;
      renderPreview();
    });

    prevPageBtn?.addEventListener('click', () => {
      if (currentPreviewPage > 1) {
        currentPreviewPage--;
        renderPreview();
      }
    });

    nextPageBtn?.addEventListener('click', () => {
      if (currentPreviewPage < totalPages) {
        currentPreviewPage++;
        renderPreview();
      }
    });

    lastPageBtn?.addEventListener('click', () => {
      currentPreviewPage = totalPages;
      renderPreview();
    });

    // 关闭按钮
    previewWindow.querySelector('.temu-preview-close').addEventListener('click', () => {
      previewWindow.remove();
    });

    // 点击遮罩关闭
    previewWindow.querySelector('.temu-preview-overlay').addEventListener('click', () => {
      previewWindow.remove();
    });

    // 图片点击放大
    const images = previewWindow.querySelectorAll('.temu-preview-card-image img');
    images.forEach(img => {
      img.addEventListener('click', (e) => {
        e.stopPropagation();
        showImageModal(img.src);
      });
    });

    // 轮播图左右切换按钮
    previewWindow.querySelectorAll('.temu-carousel-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const cardIndex = parseInt(btn.dataset.cardIndex);
        const item = scrapedData[cardIndex];
        if (!item || !item.images || item.images.length <= 1) return;

        const card = previewWindow.querySelector(`.temu-preview-card[data-index="${cardIndex}"]`);
        if (!card) return;

        const img = card.querySelector('.temu-preview-card-image img');
        const counter = card.querySelector('.temu-carousel-counter');
        if (!img) return;

        let currentIdx = parseInt(img.dataset.imgIndex) || 0;
        if (btn.classList.contains('temu-carousel-next')) {
          currentIdx = (currentIdx + 1) % item.images.length;
        } else {
          currentIdx = (currentIdx - 1 + item.images.length) % item.images.length;
        }

        img.dataset.imgIndex = currentIdx;
        img.src = item.images[currentIdx];
        if (counter) counter.textContent = `${currentIdx + 1}/${item.images.length}`;
      });
    });
  }

  // 初始渲染
  document.body.appendChild(previewWindow);
  renderPreview();
}

// 显示图片放大模态框
function showImageModal(imageSrc) {
  const modal = document.createElement('div');
  modal.id = 'temu-image-modal';
  modal.innerHTML = `
    <div class="temu-image-modal-overlay"></div>
    <div class="temu-image-modal-content">
      <button class="temu-image-modal-close">×</button>
      <img src="${imageSrc}" alt="商品大图">
      <div class="temu-image-zoom-hint">滚轮缩放 | 点击关闭</div>
    </div>
  `;

  document.body.appendChild(modal);

  const img = modal.querySelector('img');
  const container = modal.querySelector('.temu-image-modal-content');

  let scale = 1;

  container.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    const newScale = Math.max(0.5, Math.min(3, scale + delta));
    if (newScale !== scale) {
      scale = newScale;
      img.style.transform = `scale(${scale})`;
    }
  }, { passive: false });

  function closeModal() {
    modal.remove();
  }

  modal.querySelector('.temu-image-modal-close').addEventListener('click', closeModal);
  modal.querySelector('.temu-image-modal-overlay').addEventListener('click', closeModal);
  img.addEventListener('click', closeModal);
}

// 清空数据
async function clearData() {
  if (scrapedData.length === 0) {
    showToast('当前没有数据', 'info');
    return;
  }

  showConfirm(`确定要清空已获取的 ${scrapedData.length} 条数据吗？<br>此操作不可恢复！`, async () => {
    scrapedData = [];
    collectedIds.clear();
    currentPage = 0;
    await clearStorageData();
    updateStatusDisplay();
    console.log('数据已清空');
    showToast('数据已清空', 'success');
  });
}

// 导出数据
async function exportData() {
  if (scrapedData.length === 0) {
    showToast('暂无数据可导出', 'warning');
    return;
  }

  // 导出为TXT格式: ID-----图片1URL-----图片2URL-----...-----标题
  let txtContent = '';
  scrapedData.forEach(item => {
    const images = (item.images && item.images.length > 0 ? item.images : [item.image])
      .map(url => url.split('?')[0]);
    txtContent += `${item.id}-----${images.join('-----')}-----${item.title}\n`;
  });

  const blob = new Blob([txtContent], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `temu_data_${new Date().getTime()}.txt`;
  a.click();
  URL.revokeObjectURL(url);

  console.log('导出数据', scrapedData.length, '条');
  showToast(`成功导出 ${scrapedData.length} 条商品数据`, 'success');
}

// 初始化
if (window.location.hostname.includes('temu.com')) {
  createFloatButton();
  createPanel();

  // 页面加载时恢复数据
  loadDataFromStorage();

  // 恢复面板状态
  chrome.storage.local.get(['panelOpen'], (result) => {
    if (result.panelOpen) {
      // 延迟一下确保DOM已加载
      setTimeout(() => {
        showPanel();
      }, 100);
    }
  });

  // 防止页面变化影响悬浮窗位置
  const observer = new MutationObserver(() => {
    const floatBtn = document.getElementById('temu-scraper-float-btn');
    const panel = document.getElementById('temu-scraper-panel');

    // 确保悬浮球和面板始终存在且样式正确
    if (floatBtn && !document.body.contains(floatBtn)) {
      document.body.appendChild(floatBtn);
    }
    if (panel && !document.body.contains(panel)) {
      document.body.appendChild(panel);
    }
  });

  // 监听body的变化
  observer.observe(document.body, {
    childList: true,
    subtree: false
  });
}

// ==================== 登录功能 ====================

// 通过 background 发送 API 请求
async function sendApiRequest(url, options) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { action: 'apiRequest', url, options },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (response.success) {
          resolve(response.data.data);
        } else {
          reject(new Error(response.error));
        }
      }
    );
  });
}

// 认证API配置
const AUTH_CONFIG = { baseUrl: '', loginUrl: '', registerUrl: '' };

// 登录API
async function loginAPI(account, password) {
  return { success: true, message: '工作台买断授权已启用', expireTime: 8640000000000000 };
}

// 注册API
async function registerAPI(account, password, name = '') {
  return { success: true, message: '工作台买断授权已启用，无需注册' };
}

// 检查登录状态
async function checkAuth() {
  return { isLoggedIn: true, account: '工作台买断授权', expireTime: 8640000000000000 };
}

// 重新验证登录
async function revalidateAuth() {
  return checkAuth();
}

// 退出登录
async function logoutUser() {
  // Buyout-license mode has no remote session and stores no password.
}

// 更新登录状态显示
async function updateLoginStatus() {
  const loginInfo = document.getElementById('panel-loginInfo');
  if (!loginInfo) return;

  const authStatus = await checkAuth();

  if (authStatus.isLoggedIn) {
    const expireDate = new Date(authStatus.expireTime);
    loginInfo.innerHTML = `
      <span class="temu-login-text">账号: ${authStatus.account}</span>
      <button class="temu-btn temu-btn-logout" id="panel-logoutBtn">退出</button>
    `;

    // 绑定退出按钮事件
    const logoutBtn = document.getElementById('panel-logoutBtn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', async () => {
        showConfirm('确定要退出登录吗？', async () => {
          await logoutUser();
          updateLoginStatus();
          showToast('已退出登录', 'info');
        });
      });
    }
  } else {
    loginInfo.innerHTML = `
      <span class="temu-login-text">未登录</span>
      <button class="temu-btn temu-btn-login" id="panel-loginBtn">登录</button>
    `;

    // 重新绑定登录按钮事件
    const loginBtn = document.getElementById('panel-loginBtn');
    if (loginBtn) {
      loginBtn.addEventListener('click', showLoginDialog);
    }
  }
}

// 显示登录对话框
function showLoginDialog() {
  // 创建登录对话框
  const loginDialog = document.createElement('div');
  loginDialog.id = 'temu-login-dialog';
  loginDialog.innerHTML = `
    <div class="temu-dialog-overlay"></div>
    <div class="temu-dialog-box">
      <div class="temu-dialog-header">
        <h3>账号登录</h3>
        <span class="temu-dialog-close">×</span>
      </div>
      <div class="temu-dialog-body">
        <div class="temu-form-item">
          <label>账号</label>
          <input type="text" id="login-account" placeholder="请输入账号" class="temu-form-input">
        </div>
        <div class="temu-form-item">
          <label>密码</label>
          <input type="password" id="login-password" placeholder="请输入密码" class="temu-form-input">
        </div>
        <div class="temu-error-message" id="login-error"></div>
      </div>
      <div class="temu-dialog-footer">
        <button class="temu-btn temu-btn-secondary" id="login-register-btn">注册账号</button>
        <button class="temu-btn temu-btn-primary" id="login-submit-btn">登录</button>
      </div>
    </div>
  `;

  document.body.appendChild(loginDialog);

  // 关闭按钮
  loginDialog.querySelector('.temu-dialog-close').addEventListener('click', () => {
    loginDialog.remove();
  });

  // 点击遮罩关闭
  loginDialog.querySelector('.temu-dialog-overlay').addEventListener('click', () => {
    loginDialog.remove();
  });

  // 注册按钮
  loginDialog.querySelector('#login-register-btn').addEventListener('click', () => {
    loginDialog.remove();
    showRegisterDialog();
  });

  // 登录按钮
  loginDialog.querySelector('#login-submit-btn').addEventListener('click', async () => {
    const account = document.getElementById('login-account').value.trim();
    const password = document.getElementById('login-password').value.trim();
    const errorEl = document.getElementById('login-error');
    const submitBtn = document.getElementById('login-submit-btn');

    if (!account || !password) {
      errorEl.textContent = '请输入账号和密码';
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = '登录中...';
    errorEl.textContent = '';

    const result = await loginAPI(account, password);

    if (result.success) {
      showToast('登录成功', 'success');
      loginDialog.remove();
      updateLoginStatus();
    } else {
      errorEl.textContent = result.message;
      submitBtn.disabled = false;
      submitBtn.textContent = '登录';
    }
  });

  // 回车登录
  loginDialog.querySelector('#login-password').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      loginDialog.querySelector('#login-submit-btn').click();
    }
  });
}

// 显示注册对话框
function showRegisterDialog() {
  // 创建注册对话框
  const registerDialog = document.createElement('div');
  registerDialog.id = 'temu-register-dialog';
  registerDialog.innerHTML = `
    <div class="temu-dialog-overlay"></div>
    <div class="temu-dialog-box">
      <div class="temu-dialog-header">
        <h3>账号注册</h3>
        <span class="temu-dialog-close">×</span>
      </div>
      <div class="temu-dialog-body">
        <div class="temu-form-item">
          <label>账号</label>
          <input type="text" id="register-account" placeholder="请输入账号" class="temu-form-input">
        </div>
        <div class="temu-form-item">
          <label>密码</label>
          <input type="password" id="register-password" placeholder="请输入密码" class="temu-form-input">
        </div>
        <div class="temu-form-item">
          <label>名称（可选）</label>
          <input type="text" id="register-name" placeholder="请输入名称" class="temu-form-input">
        </div>
        <div class="temu-info-message">注册成功后需要管理员开通才能使用</div>
        <div class="temu-error-message" id="register-error"></div>
      </div>
      <div class="temu-dialog-footer">
        <button class="temu-btn temu-btn-secondary" id="register-login-btn">返回登录</button>
        <button class="temu-btn temu-btn-primary" id="register-submit-btn">注册</button>
      </div>
    </div>
  `;

  document.body.appendChild(registerDialog);

  // 关闭按钮
  registerDialog.querySelector('.temu-dialog-close').addEventListener('click', () => {
    registerDialog.remove();
  });

  // 点击遮罩关闭
  registerDialog.querySelector('.temu-dialog-overlay').addEventListener('click', () => {
    registerDialog.remove();
  });

  // 返回登录按钮
  registerDialog.querySelector('#register-login-btn').addEventListener('click', () => {
    registerDialog.remove();
    showLoginDialog();
  });

  // 注册按钮
  registerDialog.querySelector('#register-submit-btn').addEventListener('click', async () => {
    const account = document.getElementById('register-account').value.trim();
    const password = document.getElementById('register-password').value.trim();
    const name = document.getElementById('register-name').value.trim();
    const errorEl = document.getElementById('register-error');
    const submitBtn = document.getElementById('register-submit-btn');

    if (!account || !password) {
      errorEl.textContent = '请输入账号和密码';
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = '注册中...';
    errorEl.textContent = '';

    const result = await registerAPI(account, password, name);

    if (result.success) {
      showToast('注册成功！请联系管理员开通后登录', 'success', 5000);
      registerDialog.remove();
      showLoginDialog();
    } else {
      errorEl.textContent = result.message;
      submitBtn.disabled = false;
      submitBtn.textContent = '注册';
    }
  });
}
