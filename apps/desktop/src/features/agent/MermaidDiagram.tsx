import { useEffect, useRef, useState } from 'react';

/** Renders one Mermaid source block, or hands the source back when it cannot be parsed. */
export function MermaidDiagram({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const renderId = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const currentId = ++renderId.current;
    setSvg(null);
    setFailed(false);

    void (async () => {
      try {
        // Mermaid is a large dependency and only mind-map previews need it.
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
        const result = await mermaid.render(`artifact-mermaid-${currentId}`, code);
        if (cancelled) return;
        setSvg(result.svg);
      } catch {
        if (cancelled) return;
        setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [code]);

  if (failed) {
    return (
      <div className="space-y-2">
        <p className="text-xs text-stone-500">这段图表源码无法渲染，已按原文显示。</p>
        <pre className="overflow-x-auto rounded-lg bg-stone-100 p-3 text-xs leading-5 text-stone-800">
          {code}
        </pre>
      </div>
    );
  }

  if (!svg) {
    return <p className="text-xs text-stone-500">正在渲染图表…</p>;
  }

  // Mermaid output is generated from the file's own text under strict security level.
  return (
    <div
      className="overflow-x-auto rounded-lg border border-stone-200 bg-white p-3 [&_svg]:h-auto [&_svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/** Splits a Markdown document into text chunks and Mermaid blocks. */
export function splitMermaidBlocks(
  source: string,
): Array<{ kind: 'markdown'; text: string } | { kind: 'mermaid'; code: string }> {
  const blocks: Array<{ kind: 'markdown'; text: string } | { kind: 'mermaid'; code: string }> = [];
  const pattern = /```mermaid[ \t]*\r?\n([\s\S]*?)```/g;
  let lastIndex = 0;

  for (const match of source.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      blocks.push({ kind: 'markdown', text: source.slice(lastIndex, start) });
    }
    blocks.push({ kind: 'mermaid', code: match[1].trim() });
    lastIndex = start + match[0].length;
  }
  if (lastIndex < source.length) {
    blocks.push({ kind: 'markdown', text: source.slice(lastIndex) });
  }
  return blocks.length > 0 ? blocks : [{ kind: 'markdown', text: source }];
}
