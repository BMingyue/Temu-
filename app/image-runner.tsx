'use client';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
type Worker = {
  version?: string;
  browser: string;
  worker_id: string;
  channel_id?: string;
  profile_label?: string;
  online: boolean;
  status: string;
  message?: string;
  offline_reason?: string;
  last_seen?: string;
  gap_seconds?: number;
  account?: { blocked?: boolean; until: number };
  circuit?: { open?: boolean; consecutive: number; wait_seconds: number };
  metrics?: { claimed?: number; completed?: number; fallback?: number };
};
type BrowserProfile = {
  id: string;
  label: string;
  browser: string;
  worker_id?: string;
  available: boolean;
  unavailable_reason?: string;
  include_in_all: boolean;
  managed?: boolean;
  running?: boolean;
  extension_auto_load?: boolean;
  extension_version?: string;
};
type RunnerState = {
  workers?: Worker[];
  browser_profiles?: BrowserProfile[];
  browser_creation?: {
    available: boolean;
    message?: string;
    max_per_request?: number;
  };
};
type LaunchResponse = {
  ok?: boolean;
  message?: string;
  error?: string;
  results?: { id: string; ok: boolean; message: string }[];
  created?: BrowserProfile[];
  browser_profiles?: BrowserProfile[];
};
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const localTime = (value: string | number) =>
  new Date(value).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
  });
function workerStatus(row?: Worker) {
  if (!row?.online) return '未连接';
  if (row.account?.blocked) return '额度停发';
  if (row.circuit?.open) return '故障暂停';
  if (row.gap_seconds) return `冷却 ${row.gap_seconds} 秒`;
  return row.status || '已连接';
}
export default function ImageRunner() {
  const [state, setState] = useState<RunnerState>({});
  const [error, setError] = useState('');
  const [launchError, setLaunchError] = useState('');
  const [launchMessage, setLaunchMessage] = useState('');
  const [opening, setOpening] = useState('');
  const [count, setCount] = useState('1');
  const [prefix, setPrefix] = useState('Chrome 生图');
  const [showClosedProfiles, setShowClosedProfiles] = useState(false);
  useEffect(() => {
    try {
      setShowClosedProfiles(
        localStorage.getItem('workbench.gpt.showClosedProfiles') === 'true',
      );
    } catch {}
  }, []);
  function toggleClosedProfiles() {
    const next = !showClosedProfiles;
    setShowClosedProfiles(next);
    try {
      localStorage.setItem('workbench.gpt.showClosedProfiles', String(next));
    } catch {}
  }
  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const r = await fetch('/api/gpt-extension', {
          signal: AbortSignal.timeout(10000),
        });
        if (!r.ok) throw Error('暂时无法读取生图浏览器状态');
        const value = (await r.json()) as RunnerState;
        if (!cancelled) {
          setState(value);
          setError('');
        }
      } catch (e: unknown) {
        if (!cancelled) setError(errorMessage(e));
      }
    }
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
  async function request(path: string, body: object) {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Workbench': 'local' },
      body: JSON.stringify(body),
    });
    const value = (await r.json()) as LaunchResponse;
    if (!r.ok || value.ok === false)
      throw Error(value.error || value.message || '操作失败');
    return value;
  }
  function feedback(value: LaunchResponse) {
    if (value.results?.length) {
      setLaunchMessage(
        value.results
          .filter((r) => r.ok)
          .map((r) => r.message)
          .join('；'),
      );
      setLaunchError(
        value.results
          .filter((r) => !r.ok)
          .map((r) => r.message)
          .join('；'),
      );
    } else setLaunchMessage(value.message || '已请求打开，请等待插件连接');
  }
  async function openBrowser(profileId: string) {
    setOpening(profileId);
    setLaunchError('');
    setLaunchMessage('');
    try {
      feedback(
        await request('/api/gpt-browser-profiles/open', {
          profile_id: profileId,
        }),
      );
    } catch (e: unknown) {
      setLaunchError(errorMessage(e));
    } finally {
      setOpening('');
    }
  }
  async function closeBrowser(profileId: string) {
    setOpening('close:' + profileId);
    setLaunchError('');
    setLaunchMessage('');
    try {
      feedback(
        await request('/api/gpt-browser-profiles/close', {
          profile_id: profileId,
        }),
      );
    } catch (e: unknown) {
      setLaunchError(errorMessage(e));
    } finally {
      setOpening('');
    }
  }
  async function createBrowsers() {
    const amount = Number(count),
      maximum = state.browser_creation?.max_per_request || 20;
    if (!Number.isInteger(amount) || amount < 1 || amount > maximum) {
      setLaunchError(`每次可新增 1–${maximum} 个窗口，需要更多可继续新增`);
      return;
    }
    setOpening('create');
    setLaunchError('');
    setLaunchMessage('');
    try {
      const value = await request('/api/gpt-browser-profiles/create', {
        count: amount,
        label_prefix: prefix.trim() || 'Chrome 生图',
      });
      if (value.browser_profiles)
        setState((previous) => ({
          ...previous,
          browser_profiles: value.browser_profiles,
        }));
      const results = [];
      for (const profile of value.created || []) {
        try {
          const opened = await request('/api/gpt-browser-profiles/open', {
            profile_id: profile.id,
          });
          results.push({
            id: profile.id,
            ok: true,
            message: opened.message || profile.label + ' 已打开',
          });
        } catch (e: unknown) {
          results.push({
            id: profile.id,
            ok: false,
            message: profile.label + '：' + errorMessage(e),
          });
        }
      }
      feedback(results.length ? { results } : value);
    } catch (e: unknown) {
      setLaunchError(errorMessage(e));
    } finally {
      setOpening('');
    }
  }
  async function openFolder() {
    try {
      setError('');
      await request('/api/launch', { tool: 'gpt_extension_folder' });
    } catch (e: unknown) {
      setError(errorMessage(e));
    }
  }
  const profiles = state.browser_profiles || [];
  const workers = (state.workers || []).map((worker) => {
    const profile = profiles.find(
      (p) => p.browser === worker.browser && p.worker_id === worker.worker_id,
    );
    return profile?.managed && profile.running === false
      ? { ...worker, online: false }
      : worker;
  });
  const chrome = profiles.filter((p) => p.browser === 'chrome'),
    legacy = profiles.filter((p) => p.browser !== 'chrome');
  const closedCount = chrome.filter(
    (p) => p.managed && p.running === false,
  ).length;
  const visibleChrome = chrome.filter(
    (p) => showClosedProfiles || !p.managed || p.running !== false,
  );
  const unmatched = workers.filter(
    (w) =>
      !profiles.some(
        (p) => p.browser === w.browser && p.worker_id === w.worker_id,
      ),
  );
  function profileCard(profile: BrowserProfile) {
    const row = workers.find(
      (w) => w.browser === profile.browser && w.worker_id === profile.worker_id,
    );
    const metric = row?.metrics || {},
      quota = row?.account;
    const ready =
      row?.online &&
      !quota?.blocked &&
      !row.circuit?.open &&
      !/登录|未识别|需要处理|不匹配/.test(row.status);
    return (
      <article
        key={profile.id}
        style={{
          border: '1px solid var(--line, #dce3ec)',
          borderRadius: 12,
          padding: 16,
          background: '#fff',
          minWidth: 0,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
          }}
        >
          <strong style={{ overflowWrap: 'anywhere' }}>{profile.label}</strong>
          <span className={'tag ' + (ready ? 'green' : 'amber')}>
            {profile.managed && profile.running === false
              ? '已关闭'
              : workerStatus(row)}
          </span>
        </div>
        <p className="panelnote" style={{ margin: '10px 0 6px' }}>
          {profile.extension_auto_load
            ? `插件随启动自动加载${row?.online && row.version ? ' · 当前 v' + row.version : profile.extension_version ? ' · 已准备 v' + profile.extension_version : ''}`
            : '已有登录配置'}
        </p>
        <p
          style={{
            fontSize: 13,
            minHeight: 38,
            margin: '6px 0',
            overflowWrap: 'anywhere',
          }}
        >
          {!profile.available
            ? profile.unavailable_reason
            : quota?.blocked
              ? `最早 ${localTime(quota.until * 1000)} 恢复`
              : row?.circuit?.open
                ? `连续 ${row.circuit.consecutive} 次异常，等待 ${row.circuit.wait_seconds} 秒`
                : row?.online
                  ? row.message || '可领取本批任务'
                  : profile.managed
                    ? '打开后首次登录 GPT；连接成功即可领取任务'
                    : row?.offline_reason || '打开浏览器后等待插件连接'}
        </p>
        <p className="panelnote">
          今日领取 {metric.claimed || 0} · 完成 {metric.completed || 0}
          {metric.fallback ? ` · 接管 ${metric.fallback}` : ''}
        </p>
        {row?.last_seen && (
          <p className="panelnote" style={{ fontSize: 12 }}>
            最近连接 {localTime(row.last_seen)}
          </p>
        )}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <Button
            variant={profile.managed ? 'default' : 'outline'}
            disabled={!!opening || !profile.available}
            onClick={() => {
              void openBrowser(profile.id);
            }}
          >
            {opening === profile.id ? '正在打开…' : '打开 ' + profile.label}
          </Button>
          {profile.managed && (
            <Button
              variant="outline"
              aria-label={'关闭 ' + profile.label}
              disabled={!!opening || !profile.running}
              onClick={() => {
                void closeBrowser(profile.id);
              }}
            >
              {opening === 'close:' + profile.id ? '正在关闭…' : '关闭窗口'}
            </Button>
          )}
        </div>
      </article>
    );
  }
  return (
    <section className="panel" aria-label="生图浏览器管理">
      <div className="sectionhead">
        <div>
          <h2>独立 Chrome 生图浏览器</h2>
          <p>
            按需要新增窗口，每个窗口登录一个 GPT
            账号，分别排队、冷却和记录额度。
          </p>
        </div>
        <span
          className={
            'tag ' + (workers.some((w) => w.online) ? 'green' : 'amber')
          }
        >
          {workers.filter((w) => w.online).length} 个已连接
        </span>
      </div>
      <div
        style={{
          background: '#f6f8fb',
          borderRadius: 12,
          padding: 16,
          margin: '12px 0 18px',
        }}
      >
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'end',
            gap: 12,
          }}
        >
          <label
            htmlFor="gpt-browser-prefix"
            style={{ display: 'grid', gap: 6 }}
          >
            窗口名称
            <Input
              id="gpt-browser-prefix"
              aria-label="窗口名称前缀"
              value={prefix}
              maxLength={40}
              onChange={(e) => setPrefix(e.target.value)}
              style={{ width: 200 }}
            />
          </label>
          <label
            htmlFor="gpt-browser-count"
            style={{ display: 'grid', gap: 6 }}
          >
            新增数量
            <Input
              id="gpt-browser-count"
              aria-label="新增浏览器数量"
              type="number"
              min={1}
              max={state.browser_creation?.max_per_request || 20}
              value={count}
              onChange={(e) => setCount(e.target.value)}
              style={{ width: 90 }}
            />
          </label>
          <Button
            disabled={!!opening || !state.browser_creation?.available}
            onClick={() => {
              void createBrowsers();
            }}
          >
            {opening === 'create' ? '正在创建并打开…' : '新增并打开 Chrome'}
          </Button>
          {!!chrome.length && (
            <Button
              variant="outline"
              disabled={!!opening || !chrome.some((p) => p.available)}
              onClick={() => {
                void openBrowser('chrome-all');
              }}
            >
              {opening === 'chrome-all'
                ? '正在打开…'
                : `打开全部 ${chrome.length} 个 Chrome`}
            </Button>
          )}
          {chrome.some((p) => p.managed) && (
            <Button
              variant="outline"
              disabled={
                !!opening || !chrome.some((p) => p.managed && p.running)
              }
              onClick={() => {
                void closeBrowser('chrome-all');
              }}
            >
              {opening === 'close:chrome-all'
                ? '正在关闭…'
                : '关闭全部生图窗口'}
            </Button>
          )}
        </div>
        <p className="panelnote" style={{ marginBottom: 0 }}>
          {state.browser_creation?.available
            ? '使用工作台专用 Chrome，自动加载生图插件。登录资料保存在本地，关闭后可再次打开；可分次持续新增，数量按电脑性能安排。'
            : state.browser_creation?.message || '正在检查本机 Chrome 环境…'}
        </p>
        {chrome.some((p) => p.managed) && (
          <p className="panelnote" style={{ margin: '6px 0 0' }}>
            关闭仅作用于工作台创建的生图窗口，登录资料会保留。正在生图的窗口关闭后，当前任务会中断。
          </p>
        )}
      </div>
      {launchMessage && (
        <p style={{ overflowWrap: 'anywhere' }}>
          <output>{launchMessage}</output>
        </p>
      )}
      {launchError && (
        <p role="alert" style={{ color: 'var(--color-destructive, #b91c1c)' }}>
          <strong>操作提示：</strong>
          {launchError}
        </p>
      )}
      {!!chrome.length && (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
            margin: '14px 0 10px',
          }}
        >
          <p className="panelnote" style={{ margin: 0 }}>
            窗口列表 · 显示 {visibleChrome.length}/{chrome.length} 个
          </p>
          {closedCount > 0 && (
            <Button
              variant="outline"
              size="sm"
              aria-expanded={showClosedProfiles}
              onClick={toggleClosedProfiles}
            >
              {showClosedProfiles
                ? '隐藏已关闭窗口'
                : `显示已关闭窗口（${closedCount}）`}
            </Button>
          )}
        </div>
      )}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
          gap: 12,
        }}
      >
        {visibleChrome.map(profileCard)}
      </div>
      {!!chrome.length && !visibleChrome.length && (
        <p className="panelnote">
          生图窗口均已关闭，卡片已收起。可点击“打开全部”继续使用，或显示已关闭窗口。
        </p>
      )}
      {!!legacy.length && (
        <details style={{ marginTop: 18 }}>
          <summary style={{ cursor: 'pointer' }}>
            其他已有浏览器（Edge / Firefox）
          </summary>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
              gap: 12,
              marginTop: 12,
            }}
          >
            {legacy.map(profileCard)}
          </div>
          <p className="panelnote">
            Firefox 临时插件在重启后需重新加载。新增生图窗口可使用上方的独立
            Chrome 入口。
          </p>
        </details>
      )}
      {!!unmatched.length && (
        <details style={{ marginTop: 14 }}>
          <summary style={{ cursor: 'pointer' }}>
            其他连接记录（{unmatched.length}）
          </summary>
          {unmatched.map((row) => (
            <p key={row.channel_id || row.browser + row.worker_id}>
              <strong>
                {row.profile_label ||
                  ({ chrome: 'Chrome', edge: 'Edge', firefox: 'Firefox' }[
                    row.browser
                  ] || row.browser) +
                    ' ' +
                    row.worker_id?.slice(0, 8)}
              </strong>{' '}
              · {workerStatus(row)} ·{' '}
              {row.online ? row.message : row.offline_reason}
              {row.last_seen ? ' · 最近连接 ' + localTime(row.last_seen) : ''}
            </p>
          ))}
        </details>
      )}
      <details style={{ marginTop: 14 }}>
        <summary style={{ cursor: 'pointer' }}>接力规则与手动安装</summary>
        <p className="panelnote">
          额度耗尽时，尚未发送的步骤由本批健康账号接力。已发送但结果不明的步骤保留原聊天，等待核对。每张图下载并校验后才继续下一步。
        </p>
        <div className="buttons">
          <Button
            variant="outline"
            onClick={() => {
              void openFolder();
            }}
          >
            打开插件文件夹
          </Button>
          <a
            className="external"
            href="https://chatgpt.com/"
            target="_blank"
            rel="noreferrer"
          >
            打开 GPT 首页 ↗
          </a>
        </div>
      </details>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
