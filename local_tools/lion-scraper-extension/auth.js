// Workbench buyout-license adapter.
// The purchased source no longer depends on its former remote auth service.
const WORKBENCH_LICENSE_ACCOUNT = '工作台买断授权';

async function login() {
  return { success: true, message: '工作台买断授权已启用', expireTime: 8640000000000000 };
}

async function register() {
  return { success: true, message: '工作台买断授权已启用，无需注册' };
}

async function checkLoginStatus() {
  return { isLoggedIn: true, account: WORKBENCH_LICENSE_ACCOUNT, expireTime: 8640000000000000 };
}

async function revalidateLogin() {
  return checkLoginStatus();
}

async function logout() {
  // Buyout mode intentionally remains active.
}

async function getCurrentUser() {
  return { account: WORKBENCH_LICENSE_ACCOUNT, buyoutLicense: true };
}
