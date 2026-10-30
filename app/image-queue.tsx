'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import PromptEditor from './prompt-editor';
import ImageRunner from './image-runner';
import ImageTaskCard from './image-task-card';
import ImageSourceEdit from './image-source-edit';
type Row = Record<string, any>;
const browserNames: Record<string, string> = { chrome: 'Chrome', edge: 'Edge', firefox: 'Firefox' };
function workflowStepCount(value?: Row) {
  const count = Number(value?.steps?.length || value?.step_count || value?.expected_count || 4);
  return Number.isInteger(count) && count > 0 ? count : 4;
}
export default function ImageQueue({ draft }: { draft?: Row }) {
  const loading = useRef(false);
  const detailedIds = useRef(new Set<string>());
  const retryRequests = useRef(new Map<string, string>());
  const retryInFlight = useRef(false);
  const [taskQuery, setTaskQuery] = useState('');
  const [taskPages, setTaskPages] = useState({ pending: 1, saved: 1 });
  const [connectionError, setConnectionError] = useState('');
  const [sourceEditMode, setSourceEditMode] = useState(false);
  const [form, setForm] = useState({
    folders: '',
    output_folder: '',
    template: '',
    category: '地垫',
    recursive: false,
    extra_references: [] as string[],
    fixed_images: [] as string[],
    browsers: ['chrome'] as string[],
    workflow_id: 'flannel-blanket-chat-v1',
    step_delay_seconds: 30,
    workflow_prompts: {} as Record<string, string>,
  });
  const [workflowPresets, setWorkflowPresets] = useState<Row[]>([]);
  const [workflowVersion, setWorkflowVersion] = useState(0);
  const repairSection = useRef<HTMLDetailsElement>(null);
  const [repairTitleQuery, setRepairTitleQuery] = useState('');
  const [repairBatchNo, setRepairBatchNo] = useState('');
  const [repairSourceRoot, setRepairSourceRoot] = useState('');
  const [repairOutputFolder, setRepairOutputFolder] = useState('');
  const [repairSourceIds, setRepairSourceIds] = useState<string[]>([]);
  const [repairStepKeys, setRepairStepKeys] = useState<string[]>(['hanger', 'flatlay']);
  const [repairPreview, setRepairPreview] = useState<Row | null>(null);
  const [repairResult, setRepairResult] = useState<Row | null>(null);
  const [repairError, setRepairError] = useState('');
  const selectedPreset = workflowPresets.find((p) => p.id === form.workflow_id);
  const sequential = form.workflow_id !== 'legacy_zip';
  const selectedStepCount = workflowStepCount(selectedPreset);
  const singleImage = sequential && selectedStepCount === 1;
  const [prompt, setPrompt] = useState<string | null>(null),
    [usedPrompt, setUsedPrompt] = useState(''),
    [jobs, setJobs] = useState<Row[]>([]),
    [summary, setSummary] = useState<Row>({}),
    [preview, setPreview] = useState<Row | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [selectedIds, setSelectedIds] = useState<string[]>([]),
    [confirmClear, setConfirmClear] = useState<'all' | 'selected' | null>(null),
    [confirmDelete, setConfirmDelete] = useState(false),
    [confirmReset, setConfirmReset] = useState(false),
    [taskFilter, setTaskFilter] = useState<'all' | 'pending' | 'saved' | 'failed' | 'needs_review'>('all');
  async function load() {
    if (loading.current) return;
    loading.current = true;
    try {
    const r = await fetch('/api/image-jobs?compact=1', { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw Error('无法读取任务');
    const payload = (await r.json()) as Row;
    const next = payload.jobs as Row[];
    setJobs((previous) =>
      next.map((summary) => {
        if (!detailedIds.current.has(summary.id)) return summary;
        const detail = previous.find((job) => job.id === summary.id);
        return detail ? { ...detail, ...summary } : summary;
      }),
    );
    setSummary(payload.summary || {});
    setConnectionError('');
    setSelectedIds((selected) =>
      selected.filter((id) => next.some((job) => job.id === id)),
    );
    } catch (error) {
      setConnectionError('工作台数据服务暂时失联，正在自动恢复；下面显示的是最后一次收到的状态。');
      throw error;
    } finally { loading.current = false; }
  }
  useEffect(() => {
    fetch('/api/image-jobs/workflow-presets')
      .then(async (r) => { const v = await r.json() as Row; if (!r.ok) throw Error(v.error || '无法读取工作流预设'); return v; })
      .then((v: Row) => {
        const presets = v.presets || [];
        setWorkflowPresets(presets);
        setWorkflowVersion(v.settings?.version || 0);
        const preset = presets.find((p: Row) => p.id === v.settings?.preset_id) || presets[0];
        const savedPrompts = preset?.id === v.settings?.preset_id ? v.settings?.prompts : {};
        if (preset) setForm((f) => ({ ...f, workflow_id: preset.id,
          step_delay_seconds: [30, 60].includes(v.settings?.delay_seconds) ? v.settings.delay_seconds : 30,
          workflow_prompts: Object.fromEntries(preset.steps.map((s: Row) => [s.key, savedPrompts?.[s.key] || s.prompt])),
        }));
      }).catch((e) => setMessage(e.message));
    fetch('/api/image-jobs/config')
      .then((r) => r.json() as Promise<Row>)
      .then((c: Row) =>
        setForm((f) => ({
          ...f,
          folders: c.source_folder || '',
          output_folder: c.output_folder || '',
          extra_references: c.extra_references || [],
          fixed_images: c.fixed_images || [],
          template: c.template_path || c.templates?.[0]?.path || '',
          browsers:
            Array.isArray(c.browsers) && c.browsers.length
              ? c.browsers
              : f.browsers,
        })),
      )
      .catch((e) => setMessage(e.message));
    load().catch((e) => setMessage(e.message));
    const timer = setInterval(() => load().catch(() => {}), 5000);
    return () => clearInterval(timer);
  }, []);
  async function loadDetail(id: string) {
    if (detailedIds.current.has(id)) return;
    try {
      const response = await fetch('/api/image-jobs/' + id, {
        signal: AbortSignal.timeout(10000),
      });
      const payload = (await response.json()) as Row;
      if (!response.ok) throw Error(payload.error || '无法读取任务详情');
      detailedIds.current.add(id);
      setJobs((rows) =>
        rows.map((job) => (job.id === id ? { ...job, ...payload.job } : job)),
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '无法读取任务详情');
    }
  }
  async function batch(start = false) {
    setBusy(true);
    try {
      const r = await fetch(
        '/api/image-jobs/' + (start ? 'prepare-batch' : 'scan-batch'),
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Workbench': 'local',
          },
          body: JSON.stringify({ ...form, prompt, extra_references: sequential ? [] : form.extra_references }),
        },
      );
      const v = (await r.json()) as Row;
      if (!r.ok) throw Error(v.error);
      if (start) {
        if (v.workflow_settings) setWorkflowVersion(v.workflow_settings.version);
        setUsedPrompt(prompt || '');
        const names = form.browsers
          .map((browser) =>
            browser === 'chrome'
              ? 'Chrome'
              : browser === 'edge'
                ? 'Edge'
                : 'Firefox',
          )
          .join('、');
        setMessage(
          `已按 ${names} 调度并排队 ${v.jobs.length} 款，跳过重复 ${v.skipped.length} 款。${sequential ? `每款由同一浏览器在同一聊天完成 ${selectedStepCount} 张${singleImage ? '主图，保存后按账号冷却规则接下一款。' : '图片。'}` : ''}` +
            (v.reassigned?.length
              ? `另有 ${v.reassigned.length} 个未发送任务已按新选择重新分配。`
              : '') +
            v.errors.map((e: Row) => e.name + '：' + e.error).join('；'),
        );
        await load();
      } else {
        setPreview(v);
        setMessage(
          '已自动填入 ' +
            v.count +
            ' 款印花，确认模板、保存目录和参与浏览器后点击开始。',
        );
      }
    } catch (e: any) {
      setMessage(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function addFixed(files: FileList | null) {
    if (!files) return;
    setBusy(true);
    try {
      for (const file of Array.from(files)) {
        if (file.size > 10000000) throw Error('单张固定图最多 10MB');
        const content = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1]);
          reader.onerror = () => reject(Error('读取失败'));
          reader.readAsDataURL(file);
        });
        const r = await fetch('/api/image-jobs/upload-fixed', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Workbench': 'local',
          },
          body: JSON.stringify({ name: file.name, content }),
        });
        const v = (await r.json()) as Row;
        if (!r.ok) throw Error(v.error);
        setForm((f) => ({ ...f, fixed_images: [...f.fixed_images, v.path] }));
      }
    } catch (e: any) {
      setMessage(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function addReferences(files: FileList | null) {
    if (!files) return;
    if (form.extra_references.length + files.length > 7) {
      setMessage('额外参考图最多 7 张；加上目录中的主参考图，每个任务最多上传 8 张参考图。');
      return;
    }
    setBusy(true);
    try {
      for (const file of Array.from(files)) {
        if (file.size > 10000000) throw Error('单张额外参考图最多 10MB');
        const content = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1]);
          reader.onerror = () => reject(Error('读取失败'));
          reader.readAsDataURL(file);
        });
        const r = await fetch('/api/image-jobs/upload-reference', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Workbench': 'local',
          },
          body: JSON.stringify({ name: file.name, content }),
        });
        const v = (await r.json()) as Row;
        if (!r.ok) throw Error(v.error);
        setForm((f) => ({
          ...f,
          extra_references: [...f.extra_references, v.path],
        }));
      }
      setPreview(null);
      setMessage('额外参考图已加入；开始排队后，每个任务都会同时上传这些图片。');
    } catch (e: any) {
      setMessage(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function pauseJob(id: string) {
    setBusy(true);
    try {
      const r = await fetch('/api/gpt-extension', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Workbench': 'local',
        },
        body: JSON.stringify({ id, action: 'pause' }),
      });
      const v = (await r.json()) as Row;
      if (!r.ok) throw Error(v.error);
      setMessage(v.message);
      await load();
    } catch (e: any) {
      setMessage(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function retryTask(id: string, keys?: string[], confirmResend = false) {
    if (retryInFlight.current) return;
    if (!form.browsers.length) { setMessage('请先在上方选择参与浏览器。'); return; }
    retryInFlight.current = true;
    setBusy(true);
    const signature = id + ':' + (keys ? [...keys].sort().join(',') : 'all');
    const requestId = retryRequests.current.get(signature) || crypto.randomUUID();
    retryRequests.current.set(signature, requestId);
    try {
      const response = await fetch('/api/image-jobs/retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Workbench': 'local' },
        body: JSON.stringify({ id, request_id: requestId, browsers: form.browsers, ...(keys ? { step_keys: keys } : {}), ...(confirmResend ? { confirm_resend: true } : {}) }),
      });
      const payload = await response.json() as Row;
      if (!response.ok) throw Error(payload.error || '重新发送失败');
      retryRequests.current.delete(signature);
      setMessage(payload.message || '已创建重试副本并排队，原任务与原图保留。');
      await load();
    } catch (error: any) { setMessage(error.message); }
    finally { retryInFlight.current = false; setBusy(false); }
  }
  async function resumeJob(job: Row) {
    setBusy(true);
    try {
      const retry = job.batch_phase === 'failed';
      const response = await fetch(retry ? '/api/image-jobs/retry-failed' : '/api/gpt-extension', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workbench': 'local' },
        body: JSON.stringify(retry ? { ids: [job.id] } : { id: job.id, browsers: form.browsers }),
      });
      const payload = await response.json() as Row;
      if (!response.ok) throw Error(payload.error || '无法继续任务');
      setMessage(payload.message || '任务已加入浏览器队列');
      await load();
    } catch (error: any) { setMessage(error.message); }
    finally { setBusy(false); }
  }
  async function clearRecords(scope: 'all' | 'selected') {
    setBusy(true);
    try {
      const r = await fetch('/api/image-jobs/clear-records', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Workbench': 'local',
        },
        body: JSON.stringify(scope === 'selected' ? { ids: selectedIds } : {}),
      });
      const v = (await r.json()) as Row;
      if (!r.ok) throw Error(v.error);
      setMessage(v.message + '；最终生成图片未删除。');
      setConfirmClear(null);
      await load();
    } catch (e: any) {
      setMessage(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function resetAll() {
    setBusy(true);
    try {
      const r = await fetch('/api/image-jobs/reset-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Workbench': 'local' },
        body: '{}',
      });
      const v = (await r.json()) as Row;
      if (!r.ok) throw Error(v.error);
      setMessage(v.message);
      setConfirmReset(false);
      setSelectedIds([]);
      setTaskFilter('all');
      await load();
    } catch (e: any) {
      setMessage(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function previewRepairs(sourceIds?: string[]) {
    const ids = sourceIds || repairSourceIds;
    if (!ids.length && !repairTitleQuery.trim() && !repairBatchNo.trim()) {
      setMessage('请填写任务名称或批次，或先选择要修改的任务。');
      return;
    }
    if (!repairStepKeys.length) {
      setMessage('请至少选择一类需要修改的图片。');
      return;
    }
    if (sourceIds) {
      setRepairSourceIds(sourceIds);
      setRepairTitleQuery('');
      setRepairBatchNo('');
    }
    if (repairSection.current) {
      repairSection.current.open = true;
      repairSection.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    setBusy(true);
    setRepairPreview(null);
    setRepairResult(null);
    setRepairError('');
    try {
      const r = await fetch('/api/image-jobs/repair-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Workbench': 'local' },
        body: JSON.stringify({
          ...(ids.length ? { ids } : { title_query: repairTitleQuery.trim(), batch_no: repairBatchNo.trim() }),
          step_keys: repairStepKeys,
          source_results_root: repairSourceRoot.trim(),
        }),
      });
      const v = (await r.json()) as Row;
      if (!r.ok) throw Error(v.error || '无法预览部分修改任务');
      setRepairPreview(v);
      setMessage(v.message || `找到 ${v.matched_count} 套，可修改 ${v.eligible_count} 套。`);
    } catch (e: any) {
      setRepairError(e.message);
      setMessage(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function prepareRepairs() {
    const ids = (repairPreview?.matching || []).filter((job: Row) => job.eligible).map((job: Row) => job.id);
    if (!ids.length || !form.browsers.length) return;
    setBusy(true);
    setRepairError('');
    try {
      const r = await fetch('/api/image-jobs/repair-prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Workbench': 'local' },
        body: JSON.stringify({ ids, step_keys: repairPreview?.step_keys, browsers: form.browsers,
          source_results_root: repairSourceRoot.trim(), output_folder: repairOutputFolder.trim() }),
      });
      const v = (await r.json()) as Row;
      if (!r.ok) throw Error(v.error || '无法创建部分修改任务');
      setRepairResult(v);
      setRepairPreview(null);
      setMessage((v.message || `已创建 ${v.prepared_count || 0} 套修复任务。`) + ' 原任务和原成图已保留；新任务准备完成后可点击“开始生成 / 继续”。');
      await load();
    } catch (e: any) {
      setRepairError(e.message);
      setMessage(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function deleteSelected() {
    setBusy(true);
    try {
      const r = await fetch('/api/image-jobs/delete-selected', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Workbench': 'local',
        },
        body: JSON.stringify({ ids: selectedIds }),
      });
      const v = (await r.json()) as Row;
      if (!r.ok) throw Error(v.error);
      setMessage(v.message + '；生成图片仍保留在原结果目录。');
      setConfirmDelete(false);
      setSelectedIds([]);
      await load();
    } catch (e: any) {
      setMessage(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function retryFailed() {
    setBusy(true);
    try {
      const r = await fetch('/api/image-jobs/retry-failed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Workbench': 'local' },
        body: '{}',
      });
      const v = (await r.json()) as Row;
      if (!r.ok) throw Error(v.error);
      setMessage(v.message);
      await load();
    } catch (e: any) {
      setMessage(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function pauseSelected() {
    setBusy(true);
    try {
      const r = await fetch('/api/image-jobs/pause-selected', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Workbench': 'local',
        },
        body: JSON.stringify({ ids: selectedIds }),
      });
      const v = (await r.json()) as Row;
      if (!r.ok) throw Error(v.error);
      setMessage(v.message);
      await load();
    } catch (e: any) {
      setMessage(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function reassignSelected() {
    if (!form.browsers.length) {
      setMessage('请先在上方至少选择一个参与浏览器。');
      return;
    }
    setBusy(true);
    try {
      const r = await fetch('/api/image-jobs/reassign-selected', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Workbench': 'local',
        },
        body: JSON.stringify({ ids: selectedIds, browsers: form.browsers }),
      });
      const v = (await r.json()) as Row;
      if (!r.ok) throw Error(v.error);
      setMessage(v.message);
      await load();
    } catch (e: any) {
      setMessage(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function reassignBatch(batchNo: string) {
    if (!form.browsers.length) {
      setMessage('请先在上方至少选择一个参与浏览器。');
      return;
    }
    setBusy(true);
    try {
      const r = await fetch('/api/image-jobs/reassign-batch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Workbench': 'local',
        },
        body: JSON.stringify({ batch_no: batchNo, browsers: form.browsers }),
      });
      const v = (await r.json()) as Row;
      if (!r.ok) throw Error(v.error);
      setMessage(v.message);
      await load();
    } catch (e: any) {
      setMessage(e.message);
    } finally {
      setBusy(false);
    }
  }
  const visibleJobs = jobs.filter((job) =>
    (taskFilter === 'all' || (taskFilter === 'pending' && job.batch_phase !== 'saved') || job.batch_phase === taskFilter) &&
    (!taskQuery.trim() || [job.title, job.task_no, job.batch_no, job.id].some((value) => String(value || '').toLowerCase().includes(taskQuery.trim().toLowerCase()))),
  );
  return (
    <>
      <div className="buttons" role="group" aria-label="生图任务类型" style={{ marginBottom: 16 }}>
        <Button variant={sourceEditMode ? 'outline' : 'default'} disabled={busy} onClick={() => setSourceEditMode(false)}>套图生成</Button>
        <Button variant={sourceEditMode ? 'default' : 'outline'} disabled={busy} onClick={() => setSourceEditMode(true)}>原图一对一修复</Button>
      </div>
      {sourceEditMode ? <ImageSourceEdit onBusy={setBusy} onStarted={() => { void load().catch(() => {}); setTaskFilter('pending'); }} /> : <section className="panel">
        {connectionError && <p role="alert" style={{ color: '#b42318' }}>{connectionError}</p>}
        <h2>设置一次，依次生成整批{singleImage ? '主图' : '套图'}</h2>
        <p>
          {sequential
            ? singleImage
              ? '每款在一个独立聊天中，用固定底图和本款印花生成 1 张主图。保存并校验通过后本款结束，再按账号原有冷却规则接下一款。'
              : `每款在一个独立聊天中，逐张完成 ${(selectedPreset?.steps || []).map((step: Row) => step.label).join('、')}共 ${selectedStepCount} 张图。每张只上传当前模板与印花依据；后续图片统一参考本款主图，同一浏览器执行整套。`
            : '旧模式：每款独立新对话，一次上传参考图和模板 ZIP；整套保存后按原账号冷却规则继续。'}
        </p>
        <label className="field">
          <span>工作流预设</span>
          <select aria-label="工作流预设" value={form.workflow_id} onChange={(e) => {
            const preset = workflowPresets.find((p) => p.id === e.target.value);
            setForm((f) => ({ ...f, workflow_id: e.target.value, workflow_prompts: preset
              ? Object.fromEntries(preset.steps.map((s: Row) => [s.key, s.prompt])) : f.workflow_prompts }));
            setPreview(null);
          }}>
            {workflowPresets.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            {!workflowPresets.length && <option value="flannel-blanket-chat-v1">正在读取逐张预设…</option>}
            <option value="legacy_zip">原模板 ZIP 模式（保留旧任务）</option>
          </select>
        </label>
        {sequential && <>
          {!singleImage && <label className="field"><span>本张保存后，等待多久开始下一张</span>
            <select aria-label="本张保存后，等待多久开始下一张" value={form.step_delay_seconds} onChange={(e) => setForm((f) => ({ ...f, step_delay_seconds: Number(e.target.value) }))}>
              <option value={30}>30 秒</option><option value={60}>60 秒</option>
            </select>
          </label>}
          <p className="panelnote">{singleImage
            ? '预设已内置固定底图，每款印花只生成 1 张主图，无需套内图间等待。保存并通过文件校验后本款结束，账号原有冷却规则照常适用。'
            : `预设已内置 ${selectedStepCount} 张模板。${(selectedPreset?.steps || []).map((step: Row) => step.label).join(' → ')}；每张保存并通过文件校验后计时。套内不中途更换账号或新开聊天，整套结束后再按账号冷却规则接下一款。`}</p>
          {selectedPreset?.steps.map((step: Row) => <details key={step.key}>
            <summary>{step.number}. {step.label} · 查看／编辑保留的提示词</summary>
            <p className="panelnote">本轮图1：{singleImage ? '固定底图 ' : ''}{step.template_name}；图2：{step.number === 1 ? '本款原印花' : '本款已保存主图'}。</p>
            <textarea aria-label={step.label + '提示词'} rows={10} style={{ width: '100%' }}
              value={form.workflow_prompts[step.key] || ''}
              onChange={(e) => setForm((f) => ({ ...f, workflow_prompts: { ...f.workflow_prompts, [step.key]: e.target.value } }))} />
          </details>)}
          <div className="buttons"><Button variant="outline" disabled={!selectedPreset || busy} onClick={async () => {
            try {
              const r = await fetch('/api/image-jobs/workflow-settings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workbench': 'local' },
                body: JSON.stringify({ preset_id: form.workflow_id, delay_seconds: form.step_delay_seconds, prompts: form.workflow_prompts, version: workflowVersion }) });
              const v = await r.json() as Row; if (!r.ok) throw Error(v.error);
              setWorkflowVersion(v.version); setMessage(`本预设的 ${selectedStepCount} 步提示词${singleImage ? '' : '和等待时间'}已保存，下次打开继续使用。`);
            } catch (e: any) { setMessage(e.message); }
          }}>保存本预设设置</Button>
          <Button variant="outline" disabled={!selectedPreset || busy} onClick={() => setForm((f) => ({ ...f,
            workflow_prompts: Object.fromEntries((selectedPreset?.steps || []).map((s: Row) => [s.key, s.prompt])),
          }))}>恢复内置提示词</Button></div>
        </>}
        <div className="formstack">
          {[
            ['folders', '① 印花目录'],
            ['output_folder', '② 生成图片保存目录'],
            ['template', '③ 模板 ZIP 完整路径'],
          ].filter(([key]) => !sequential || key !== 'template').map(([key, label]) => (
            <label className="field" key={key}>
              <span>{label}</span>
              <Input
                value={(form as Row)[key]}
                placeholder={
                  key === 'template'
                    ? '粘贴本机模板压缩包的完整路径，以 .zip 结尾'
                    : '粘贴文件夹完整路径'
                }
                onChange={(e) => {
                  setForm({ ...form, [key]: e.target.value });
                  setPreview(null);
                }}
              />
            </label>
          ))}
        </div>
        {!sequential && <p className="panelnote">
          每个任务默认上传目录中的一张主参考图和模板 ZIP。还可以在下方添加额外参考图；ZIP
          内至少包含一张模板图，模板图片数量不设固定限制。
        </p>}
        <label>
          <input
            type="checkbox"
            checked={form.recursive}
            onChange={(e) => {
              setForm({ ...form, recursive: e.target.checked });
              setPreview(null);
            }}
          />{' '}
          包含印花子文件夹
        </label>
        <fieldset className="formstack">
          <legend>④ 本批调度模式：选择参与生图的浏览器</legend>
          <div className="buttons">
            {Object.entries(browserNames).map(([browser, label]) => (
              <label key={browser}>
                <input
                  type="checkbox"
                  checked={form.browsers.includes(browser)}
                  onChange={(e) => {
                    const browsers = e.target.checked
                      ? [...form.browsers, browser]
                      : form.browsers.filter((value) => value !== browser);
                    setForm({ ...form, browsers });
                  }}
                />{' '}
                {label}
              </label>
            ))}
          </div>
          <p className="panelnote">
            勾选后，该浏览器已连接的独立配置均可参与，每个配置分别执行一个任务、冷却和额度停发。未勾选的浏览器不参与领取或接管；已开始的套图仍由原配置续接。
          </p>
          {!form.browsers.length && (
            <p role="alert">请至少选择一个参与浏览器。</p>
          )}
        </fieldset>
        {!sequential && <details open>
          <summary>⑤ 额外参考图（可选，最多 7 张）</summary>
          <p>
            这里添加的图片会和目录中的主参考图、模板 ZIP 一起发送给 GPT。每个任务最多包含 8 张参考图；适合正反面、细节图、风格图等需要共同参考的场景。
          </p>
          <input
            type="file"
            multiple
            accept="image/png,image/jpeg,image/webp"
            disabled={busy || form.extra_references.length >= 7}
            onChange={(e) => {
              addReferences(e.target.files);
              e.target.value = '';
            }}
          />
          {form.extra_references.map((path, i) => (
            <p key={path}>
              额外参考图 {i + 1}. {path.split(/[\\/]/).pop()}{' '}
              <button
                onClick={() => {
                  setForm((f) => ({
                    ...f,
                    extra_references: f.extra_references.filter((_, n) => n !== i),
                  }));
                  setPreview(null);
                }}
              >
                移除
              </button>
            </p>
          ))}
          <p className="panelnote">
            当前每个任务将发送 {1 + form.extra_references.length} 张参考图＋1 个模板 ZIP，共 {2 + form.extra_references.length} 个附件。
          </p>
        </details>}
        <details open>
          <summary>⑥ 附加固定图（可选）</summary>
          <p>
            选择尺寸图、材质说明等通用图片，每款生成完成后原样附加，并自动接在生成图之后编号，不会发给
            GPT 改图。
          </p>
          <input
            type="file"
            multiple
            accept="image/png,image/jpeg,image/webp"
            disabled={busy}
            onChange={(e) => {
              addFixed(e.target.files);
              e.target.value = '';
            }}
          />
          {form.fixed_images.map((path, i) => (
            <p key={path}>
              附加图 {i + 1}. {path.split(/[\\/]/).pop()}{' '}
              <button
                onClick={() =>
                  setForm((f) => ({
                    ...f,
                    fixed_images: f.fixed_images.filter((_, n) => n !== i),
                  }))
                }
              >
                移除
              </button>
            </p>
          ))}
        </details>
        {!sequential && <details>
          <summary>提示词与产品设置（保留上次提示词）</summary>
          <select
            value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value })}
          >
            <option>地垫</option>
            <option>毛毯</option>
          </select>
          <PromptEditor onChange={setPrompt} usedPrompt={usedPrompt} />
        </details>}
        <div className="buttons">
          <Button
            variant="outline"
            disabled={busy || !form.folders}
            onClick={() => batch()}
          >
            扫描印花，自动填入队列
          </Button>
          <Button
            disabled={
              busy ||
              !preview ||
              !form.output_folder ||
              (!sequential && !form.template) ||
              !form.browsers.length ||
              (sequential ? !selectedPreset || selectedPreset.steps.some((s: Row) => !form.workflow_prompts[s.key]?.trim()) : !prompt?.trim())
            }
            onClick={() => batch(true)}
          >
            {busy ? '正在处理…' : '开始自动生成'}
          </Button>
        </div>
        {message && <p role="status">{message}</p>}
        {preview && (
          <>
            <h3>待生成 {preview.count} 款 · {sequential ? singleImage ? '每款 1 张主图，保存后本款结束' : `每款 ${selectedStepCount} 张，单图逐轮、同一聊天` : '每款按模板图片数量生成'}</h3>
            <p>
              任务名称自动采用“创建时间-排队序号”，不需要手动填写；结果按任务分别保存。
            </p>
            <div style={{ maxHeight: 280, overflow: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    <th>排队顺序</th>
                    <th>参考印花（已自动填入）</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.files.map((f: Row, i: number) => (
                    <tr key={f.path}>
                      <td>{String(i + 1).padStart(3, '0')}</td>
                      <td>{f.path}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>}
      <ImageRunner />
      <section className="panel">
        <div className="sectionhead">
          <div>
            <h2>任务审核</h2>
            <p>未完成与已完成分开展示。先看状态、时间和成品，再展开步骤审核；时间均为北京时间。</p>
          </div>
          <div className="buttons">
            {confirmReset ? (
              <>
                <Button variant="outline" disabled={busy} onClick={resetAll}>
                  确认重置全部任务（{jobs.length}）
                </Button>
                <Button variant="ghost" onClick={() => setConfirmReset(false)}>
                  取消
                </Button>
              </>
            ) : (
              <Button variant="outline" disabled={busy || !jobs.length} onClick={() => setConfirmReset(true)}>
                重置全部任务
              </Button>
            )}
            {confirmClear ? (
              <>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => clearRecords(confirmClear)}
                >
                  {confirmClear === 'selected'
                    ? `确认清除选中的已结束记录（${selectedIds.length}）`
                    : '确认清除全部已结束记录'}
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setConfirmClear(null)}
                >
                  取消
                </Button>
              </>
            ) : (
              <Button
                variant="outline"
                disabled={busy || !jobs.length}
                onClick={() => setConfirmClear('all')}
              >
                清除全部已结束记录
              </Button>
            )}
          </div>
        </div>
        <details ref={repairSection} style={{ marginBottom: 20 }}>
          <summary><strong>部分修改／补图</strong> · 按任务名称或批次处理毛衣套图</summary>
          <p>保留已完成的正面、背面和咖啡馆三张，只补衣架展示或重做平铺图。修复结果单独保存，原任务与原成图保留。</p>
          <div className="formgrid">
            <label>任务名称（支持名称的一部分）
              <Input aria-label="部分修改任务名称" value={repairTitleQuery} disabled={busy}
                placeholder="例如：20261027-003136"
                onChange={(e) => { setRepairTitleQuery(e.target.value); setRepairSourceIds([]); setRepairPreview(null); setRepairResult(null); }} />
            </label>
            <label>批次（可选）
              <Input aria-label="部分修改批次" value={repairBatchNo} disabled={busy}
                placeholder="可从任务详情复制批次"
                onChange={(e) => { setRepairBatchNo(e.target.value); setRepairSourceIds([]); setRepairPreview(null); setRepairResult(null); }} />
            </label>
          </div>
          <details>
            <summary>更多保存设置</summary>
            <div className="formgrid">
              <label>原成图所在文件夹（移动过时填写）
                <Input aria-label="部分修改原成图文件夹" value={repairSourceRoot} disabled={busy}
                  placeholder="留空使用原记录中的位置"
                  onChange={(e) => { setRepairSourceRoot(e.target.value); setRepairPreview(null); setRepairResult(null); }} />
              </label>
              <label>修复结果保存文件夹（可选）
                <Input aria-label="部分修改结果文件夹" value={repairOutputFolder} disabled={busy}
                  placeholder="留空使用原成图所在文件夹"
                  onChange={(e) => { setRepairOutputFolder(e.target.value); setRepairPreview(null); setRepairResult(null); }} />
              </label>
            </div>
          </details>
          {!!repairSourceIds.length && <p>已指定 {repairSourceIds.length} 个任务；填写名称或批次可改为重新查找。</p>}
          <div className="buttons" aria-label="部分修改图片类型">
            {([['hanger', '衣架展示（半高领）'], ['flatlay', '平铺图（半高领）']] as const).map(([key, label]) => (
              <label key={key}><input type="checkbox" disabled={busy} checked={repairStepKeys.includes(key)}
                onChange={(e) => { setRepairStepKeys((keys) => e.target.checked ? [...keys, key] : keys.filter((value) => value !== key)); setRepairPreview(null); setRepairResult(null); }} />{' '}{label}</label>
            ))}
            <Button variant="outline" disabled={busy || !repairStepKeys.length || (!repairSourceIds.length && !repairTitleQuery.trim() && !repairBatchNo.trim())}
              onClick={() => previewRepairs()}>预览匹配任务</Button>
          </div>
          {repairError && <p role="alert">{repairError}</p>}
          {repairPreview && <div aria-label="部分修改预览">
            <p>匹配 {repairPreview.matched_count} 套 · 可修改 {repairPreview.eligible_count} 套 · 暂不可修改 {repairPreview.blocked_count} 套。</p>
            <div style={{ maxHeight: 320, overflow: 'auto' }}>
              <table><thead><tr><th>任务名称</th><th>批次</th><th>处理内容</th><th>状态</th></tr></thead>
                <tbody>{(repairPreview.matching || []).map((job: Row) => <tr key={job.id}>
                  <td>{job.title}<br /><small>{job.task_no}</small></td>
                  <td>{job.batch_no || '—'}</td>
                  <td>{job.eligible ? `保留 ${job.retained_count} 张，生成 ${job.regenerate_count} 张` : '保留原任务'}</td>
                  <td>{job.eligible ? '可创建修复任务' : job.reason || '请先检查原任务'}</td>
                </tr>)}</tbody>
              </table>
            </div>
            {!!repairPreview.eligible_count && <>
              <p>仅为上方可修改的任务创建修复副本。创建后需点击开始生成；其余原图沿用。</p>
              <Button disabled={busy || !form.browsers.length} onClick={prepareRepairs}>创建 {repairPreview.eligible_count} 套修复任务</Button>
              {!form.browsers.length && <p role="alert">请先在上方选择参与浏览器。</p>}
            </>}
          </div>}
          {repairResult && <div aria-label="部分修改结果">
            <p role="status">已准备 {repairResult.prepared_count || 0} 套修复任务，跳过已有修复 {repairResult.skipped?.length || 0} 套；原图保留。</p>
            {!!repairResult.errors?.length && <ul role="alert">{repairResult.errors.map((item: Row, index: number) => <li key={item.id || index}>{item.title || item.id}：{item.error}</li>)}</ul>}
          </div>}
        </details>
        <div className="buttons" aria-label="任务分类">
          {([
            ['all', '全部', jobs.length],
            ['pending', '未完成', jobs.filter((j) => j.batch_phase !== 'saved').length],
            ['saved', '已完成', summary.saved_jobs || 0],
            ['failed', '失败', summary.failed || 0],
            ['needs_review', '待复核', summary.needs_review || 0],
          ] as const).map(([key, label, count]) => (
            <Button
              key={key}
              variant={taskFilter === key ? 'default' : 'outline'}
              onClick={() => { setTaskFilter(key); setSelectedIds([]); setTaskPages({ pending: 1, saved: 1 }); }}
            >
              {label}（{count}）
            </Button>
          ))}
          {taskFilter === 'failed' && (
            <Button disabled={busy || !summary.failed} onClick={retryFailed}>
              一键重试全部失败任务
            </Button>
          )}
        </div>
        <div className="metricgrid" aria-label="任务总览">
          <div><strong>{summary.total_jobs || jobs.length}</strong><span>创建任务</span></div>
          <div><strong>{summary.sent_jobs || 0}</strong><span>已发送到 GPT</span></div>
          <div><strong>{summary.sent_today || 0}</strong><span>今日新发送</span></div>
          <div><strong>{summary.saved_jobs || 0}/{summary.total_jobs || jobs.length}</strong><span>已完成任务</span></div>
          <div><strong>{summary.saved_images || 0}/{summary.expected_images || 0}</strong><span>已保存图片</span></div>
          <div><strong>{summary.queued || 0}</strong><span>排队中</span></div>
          <div><strong>{summary.active || 0}</strong><span>执行中</span></div>
          <div><strong>{summary.failed || 0}</strong><span>失败</span></div>
          <div><strong>{summary.failed_steps || 0}</strong><span>失败图片</span></div>
          <div><strong>{summary.needs_review || 0}</strong><span>待复核</span></div>
            <div><strong>{summary.invalid_downloads || 0}</strong><span>误收原图</span></div>
        </div>
        {!!summary.recent_failures?.length && (
          <div className="panelnote">
            最近失败：{summary.recent_failures.slice(0, 3).map((failure: Row) => `${failure.task_no || '未知任务'}：${failure.message || '未记录原因'}`).join('；')}
          </div>
        )}
        <div className="buttons">
          <label>
            <input
              type="checkbox"
              checked={!!visibleJobs.length && selectedIds.length === visibleJobs.length}
              onChange={(e) =>
                setSelectedIds(
                  e.target.checked ? visibleJobs.map((job) => job.id) : [],
                )
              }
            />{' '}
            全选筛选结果
          </label>
          <span>已选择 {selectedIds.length} 个</span>
          <Button
            variant="outline"
            disabled={busy || !selectedIds.length}
            onClick={pauseSelected}
          >
            批量暂停
          </Button>
          <Button variant="outline" disabled={busy || !selectedIds.length} onClick={() => previewRepairs(selectedIds)}>
            部分修改选中任务
          </Button>
          <Button
            variant="outline"
            disabled={busy || !selectedIds.length || !form.browsers.length}
            onClick={reassignSelected}
          >
            按当前浏览器重新分配选中任务
          </Button>
          {confirmDelete ? (
            <>
              <Button
                variant="outline"
                disabled={busy || !selectedIds.length}
                onClick={deleteSelected}
              >
                确认批量删除选中任务（{selectedIds.length}）
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => setConfirmDelete(false)}>
                取消删除
              </Button>
            </>
          ) : (
            <Button
              variant="outline"
              disabled={busy || !selectedIds.length}
              onClick={() => setConfirmDelete(true)}
            >
              批量删除选中任务
            </Button>
          )}
          {!!selectedIds.length && (
            <Button variant="ghost" onClick={() => setSelectedIds([])}>
              取消选择
            </Button>
          )}
        </div>
        <div className="image-task-search">
          <Input aria-label="搜索任务" placeholder="搜索任务名称、编号或批次" value={taskQuery} onChange={(event) => { setTaskQuery(event.target.value); setSelectedIds([]); setTaskPages({ pending: 1, saved: 1 }); }} />
          <small>共 {visibleJobs.length} 个任务 · 每组按提交时间从新到旧</small>
        </div>
        {message && <output className="image-task-feedback">{message}</output>}
        {(['pending', 'saved'] as const).filter((group) => taskFilter === 'all' || (group === 'saved' ? taskFilter === 'saved' : taskFilter !== 'saved')).map((group) => {
          const rows = visibleJobs.filter((job) => (job.batch_phase === 'saved') === (group === 'saved'));
          const pages = Math.max(1, Math.ceil(rows.length / 20));
          const page = Math.min(taskPages[group], pages);
          const pageRows = rows.slice((page - 1) * 20, page * 20);
          return <section className="image-task-group" key={group} aria-label={group === 'saved' ? '已完成任务' : '未完成任务'}>
            <div className="image-task-group-head"><h3>{group === 'saved' ? '已完成' : '未完成'} <span className={'tag ' + (group === 'saved' ? 'green' : 'amber')}>{rows.length}</span></h3>
              <p>{group === 'saved' ? '审核成品，可重发整套或只重做指定步骤。' : '排队、执行中、暂停、失败和待核对的任务。'}</p></div>
            {!rows.length && <p className="image-task-group-empty">{taskQuery ? '没有匹配的任务。' : group === 'saved' ? '暂无已完成任务。' : '暂无未完成任务。'}</p>}
            {pageRows.map((j) => <ImageTaskCard key={j.id} job={j} busy={busy} canAssign={!!form.browsers.length}
              selected={selectedIds.includes(j.id)} onSelect={(checked) => setSelectedIds((ids) => checked ? [...ids, j.id] : ids.filter((id) => id !== j.id))}
              onDetail={() => loadDetail(j.id)} onRetry={(keys, confirmResend) => retryTask(j.id, keys, confirmResend)} onResume={() => resumeJob(j)}
              onPause={() => pauseJob(j.id)} onReassign={() => reassignBatch(j.batch_no)} onRepair={() => previewRepairs([j.id])} onMessage={setMessage} />)}
            {pages > 1 && <div className="buttons image-task-pagination" aria-label={group === 'saved' ? '已完成任务分页' : '未完成任务分页'}>
              <Button variant="outline" disabled={page <= 1} onClick={() => setTaskPages((previous) => ({ ...previous, [group]: page - 1 }))}>上一页</Button>
              <span>第 {page} / {pages} 页 · 每页 20 个</span>
              <Button variant="outline" disabled={page >= pages} onClick={() => setTaskPages((previous) => ({ ...previous, [group]: page + 1 }))}>下一页</Button>
            </div>}
          </section>;
        })}
      </section>
    </>
  );
}

