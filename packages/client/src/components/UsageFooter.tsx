import { useEffect, useState } from 'react';
import { getUsage } from '../api';
import type { UsageResponse } from '../api';

export function UsageFooter({ roomId }: { roomId: string }) {
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      getUsage(roomId)
        .then((u) => !cancelled && setUsage(u))
        .catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [roomId]);
  const byRole = usage
    ? Object.entries(usage.byRole)
        .map(([r, c]) => `${r} $${c.toFixed(2)}`)
        .join(', ')
    : '';
  return (
    <footer className="usage" data-testid="usage" title={byRole}>
      Agent cost: {usage ? `$${usage.totalCostUsd.toFixed(2)}` : '…'}
    </footer>
  );
}
