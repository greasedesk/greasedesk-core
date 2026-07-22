/**
 * File: components/content/PublicDocument.tsx
 * Renders a content-system document's markdown SAFELY on the public site. react-markdown does NOT
 * render raw HTML (no rehype-raw), so a `<script>` or any HTML in the editor body renders as inert
 * text — no injection from the editor. Visible gap markers like [YOU SUPPLY: …] render as literal
 * text (they aren't markdown), so a draft-with-gaps shows the gaps rather than hiding them.
 */
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const md: Components = {
  h1: (p) => <h2 className="text-2xl font-bold text-ink mt-8 mb-3" {...p} />,
  h2: (p) => <h2 className="text-xl font-semibold text-ink mt-6 mb-2" {...p} />,
  h3: (p) => <h3 className="text-lg font-semibold text-ink mt-5 mb-2" {...p} />,
  p: (p) => <p className="text-sm text-muted leading-relaxed my-3" {...p} />,
  ul: (p) => <ul className="list-disc pl-5 text-sm text-muted space-y-1 my-3" {...p} />,
  ol: (p) => <ol className="list-decimal pl-5 text-sm text-muted space-y-1 my-3" {...p} />,
  a: (p) => <a className="text-accent hover:underline" {...p} />,
  strong: (p) => <strong className="text-ink font-semibold" {...p} />,
  hr: () => <hr className="my-6 border-line" />,
  blockquote: (p) => <blockquote className="border-l-4 border-amber-300 bg-amber-50 text-amber-900 px-3 py-2 my-4 text-sm rounded-r" {...p} />,
  code: (p) => <code className="font-mono text-xs bg-surface-muted px-1 py-0.5 rounded" {...p} />,
  table: (p) => <div className="overflow-x-auto rounded-xl border border-line my-4"><table className="w-full text-sm" {...p} /></div>,
  thead: (p) => <thead className="bg-surface-muted text-muted text-left" {...p} />,
  th: (p) => <th className="px-3 py-2 font-medium whitespace-nowrap" {...p} />,
  td: (p) => <td className="px-3 py-2 text-muted border-t border-line align-top" {...p} />,
};

export default function PublicDocument({ title, body, effectiveFrom, version }: { title: string; body: string; effectiveFrom?: string | null; version?: string }) {
  return (
    <main className="max-w-3xl mx-auto px-4 sm:px-6 py-12">
      <h1 className="text-3xl font-extrabold text-ink tracking-tight">{title}</h1>
      {(version || effectiveFrom) && (
        <p className="mt-2 text-xs text-muted">
          {version && <>Version <span className="font-mono">{version}</span></>}
          {effectiveFrom && <> · effective {effectiveFrom}</>}
        </p>
      )}
      <div className="mt-4"><ReactMarkdown remarkPlugins={[remarkGfm]} components={md}>{body}</ReactMarkdown></div>
    </main>
  );
}
