import { isValidElement, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform, type UrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Mermaid } from './Mermaid';

const plugins = [remarkGfm];

/** Raster and SVG images embedded in the document. An <img> never runs script, SVG included. */
const DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml)[;,]/i;

/** The default transform drops every `data:` URL; embedded images are let through, and only as image sources. */
export const urlTransform: UrlTransform = (url, key, node) =>
  key === 'src' && node.tagName === 'img' && DATA_IMAGE.test(url) ? url : defaultUrlTransform(url);

/** The text of a code element's children (react-markdown hands it over as a string or an array of strings). */
function codeText(children: ReactNode): string {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(codeText).join('');
  return '';
}

export function Markdown({
  children,
  definitions,
}: {
  children: string;
  /** link reference definitions from elsewhere in the document, so `![alt][label]` in this piece resolves */
  definitions?: string;
}) {
  const source = definitions ? `${children}\n\n${definitions}` : children;
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={plugins}
        urlTransform={urlTransform}
        components={{
          a: ({ node: _n, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
          img: ({ node: _n, alt, ...props }) => <img {...props} alt={alt ?? ''} loading="lazy" />,
          pre: ({ node: _n, children: inner, ...props }) => {
            // a ```mermaid fence is drawn as a diagram instead of shown as code
            if (isValidElement<{ className?: string; children?: ReactNode }>(inner)) {
              const { className, children: code } = inner.props;
              if (/\blanguage-mermaid\b/.test(className ?? ''))
                return <Mermaid source={codeText(code).replace(/\n$/, '')} />;
            }
            return <pre {...props}>{inner}</pre>;
          },
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
