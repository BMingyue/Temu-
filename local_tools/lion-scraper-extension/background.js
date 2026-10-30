// Background Service Worker for API requests

// 监听来自 content script 的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'apiRequest') {
    // 处理 API 请求
    handleApiRequest(request.url, request.options)
      .then(result => sendResponse({ success: true, data: result }))
      .catch(error => sendResponse({ success: false, error: error.message }));

    // 返回 true 表示异步响应
    return true;
  }
});

// 处理 API 请求
async function handleApiRequest(url, options) {
  try {
    const response = await fetch(url, options);
    const data = await response.json();
    return { status: response.status, data };
  } catch (error) {
    throw new Error(`请求失败: ${error.message}`);
  }
}
