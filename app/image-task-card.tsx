'use client';
/* oxlint-disable typescript/no-explicit-any, next/no-img-element */
// Historical job snapshots have several schemas. Local images use backend-generated thumbnails.
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useWorkbenchMode } from './workbench-mode';
import './image-task-card.css';

type Row = Record<string, any>;
type Props = {
  job: Row; selected: boolean; busy: boolean; canAssign: boolean;
  onSelect: (selected: boolean) => void;
  onDetail: () => Promise<void>;
  onRetry: (keys?: string[], confirmResend?: boolean) => Promise<void>;
  onResume: () => Promise<void>;
  onPause: () => Promise<void>;
  onReassign: () => Promise<void>;
  onRepair: () => Promise<void>;
  onMessage: (message: string) => void;
};
const browserNames: Record<string, string> = { chrome: 'Chrome', edge: 'Edge', firefox: 'Firefox' };
const phaseNames: Record<string, string> = {
  saved: '已完成', queued: '排队中', claimed: '准备中', sending: '确认发送中', sent: '生成中',
  waiting: '生成中', downloading: '保存中', ready: '待执行', paused: '已暂停', failed: '失败',
  error: '失败', needs_review: '待核对', prepared: '待开始',
};
const activePhases = ['queued', 'claimed', 'sending', 'sent', 'waiting', 'downloading'];
function time(value: unknown) {
  if (!value) return '—';
  if (typeof value !== 'string' && typeof value !== 'number') return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}
function Thumb({ job, step, large = false, onOpen }: { job: Row; step: Row; large?: boolean; onOpen: () => void }) {
  const [failedVersion, setFailedVersion] = useState('');
  const url = `/api/image-jobs/${job.id}/outputs/${step.number}?thumbnail=1`;
  const version = url + ':' + step.saved_at + ':' + step.output;
  const failed = failedVersion === version;
  if (!step.output || step.phase !== 'saved' || failed) return <div className={'image-task-placeholder' + (large ? ' large' : '')}>
    <span>{failed ? '原图不可用' : phaseNames[step.phase] || '待生成'}</span>
  </div>;
  return <button type="button" className={'image-task-thumb' + (large ? ' large' : '')} onClick={onOpen}
    aria-label={`查看${step.label || '图片 ' + step.number}成品`} title="点击查看大图">
    <img loading="lazy" src={url} alt={step.label || '成品 ' + step.number} onError={() => setFailedVersion(version)} />
  </button>;
}
export default function ImageTaskCard({ job: j, selected, busy, canAssign, onSelect, onDetail, onRetry,
  onResume, onPause, onReassign, onRepair, onMessage }: Props) {
  const { professional, setMode } = useWorkbenchMode();
  const [keys, setKeys] = useState<string[]>([]);
  const [preview, setPreview] = useState<Row | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [retryConfirmation, setRetryConfirmation] = useState<{ keys?: string[] } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const confirmDialog = useRef<HTMLDialogElement>(null);
  const steps: Row[] = j.step_progress || j.steps || [];
  const savedCount = steps.filter((s) => s.phase === 'saved').length;
  const count = j.step_count || steps.length || j.expected_count || 0;
  const active = activePhases.includes(j.batch_phase);
  const needsReview = j.batch_phase === 'needs_review';
  const completed = j.batch_phase === 'saved';
  const firstEvent = (event: string) => j.logs?.find((log: Row) => log.event === event)?.at;
  const started = j.started_at || j.claimed_at || firstEvent('claimed');
  const sent = j.sent_at || firstEvent('sent');
  const retryBlocked = active;
  const uncertainFor = (stepKeys?: string[]) => {
    if (completed) return false;
    const selectedSteps = stepKeys ? steps.filter((step) => stepKeys.includes(step.key)) : steps;
    return needsReview || selectedSteps.some((step) => step.phase !== 'saved' &&
      (step.send_started_at || step.sent_at || ['sending', 'sent', 'waiting', 'downloading'].includes(step.phase))) ||
      (!j.workflow_mode && !!(j.has_sending_event || j.sent_at));
  };
  useEffect(() => {
    if (!preview) return;
    const current = dialog.current;
    current?.showModal();
    return () => { if (current?.open) current.close(); };
  }, [preview]);
  useEffect(() => {
    if (!retryConfirmation) return;
    const current = confirmDialog.current;
    current?.showModal();
    return () => { if (current?.open) current.close(); };
  }, [retryConfirmation]);
  const openPreview = (step: Row) => { setPreviewFailed(false); setPreview(step); };
  const requestRetry = (stepKeys?: string[]) => {
    if (uncertainFor(stepKeys)) setRetryConfirmation({ keys: stepKeys });
    else void onRetry(stepKeys);
  };
  const selectStep = (key: string, checked: boolean) => setKeys((previous) => checked ? [...previous, key] : previous.filter((value) => value !== key));
  return <article className={'image-task-card' + (completed ? ' completed' : '')} aria-label={'任务 ' + (j.task_no || j.id)}>
    <div className="image-task-heading">
      {professional && <label className="image-task-select"><input type="checkbox" checked={selected} onChange={(event) => onSelect(event.target.checked)}
        aria-label={'选择任务 ' + (j.task_no || j.id)} /></label>}
      <div className="image-task-title"><strong>{j.title || j.task_no}</strong>{professional && <small>{j.task_no || j.id.slice(0, 8).toUpperCase()}
        {j.repair_source_id || j.retry_source_id ? ' · 重试副本' : ''}</small>}</div>
      <span className={'tag ' + (completed ? 'green' : needsReview || j.batch_phase === 'failed' ? 'red' : 'amber')}>
        {phaseNames[j.batch_phase] || j.status || '待处理'}</span>
      <span className="image-task-count">{savedCount}/{count} 张</span>
    </div>
    {professional && <div className="image-task-times" aria-label="任务时间（北京时间）">
      <span>提交 <b>{time(j.queued_at || j.created || firstEvent('prepared'))}</b></span>
      <span>开始 <b>{time(started)}</b></span>
      <span>发送 <b>{time(sent)}</b></span>
      <span>{completed ? '完成' : j.failed_at || j.paused_at ? '停止' : '最近进展'} <b>{time(completed ? j.completed_at : j.failed_at || j.paused_at || j.last_progress_at)}</b></span>
    </div>}
    {professional && <p className="image-task-status">{j.status || phaseNames[j.batch_phase]}
      <span>{j.assigned_browser ? `${browserNames[j.assigned_browser] || j.assigned_browser} · ${j.assigned_worker?.slice(0, 8) || '待绑定配置'}` : '等待分配浏览器'}</span>
    </p>}
    {professional && j.error && <p className="image-task-error" role="alert">{j.error}</p>}
    {!professional && (needsReview || j.batch_phase === 'failed' || j.error) && <p className="image-task-error" role="alert">
      {needsReview ? '此任务已暂停，需核对原聊天后继续。' : '此任务未完成，请查看详情处理。'}已保存图片保留。
    </p>}
    {!!steps.length && <div className="image-task-filmstrip" aria-label="步骤成品缩略图">
      {steps.map((step) => <div key={step.number}>
        <Thumb job={j} step={step} onOpen={() => openPreview(step)} />
        <small>{step.number}. {step.label || '图片'}</small>
      </div>)}
    </div>}
    <div className="buttons image-task-main-actions">
      {professional && <Button variant="outline" disabled={busy || retryBlocked || !canAssign} onClick={() => requestRetry()}
        title={retryBlocked ? '运行中的任务请先暂停；发送结果不明时先核对原聊天' : '创建独立副本并排队，原任务和成图保留'}>重新发送整套任务</Button>}
      {active && <Button variant="outline" disabled={busy} onClick={onPause}>暂停</Button>}
      {!active && !completed && !needsReview && <Button variant="outline" disabled={busy || !canAssign} onClick={onResume}>
        {j.chat_url ? '回原聊天继续' : '开始生成 / 继续'}</Button>}
      {j.chat_url && <a className="external" href={j.chat_url} target="_blank" rel="noreferrer">打开原聊天 ↗</a>}
      {!professional && (needsReview || j.batch_phase === 'failed' || j.error) && <Button variant="outline" disabled={busy}
        onClick={() => setMode('professional')}>核对与处理</Button>}
    </div>
    {professional && needsReview && <p className="image-task-note">发送或收图结果需要核对。打开原聊天检查后，可手动重试指定步骤或重发整套；原任务与已保存图片保留。</p>}
    {professional && <details className="image-task-details" onToggle={(event) => { if (event.currentTarget.open) void onDetail(); }}>
      <summary>查看步骤与操作</summary>
      {!!steps.length && <>
        <div className="image-task-steps">
          {steps.map((step) => <section key={step.number} aria-label={'步骤 ' + step.number + ' ' + (step.label || '')}>
            <div className="image-task-step-title"><strong>{step.number}. {step.label || '图片'}</strong>
              <span className={'tag ' + (step.phase === 'saved' ? 'green' : 'amber')}>{phaseNames[step.phase] || step.status || '待执行'}</span></div>
            <Thumb job={j} step={step} large onOpen={() => openPreview(step)} />
            <small>发送 {time(step.sent_at || step.send_started_at)}<br />保存 {time(step.saved_at)}</small>
            {step.status && <p>{step.status}</p>}
            {step.key && j.workflow_mode && <div className="image-task-step-actions">
              <label><input type="checkbox" aria-label={'选择重试步骤 ' + step.number + ' ' + step.label}
                checked={keys.includes(step.key)} disabled={busy || retryBlocked} onChange={(event) => selectStep(step.key, event.target.checked)} />{' '}选择重试</label>
              <Button variant="outline" disabled={busy || retryBlocked || !canAssign} onClick={() => requestRetry([step.key])}>重试此步骤</Button>
            </div>}
          </section>)}
        </div>
        {j.workflow_mode && <div className="buttons"><Button disabled={busy || retryBlocked || !keys.length || !canAssign}
          onClick={() => requestRetry(keys)}>重试选中 {keys.length} 个步骤</Button>
          <small>其余已保存图片沿用，结果保存到独立副本。</small></div>}
      </>}
      <details className="image-task-fold"><summary>提示词</summary>
        <pre className="prompt">{j.prompt_template || '旧任务未记录整套提示词。'}</pre>
        {(j.steps || []).filter((step: Row) => step.prompt).map((step: Row) => <details key={step.number}>
          <summary>{step.number}. {step.label || '步骤'}提示词</summary><pre className="prompt">{step.prompt}</pre></details>)}
        <Button variant="outline" disabled={!j.prompt_template} onClick={async () => {
          try { await navigator.clipboard.writeText(j.prompt_template); onMessage('已复制任务提示词'); }
          catch { onMessage('复制失败，请手动选择提示词复制'); }
        }}>复制提示词</Button>
      </details>
      <details className="image-task-fold"><summary>执行日志（{j.logs?.length || 0}）</summary>
        {j.logs?.length ? <ol className="image-task-log">{j.logs.map((log: Row, index: number) => <li key={index}><time>{time(log.at)}</time> · {log.message}</li>)}</ol>
          : <p>旧任务暂无结构化日志。</p>}
      </details>
      <details className="image-task-fold"><summary>任务信息与更多操作</summary>
        <dl className="image-task-info"><dt>完整编号</dt><dd>{j.id}</dd><dt>批次</dt><dd>{j.batch_no || '—'}</dd>
          <dt>工作流</dt><dd>{j.workflow_label || j.template_archive || '旧模式'}</dd><dt>结果保存目录</dt><dd>{j.result_folder || '—'}</dd>
          <dt>主参考图</dt><dd>{j.reference || '—'}</dd><dt>参与浏览器</dt><dd>{(j.eligible_browsers || []).map((name: string) => browserNames[name] || name).join('、') || '—'}</dd>
          <dt>附加固定图</dt><dd>{j.fixed_images?.length || j.fixed_image_count || 0} 张</dd>
          <dt>创建时间</dt><dd>{j.created || '—'}</dd><dt>完成时间</dt><dd>{j.completed_at || '—'}</dd></dl>
        {!!j.reference_images?.length && <p className="image-task-paths">参考图：{j.reference_images.join('；')}</p>}
        <div className="buttons">
          {j.workflow_id?.startsWith('sweater-') && completed && <Button variant="outline" disabled={busy} onClick={onRepair}>部分修改／补图</Button>}
          {j.batch_no && ['queued', 'paused', 'failed'].includes(j.batch_phase) && <Button variant="outline" disabled={busy || !canAssign} onClick={onReassign}>按当前浏览器分配本批剩余任务</Button>}
        </div>
      </details>
    </details>}
    {retryConfirmation && <dialog className="image-task-dialog image-task-confirm" ref={confirmDialog}
      onCancel={() => setRetryConfirmation(null)} onClose={() => setRetryConfirmation(null)} aria-label="确认重试范围">
      <h3>核对后重新生成</h3>
      <p><strong>{j.title}</strong></p>
      <p>重试范围：{retryConfirmation.keys
        ? steps.filter((step) => retryConfirmation.keys?.includes(step.key)).map((step) => `${step.number}. ${step.label || '图片'}`).join('、')
        : `整套任务（${count} 个步骤）`}。</p>
      <p>原步骤已有发送记录，结果尚未确认。请先核对原聊天；重新生成可能重复消耗账号额度。新结果保存到独立副本，原任务、原图和发送记录保留。</p>
      <div className="buttons"><Button disabled={busy} onClick={() => {
        const selectedKeys = retryConfirmation.keys;
        setRetryConfirmation(null);
        void onRetry(selectedKeys, true);
      }}>已核对，创建重试任务</Button><Button variant="outline" onClick={() => setRetryConfirmation(null)}>取消</Button></div>
    </dialog>}
    {preview && <dialog className="image-task-dialog" ref={dialog} onCancel={() => setPreview(null)} onClose={() => setPreview(null)}
      aria-label={'成品预览 ' + (preview.label || preview.number)}>
      <div><strong>{j.title} · {preview.number}. {preview.label || '成品'}</strong><Button variant="outline" onClick={() => setPreview(null)}>关闭预览</Button></div>
      {previewFailed ? <p role="alert">原图无法读取，请检查结果目录是否已移动或文件已损坏。</p>
        : <img src={`/api/image-jobs/${j.id}/outputs/${preview.number}`} alt={preview.label || '成品预览'} onError={() => setPreviewFailed(true)} />}
      <small>保存于 {time(preview.saved_at)}</small>
    </dialog>}
  </article>;
}
