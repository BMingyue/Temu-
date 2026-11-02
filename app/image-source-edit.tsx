'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useWorkbenchMode } from './workbench-mode';

type Preset = {
  id: string;
  label: string;
  description?: string;
  prompt: string;
  source_names: string[];
};
type Source = {
  path: string;
  relative_path: string;
  product_folder: string;
  source_name: string;
  sha256: string;
  folder_signature: string;
};
type Scan = {
  source_folder: string;
  items: Source[];
  skipped: { folder: string; reason: string }[];
  folder_count: number;
  file_count: number;
  message?: string;
};
type Batch = {
  message?: string;
  batch_no?: string;
  prepared_count?: number;
  queued_count?: number;
  jobs?: {
    id: string;
    title: string;
    source_relative_path?: string;
    result_folder: string;
  }[];
  skipped?: { path: string; reason: string }[];
  errors?: { path?: string; error?: string; reason?: string }[];
};
type Props = { onBusy: (value: boolean) => void; onStarted: () => void };
const defaultSource = 'D:\\Desktop\\毛衣1027-半高领修复';
const defaultOutput = 'D:\\Desktop\\毛衣1027-正背面修复';
const reason = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export default function ImageSourceEdit({ onBusy, onStarted }: Props) {
  const { professional, setMode } = useWorkbenchMode();
  const [presets, setPresets] = useState<Preset[]>([]);
  const [presetId, setPresetId] = useState('sweater-front-back-fix-v1');
  const [prompt, setPrompt] = useState('');
  const [source, setSource] = useState(defaultSource);
  const [output, setOutput] = useState(defaultOutput);
  const [scan, setScan] = useState<Scan | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [browsers, setBrowsers] = useState(['chrome']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [batch, setBatch] = useState<Batch | null>(null);
  const inFlight = useRef(false);
  const currentPreset = presets.find((preset) => preset.id === presetId);
  const selectedItems = (scan?.items || []).filter((item) =>
    selected.includes(item.path),
  );
  useEffect(() => {
    let cancelled = false;
    fetch('/api/image-jobs/source-edit-presets', {
      signal: AbortSignal.timeout(10000),
    })
      .then(async (response) => {
        const value = (await response.json()) as {
          error?: string;
          presets?: Preset[];
        };
        if (!response.ok) throw Error(value.error || '无法读取原图修复模板');
        if (cancelled) return;
        const values = value.presets as Preset[];
        setPresets(values || []);
        const first =
          values?.find((preset) => preset.id === 'sweater-front-back-fix-v1') ||
          values?.[0];
        if (first) {
          setPresetId(first.id);
          setPrompt(first.prompt);
        }
      })
      .catch((failure: unknown) => {
        if (!cancelled) setError(reason(failure));
      });
    return () => {
      cancelled = true;
    };
  }, []);
  async function post<T>(path: string, body: object) {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Workbench': 'local' },
      body: JSON.stringify(body),
    });
    const value = (await response.json()) as T & {
      ok?: boolean;
      error?: string;
      message?: string;
    };
    if (!response.ok || value.ok === false)
      throw Error(value.error || value.message || '操作失败');
    return value;
  }
  function setWorking(value: boolean) {
    inFlight.current = value;
    setBusy(value);
    onBusy(value);
  }
  function invalidateScan() {
    setScan(null);
    setSelected([]);
    setBatch(null);
    setMessage('');
  }
  async function scanSources() {
    if (inFlight.current) return;
    setWorking(true);
    setError('');
    invalidateScan();
    try {
      const value = (await post<Scan>('/api/image-jobs/source-edit-scan', {
        source_folder: source.trim(),
        preset_id: presetId,
      })) as Scan;
      setScan(value);
      setSelected([]);
      setMessage(
        value.message ||
          `已找到 ${value.items.length} 张待修原图，请检查后开始。`,
      );
    } catch (failure: unknown) {
      setError(reason(failure));
    } finally {
      setWorking(false);
    }
  }
  async function startSelected() {
    if (inFlight.current || !scan || !selectedItems.length) return;
    setWorking(true);
    setError('');
    setBatch(null);
    setMessage('');
    try {
      const value = (await post<Batch>('/api/image-jobs/source-edit-prepare', {
        source_folder: scan.source_folder,
        output_folder: output.trim(),
        preset_id: presetId,
        items: selectedItems,
        prompt,
        browsers,
        start: true,
      })) as Batch;
      setBatch(value);
      setMessage(
        value.message || `已排队 ${value.queued_count || 0} 张一对一修复任务。`,
      );
      const done = new Set(
        (value.jobs || []).map((job) => job.source_relative_path),
      );
      setSelected((previous) =>
        previous.filter(
          (path) =>
            !done.has(
              scan.items.find((item) => item.path === path)?.relative_path,
            ),
        ),
      );
      onStarted();
    } catch (failure: unknown) {
      setError(reason(failure));
    } finally {
      setWorking(false);
    }
  }
  function selectFirstProduct() {
    const first = scan?.items[0];
    if (first)
      setSelected(
        scan.items
          .filter((item) => item.product_folder === first.product_folder)
          .slice(0, 2)
          .map((item) => item.path),
      );
  }
  return (
    <section className="panel" aria-label="原图一对一修复">
      <div className="sectionhead">
        <div>
          <h2>原图一对一局部修复</h2>
          <p>每张原图独立开一个聊天，只生成一张修改图；正面与背面分别处理。</p>
        </div>
        <span className="tag">一图一任务</span>
      </div>
      <label className="field" htmlFor="source-edit-preset">
        <span>修改任务模板</span>
        <select
          id="source-edit-preset"
          aria-label="修改任务模板"
          disabled={busy}
          value={presetId}
          onChange={(event) => {
            const preset = presets.find(
              (value) => value.id === event.target.value,
            );
            setPresetId(event.target.value);
            setPrompt(preset?.prompt || '');
            invalidateScan();
          }}
        >
          {presets.length ? (
            presets.map((preset) => (
              <option value={preset.id} key={preset.id}>
                {preset.label}
              </option>
            ))
          ) : (
            <option value={presetId}>正在读取模板…</option>
          )}
        </select>
      </label>
      {professional && <p className="panelnote">
        {currentPreset?.description ||
          '把主画面圆领改成半高领，减弱右下火焰圆环内放大细节的绒毛感。印花、人物、排版及右侧五个小圆窗保持原样。'}
      </p>}
      <div className="formstack">
        <label className="field" htmlFor="source-edit-folder">
          <span>待修图片所在目录</span>
          <Input
            id="source-edit-folder"
            aria-label="待修图片所在目录"
            value={source}
            disabled={busy}
            onChange={(event) => {
              setSource(event.target.value);
              invalidateScan();
            }}
          />
        </label>
        <label className="field" htmlFor="source-edit-output">
          <span>修复成品保存目录</span>
          <Input
            id="source-edit-output"
            aria-label="修复成品保存目录"
            value={output}
            disabled={busy}
            onChange={(event) => setOutput(event.target.value)}
          />
        </label>
      </div>
      {professional ? <p className="panelnote">
        扫描每款文件夹中的 01-main.png、02-back.png。含 ChatGPT / GPT
        前缀图片的文件夹视为手工处理过，会整款排除；衣架、穿搭、平铺图不发送。新成品保存到独立目录，原图保留。
        已登记的人工修复目录会继续排除，即使之后图片改名或移走。
      </p> : <p className="panelnote">扫描后选择需要修复的图片；新成品保存到独立目录，原图保留。</p>}
      {professional && <details style={{ margin: '16px 0' }}>
        <summary style={{ cursor: 'pointer' }}>
          查看／编辑本次修复提示词
        </summary>
        <p className="panelnote">
          每个任务只上传该张原图。以下提示词作为任务快照，正背面都应用相同的两个局部修改。
        </p>
        <textarea
          aria-label="原图局部修复提示词"
          rows={14}
          value={prompt}
          disabled={busy}
          style={{ width: '100%', margin: '10px 0' }}
          onChange={(event) => setPrompt(event.target.value)}
        />
        <Button
          variant="outline"
          disabled={busy || !currentPreset}
          onClick={() => setPrompt(currentPreset?.prompt || '')}
        >
          恢复修复模板提示词
        </Button>
      </details>}
      {professional && <fieldset className="formstack">
        <legend>参与本批修复的浏览器</legend>
        <div className="buttons">
          {[
            ['chrome', 'Chrome'],
            ['edge', 'Edge'],
            ['firefox', 'Firefox'],
          ].map(([key, label]) => (
            <label key={key}>
              <input
                type="checkbox"
                aria-label={'原图修复使用 ' + label}
                checked={browsers.includes(key)}
                disabled={busy}
                onChange={(event) =>
                  setBrowsers((previous) =>
                    event.target.checked
                      ? [...previous, key]
                      : previous.filter((value) => value !== key),
                  )
                }
              />{' '}
              {label}
            </label>
          ))}
        </div>
        <p className="panelnote">
          Chrome 的已连接独立配置均可参与，各账号沿用现有冷却和额度规则。
        </p>
      </fieldset>}
      {!professional && (!prompt.trim() || !browsers.length) && <output className="banner warn">
        {!prompt.trim() ? '当前预设的提示词为空。' : '尚未选择生图浏览器。'}
        <Button variant="ghost" onClick={() => setMode('professional')}>检查高级设置</Button>
      </output>}
      <div className="buttons">
        <Button
          variant="outline"
          disabled={busy || !source.trim() || !currentPreset}
          onClick={() => {
            void scanSources();
          }}
        >
          {busy ? '正在处理…' : '扫描待修正背图'}
        </Button>
        <Button
          disabled={
            busy ||
            !scan ||
            !selectedItems.length ||
            !output.trim() ||
            !prompt.trim() ||
            !browsers.length
          }
          onClick={() => {
            void startSelected();
          }}
        >
          开始选中的 {selectedItems.length} 张修复
        </Button>
      </div>
      {error && (
        <p role="alert" style={{ color: '#b42318', overflowWrap: 'anywhere' }}>
          {error}
        </p>
      )}
      {message && (
        <p>
          <output>{message}</output>
        </p>
      )}
      {scan && (
        <div style={{ marginTop: 20 }}>
          <h3>
            待修 {scan.items.length} 张 · 已选 {selectedItems.length} 张
          </h3>
          <p className="panelnote">
            已排除 {scan.skipped.length}{' '}
            个文件夹。先选一款的两张图试跑，审核后可继续处理剩余图片。
          </p>
          <div className="buttons">
            <Button
              variant="outline"
              disabled={busy || !scan.items.length}
              onClick={selectFirstProduct}
            >
              仅选第一款（最多两张）
            </Button>
            <Button
              variant="outline"
              disabled={busy || !scan.items.length}
              onClick={() => setSelected(scan.items.map((item) => item.path))}
            >
              选择全部待修图
            </Button>
            <Button
              variant="ghost"
              disabled={busy || !selectedItems.length}
              onClick={() => setSelected([])}
            >
              取消选择
            </Button>
          </div>
          {!!scan.items.length && (
            <div style={{ maxHeight: 340, overflow: 'auto', marginTop: 12 }}>
              <table>
                <thead>
                  <tr>
                    <th>选择</th>
                    <th>产品与原图</th>
                    <th>部位</th>
                  </tr>
                </thead>
                <tbody>
                  {scan.items.map((item) => (
                    <tr key={item.path}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={'选择修复 ' + item.relative_path}
                          checked={selected.includes(item.path)}
                          disabled={busy}
                          onChange={(event) =>
                            setSelected((previous) =>
                              event.target.checked
                                ? [...previous, item.path]
                                : previous.filter(
                                    (value) => value !== item.path,
                                  ),
                            )
                          }
                        />
                      </td>
                      <td style={{ overflowWrap: 'anywhere', maxWidth: 600 }}>
                        {item.relative_path}
                      </td>
                      <td>
                        {item.source_name === '01-main.png' ? '正面' : '背面'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {professional && !!scan.skipped.length && (
            <details style={{ marginTop: 16 }}>
              <summary style={{ cursor: 'pointer' }}>
                查看排除的文件夹（{scan.skipped.length}）
              </summary>
              <ul style={{ maxHeight: 240, overflow: 'auto', fontSize: 13 }}>
                {scan.skipped.map((item, index) => (
                  <li
                    key={item.folder + index}
                    style={{ overflowWrap: 'anywhere' }}
                  >
                    {item.folder}：{item.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
      {batch && (
        <div style={{ marginTop: 16 }}>
          <p>
            批次 {batch.batch_no || '—'} · 新建 {batch.prepared_count || 0} 张 ·
            排队 {batch.queued_count || 0} 张
          </p>
          {professional && !!batch.jobs?.length && (
            <details>
              <summary>查看成品保存位置</summary>
              {batch.jobs.map((job) => (
                <p
                  key={job.id}
                  style={{ fontSize: 13, overflowWrap: 'anywhere' }}
                >
                  {job.source_relative_path || job.title} → {job.result_folder}
                </p>
              ))}
            </details>
          )}
          {professional && !!batch.skipped?.length && (
            <details>
              <summary>已存在的修复任务（{batch.skipped.length}）</summary>
              {batch.skipped.map((item, index) => (
                <p
                  key={item.path + index}
                  style={{ fontSize: 13, overflowWrap: 'anywhere' }}
                >
                  {item.path}：{item.reason}
                </p>
              ))}
            </details>
          )}
          {!!batch.errors?.length && (
            <div role="alert" style={{ color: '#b42318' }}>
              {batch.errors.map((item, index) => (
                <p key={index} style={{ overflowWrap: 'anywhere' }}>
                  {item.path || ''}：
                  {item.error || item.reason || '准备失败，请重新扫描后核对'}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
