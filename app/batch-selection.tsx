'use client';
import {useEffect, useRef, useState} from 'react';
import {Button} from '@/components/ui/button';
import './batch-selection.css';

export type BatchColumn<T> = {label: string; value: (row: T) => unknown};
export type BatchCopyField<T> = {label: string; value: (row: T) => unknown};
export function batchCellText(value: unknown):string {
  if(value == null) return '';
  if(typeof value === 'string') return value;
  if(typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint' || typeof value === 'symbol') return String(value);
  return JSON.stringify(value) || '';
}
const cellText=batchCellText;

// Keep selections local to the exact shop, filter and row identities. A changed
// scope is invalid immediately, before an effect can run after the render.
export function useBatchSelection<T>(rows: T[], scope: string, keyOf: (row: T) => string) {
  const token = JSON.stringify([scope, rows.map(keyOf)]);
  const [state, setState] = useState<{token: string; keys: Set<string>; only: boolean}>({token: '', keys: new Set(), only: false});
  // Commit invalidation as soon as the scope changes, so visiting an earlier
  // filter again cannot resurrect a previous selection.
  if(state.token !== token) setState({token, keys:new Set(), only:false});
  const keys = state.token === token ? state.keys : new Set<string>();
  const onlySelected = state.token === token && state.only;
  const selectedRows = rows.filter(row => keys.has(keyOf(row)));
  const update = (next: Set<string>, only = onlySelected) => setState({token, keys: next, only: next.size > 0 && only});
  return {
    scope: token, selectedRows, selectedKeys: keys, onlySelected,
    visibleRows: onlySelected ? selectedRows : rows,
    isSelected: (row: T) => keys.has(keyOf(row)),
    toggle: (row: T, checked: boolean) => {const next = new Set(keys); if (checked) next.add(keyOf(row)); else next.delete(keyOf(row)); update(next);},
    selectAll: () => update(new Set(rows.map(keyOf))),
    clear: () => update(new Set(), false),
    toggleView: () => update(new Set(keys), !onlySelected),
  };
}
export type BatchSelection<T> = ReturnType<typeof useBatchSelection<T>>;

type ToolsProps<T> = {
  selection: BatchSelection<T>; total: number; label: string;
  copyFields: BatchCopyField<T>[]; columns: BatchColumn<T>[];
};
export function BatchSelectionTools<T>(props:ToolsProps<T>){
  return <BatchSelectionToolsContent key={props.selection.scope} {...props}/>;
}
function BatchSelectionToolsContent<T>({selection, total, label, copyFields, columns}:ToolsProps<T>) {
  const [message, setMessage] = useState({scope:'',text:''});
  const [previewScope, setPreviewScope] = useState<string|null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const count = selection.selectedRows.length;
  const validPreview = previewScope === selection.scope && count > 0;
  useEffect(() => {
    if (validPreview) dialog.current?.showModal(); else dialog.current?.close();
  }, [validPreview]);
  const ids = (field: BatchCopyField<T>) => [...new Set(selection.selectedRows.flatMap(row => {const value=field.value(row); return (Array.isArray(value) ? value : [value]).map(item=>cellText(item).trim());}).filter(Boolean))];
  async function copy(text: string, description: string) {
    try {
      if (!navigator.clipboard?.writeText) throw Error('当前浏览器不支持自动复制');
      await navigator.clipboard.writeText(text);
      setMessage({scope:selection.scope,text:'已复制' + description + '。'});
    } catch {
      setPreviewScope(selection.scope);
      setMessage({scope:selection.scope,text:'自动复制未成功，可在“查看所选”中选中文字后按 Ctrl+C。'});
    }
  }
  const tableCell=(value:unknown)=>{const text=cellText(value).replace(/[\t\r\n]+/g,' ');return /^[=+@-]/.test(text)?"'"+text:text;};
  const tableText = [columns.map(column => column.label).join('\t'), ...selection.selectedRows.map(row => columns.map(column => tableCell(column.value(row))).join('\t'))].join('\n');
  return <fieldset className="batch-selection" aria-label={label + '批量选择'}>
    <div className="batch-selection-actions">
      <strong>已选 {count} / {total} 条</strong>
      <Button variant="outline" disabled={!total} onClick={selection.selectAll}>全选当前筛选（{total}）</Button>
      <Button variant="outline" disabled={!count} onClick={selection.clear}>清空选择</Button>
      {copyFields.map(field => <Button key={field.label} variant="outline" disabled={!count || !ids(field).length} onClick={() => copy(ids(field).join('\n'), ' ' + ids(field).length + ' 个 ' + field.label + '，每行一个，已去重')}>复制所选 {field.label}</Button>)}
      <Button variant="outline" disabled={!count} onClick={() => setPreviewScope(selection.scope)}>查看所选（{count}）</Button>
      <Button variant={selection.onlySelected ? 'default' : 'outline'} disabled={!count} onClick={selection.toggleView}>{selection.onlySelected ? '显示全部筛选结果' : '仅看所选'}</Button>
    </div>
    <p className="batch-selection-note">全选包含当前筛选的所有页；切换店铺、筛选或清单范围会清空选择。</p>
    {message.scope===selection.scope && message.text && <output className="batch-selection-note">{message.text}</output>}
    <dialog ref={dialog} className="batch-selection-dialog" aria-label={label + '所选清单'} onCancel={() => setPreviewScope(null)} onClose={() => setPreviewScope(null)}>
      {validPreview && <>
        <div className="sectionhead"><h2>{label} · 已选 {count} 条</h2><Button autoFocus variant="outline" onClick={() => setPreviewScope(null)}>关闭</Button></div>
        <div className="batch-selection-actions"><Button onClick={() => copy(tableText, '所选表格，可粘贴到 Excel')}>复制所选表格</Button></div>
        <div className="tablewrap batch-selection-preview"><table><thead><tr>{columns.map(column => <th key={column.label}>{column.label}</th>)}</tr></thead><tbody>{selection.selectedRows.map((row, index) => <tr key={index}>{columns.map(column => <td key={column.label}>{cellText(column.value(row)) || '—'}</td>)}</tr>)}</tbody></table></div>
        <label className="field"><span>所选编号（可手动复制，每行一个）</span><textarea aria-label={label + '所选编号'} readOnly rows={5} value={copyFields[0] ? ids(copyFields[0]).join('\n') : ''} onFocus={event => event.target.select()}/></label>
      </>}
    </dialog>
  </fieldset>;
}
