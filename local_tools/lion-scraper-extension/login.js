// 导入认证模块
const loginForm = document.getElementById('loginForm');
const accountInput = document.getElementById('account');
const passwordInput = document.getElementById('password');
const errorMessage = document.getElementById('errorMessage');
const registerLink = document.getElementById('registerLink');

// 处理登录表单提交
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const account = accountInput.value.trim();
  const password = passwordInput.value.trim();

  if (!account || !password) {
    errorMessage.textContent = '请输入账号和密码';
    return;
  }

  // 禁用表单
  const submitBtn = loginForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  submitBtn.textContent = '登录中...';
  errorMessage.textContent = '';

  // 调用登录API
  const result = await login(account, password);

  if (result.success) {
    // 登录成功，跳转到主页面
    window.location.href = 'popup.html';
  } else {
    // 检查错误信息是否为“账号过期”或包含该关键字
    if (result.message === '账号过期' || result.message.includes('账号过期')) {
      errorMessage.textContent = '当前账号已过期，请联系管理员开通时间';
    } else {
      // 其他错误信息则直接显示后端返回的内容
      errorMessage.textContent = result.message;
    }
    
    // 恢复按钮状态
    submitBtn.disabled = false;
    submitBtn.textContent = '登录';
}
});

// 跳转到注册页面
registerLink.addEventListener('click', (e) => {
  e.preventDefault();
  window.location.href = 'register.html';
});
