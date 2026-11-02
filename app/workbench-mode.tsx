'use client';
import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import './workbench-mode.css';

export type WorkbenchMode = 'simple' | 'professional';
export const WORKBENCH_MODE_STORAGE_KEY = 'textile-workbench-ui-mode';
type ModeContext = {
  mode: WorkbenchMode;
  professional: boolean;
  setMode: (mode: WorkbenchMode) => void;
};
const Context = createContext<ModeContext>({
  mode: 'simple', professional: false, setMode: () => {},
});

let memoryMode: WorkbenchMode = 'simple';
const changeEvent = 'workbench-mode-change';
function readMode(): WorkbenchMode {
  try {
    const saved = localStorage.getItem(WORKBENCH_MODE_STORAGE_KEY);
    if (saved === 'professional' || saved === 'simple') return saved;
  } catch {}
  return memoryMode;
}
function subscribe(notify: () => void) {
  function onStorage(event: StorageEvent) {
    if (event.key === WORKBENCH_MODE_STORAGE_KEY || event.key === null) notify();
  }
  window.addEventListener('storage', onStorage);
  window.addEventListener(changeEvent, notify);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(changeEvent, notify);
  };
}
function setMode(next: WorkbenchMode) {
  memoryMode = next;
  try { localStorage.setItem(WORKBENCH_MODE_STORAGE_KEY, next); } catch {}
  window.dispatchEvent(new Event(changeEvent));
}
export function WorkbenchModeProvider({ children }: { children: ReactNode }) {
  const mode = useSyncExternalStore(subscribe, readMode, () => 'simple' as WorkbenchMode);
  return <Context.Provider value={{mode, professional: mode === 'professional', setMode}}>
    {children}
  </Context.Provider>;
}

export function useWorkbenchMode() { return useContext(Context); }

export function WorkbenchModeSwitch() {
  const { mode, setMode } = useWorkbenchMode();
  return <fieldset className="workbench-mode-switch" aria-label="工作模式">
    <button type="button" aria-pressed={mode === 'simple'} onClick={() => setMode('simple')}>普通模式</button>
    <button type="button" aria-pressed={mode === 'professional'} onClick={() => setMode('professional')}>专业模式</button>
  </fieldset>;
}
