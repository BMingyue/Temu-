// 导入认证模块
const registerForm = document.getElementById('registerForm');
const accountInput = document.getElementById('account');
const passwordInput = document.getElementById('password');
const nameInput = document.getElementById('name');
const errorMessage = document.getElementById('errorMessage');
const loginLink = document.getElementById('loginLink');

// 处理注册表单提交
registerForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const account = accountInput.value.trim();
  const password = passwordInput.value.trim();
  const name = nameInput.value.trim();

  if (!account || !password) {
    errorMessage.textContent = '请输入账号和密码';
    return;
  }

  // 禁用表单
  const submitBtn = registerForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  submitBtn.textContent = '注册中...';
  errorMessage.textContent = '';

  // 调用注册API
  const result = await register(account, password, name);

  if (result.success) {
    // 注册成功，提示并跳转到登录页面
    alert('注册成功！请联系管理员开通后登录。');
    window.location.href = 'login.html';
  } else {
    // 显示错误信息
    errorMessage.textContent = result.message;
    submitBtn.disabled = false;
    submitBtn.textContent = '注册';
  }
});

// 跳转到登录页面
loginLink.addEventListener('click', (e) => {
  e.preventDefault();
  window.location.href = 'login.html';
});
