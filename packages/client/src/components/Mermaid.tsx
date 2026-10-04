import { useEffect, useId, useState } from 'react';

type MermaidApi = (typeof import('mermaid'))['default'];

let loading: Promise<MermaidApi> | null = null;
/** Mermaid is large: it is loaded the first time a diagram is shown, not with the app. */
function loadMermaid(): Promise<MermaidApi> {
  loading ??= import('mermaid').then(({ default: mermaid }) => {
    const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
    // strict: no click handlers or HTML labels from the diagram source, output sanitized
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: dark ? 'dark' : 'default',
    });
    return mermaid;
  });
  return loading;
}

let counter = 0;

/** A ```mermaid block drawn as a diagram; if it does not parse, the source and the error are shown instead. */
export function Mermaid({ source }: { source: string }) {
  const reactId = useId();
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    const id = `mermaid-${reactId.replace(/[^a-zA-Z0-9]/g, '')}-${++counter}`;
    loadMermaid()
      .then((mermaid) => mermaid.render(id, source))
      .then(({ svg: out }) => !cancelled && setSvg(out))
      .catch((e: unknown) => {
        // a failed render leaves its scratch element behind
        document.getElementById(id)?.remove();
        document.getElementById(`d${id}`)?.remove();
        if (!cancelled) {
          setSvg(null);
          setError(e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [source, reactId]);

  if (error)
    return (
      <div className="mermaid-error" data-testid="mermaid-error">
        <div className="error small-text">Diagram error: {error}</div>
        <pre>{source}</pre>
      </div>
    );
  if (svg === null)
    return (
      <div className="mermaid-loading muted small-text" data-testid="mermaid-loading">
        Drawing diagram…
      </div>
    );
  // the SVG comes from mermaid with securityLevel 'strict', which sanitizes it
  return (
    <div className="mermaid" data-testid="mermaid" dangerouslySetInnerHTML={{ __html: svg }} />
  );
}
