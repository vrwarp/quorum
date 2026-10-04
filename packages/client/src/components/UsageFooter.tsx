import { useEffect, useState } from 'react';
import { getUsage } from '../api';
import type { UsageResponse } from '../api';

/** "$1.23", or "$?" for a value that is not a number (a server that answers in another shape must not crash the room) */
function dollars(n: unknown): string {
  return typeof n === 'number' && Number.isFinite(n) ? `$${n.toFixed(2)}` : '$?';
}

/** The footer's tooltip: cost per agent role, e.g. "orchestrator $1.20, worker $0.40". */
export function usageTitle(usage: UsageResponse | null): string {
  if (!usage?.byRole) return '';
  return Object.entries(usage.byRole)
    .map(([role, u]) => `${role} ${dollars(typeof u === 'number' ? u : u?.costUsd)}`)
    .join(', ');
}

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
  return (
    <footer className="usage" data-testid="usage" title={usageTitle(usage)}>
      Agent cost: {usage ? dollars(usage.totalCostUsd) : '…'}
    </footer>
  );
}
