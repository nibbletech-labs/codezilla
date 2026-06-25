import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { CrepeBuilder } from "@milkdown/crepe/builder";
import { codeMirror } from "@milkdown/crepe/feature/code-mirror";
import { cursor } from "@milkdown/crepe/feature/cursor";
import { linkTooltip } from "@milkdown/crepe/feature/link-tooltip";
import { listItem } from "@milkdown/crepe/feature/list-item";
import { placeholder } from "@milkdown/crepe/feature/placeholder";
import { table } from "@milkdown/crepe/feature/table";
import { topBar } from "@milkdown/crepe/feature/top-bar";
import { toolbar } from "@milkdown/crepe/feature/toolbar";
import "@milkdown/crepe/theme/common/prosemirror.css";
import "@milkdown/crepe/theme/common/reset.css";
import "@milkdown/crepe/theme/common/code-mirror.css";
import "@milkdown/crepe/theme/common/cursor.css";
import "@milkdown/crepe/theme/common/link-tooltip.css";
import "@milkdown/crepe/theme/common/list-item.css";
import "@milkdown/crepe/theme/common/placeholder.css";
import "@milkdown/crepe/theme/common/table.css";
import "@milkdown/crepe/theme/common/top-bar.css";
import "@milkdown/crepe/theme/common/toolbar.css";
import "@milkdown/crepe/theme/frame-dark.css";
import "../../styles/milkdownEditor.css";

export interface MilkdownMarkdownEditorHandle {
  getMarkdown: () => string;
}

interface MilkdownMarkdownEditorProps {
  value: string;
  onChange: (markdown: string) => void;
}

const MilkdownMarkdownEditor = forwardRef<
  MilkdownMarkdownEditorHandle,
  MilkdownMarkdownEditorProps
>(function MilkdownMarkdownEditor({ value, onChange }, ref) {
  const rootRef = useRef<HTMLDivElement>(null);
  const crepeRef = useRef<CrepeBuilder | null>(null);
  const latestMarkdownRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useImperativeHandle(
    ref,
    () => ({
      getMarkdown: () => crepeRef.current?.getMarkdown() ?? latestMarkdownRef.current,
    }),
    [],
  );

  useEffect(() => {
    latestMarkdownRef.current = value;
    setError(null);

    const root = rootRef.current;
    if (!root) return;

    let disposed = false;
    const crepe = new CrepeBuilder({
      root,
      defaultValue: value,
    })
      .addFeature(cursor)
      .addFeature(listItem)
      .addFeature(linkTooltip)
      .addFeature(toolbar)
      .addFeature(codeMirror)
      .addFeature(table)
      .addFeature(topBar)
      .addFeature(placeholder, {
        text: "Start writing...",
        mode: "doc",
      });

    crepeRef.current = crepe;
    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, markdown) => {
        latestMarkdownRef.current = markdown;
        if (!disposed) onChangeRef.current(markdown);
      });
    });

    crepe.create().catch((err) => {
      if (!disposed) setError(String(err));
    });

    return () => {
      disposed = true;
      crepeRef.current = null;
      crepe.destroy().catch(console.error);
    };
  }, [value]);

  return (
    <div className="codezilla-milkdown-editor">
      <div ref={rootRef} className="codezilla-milkdown-root" />
      {error && <div className="codezilla-milkdown-error">{error}</div>}
    </div>
  );
});

export default MilkdownMarkdownEditor;
