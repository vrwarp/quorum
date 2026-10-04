import { useEffect, useState } from 'react';

const NAV_EVENT = 'quorum:navigate';

export function navigate(path: string, replace = false): void {
  if (location.pathname === path) return;
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  window.dispatchEvent(new Event(NAV_EVENT));
}

export function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const h = () => setPath(location.pathname);
    window.addEventListener('popstate', h);
    window.addEventListener(NAV_EVENT, h);
    return () => {
      window.removeEventListener('popstate', h);
      window.removeEventListener(NAV_EVENT, h);
    };
  }, []);
  return path;
}

export type Route = { name: 'home' } | { name: 'rooms' } | { name: 'settings' } | { name: 'room'; roomId: string } | { name: 'unknown' };

export function parseRoute(path: string): Route {
  const p = path.replace(/\/+$/, '') || '/';
  if (p === '/') return { name: 'home' };
  if (p === '/rooms') return { name: 'rooms' };
  if (p === '/settings') return { name: 'settings' };
  const m = /^\/rooms\/([^/]+)$/.exec(p);
  if (m && m[1]) return { name: 'room', roomId: decodeURIComponent(m[1]) };
  return { name: 'unknown' };
}

export function roomPath(roomId: string): string {
  return `/rooms/${encodeURIComponent(roomId)}`;
}
