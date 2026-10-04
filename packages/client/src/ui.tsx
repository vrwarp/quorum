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

/** A sha, or a revision such as `<sha>~1` (the parent of a change), in short form. */
export function shortRef(ref: string): string {
  const m = /^([0-9a-f]{7,40})([~^]\d*)$/i.exec(ref);
  return m ? `${shortSha(m[1]!)}${m[2]}` : shortSha(ref);
}
