import { createContext, useContext } from 'react';
import type { DiffResponse } from '@quorum/shared';

export interface DiffRequest {
  title: string;
  load: () => Promise<DiffResponse>;
}

interface UiContextValue {
  openDiff: (req: DiffRequest) => void;
}

export const UiContext = createContext<UiContextValue>({ openDiff: () => {} });
export const useUi = () => useContext(UiContext);

export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}
