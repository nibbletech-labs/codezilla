import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import "../../styles/markdownSourceEditor.css";

export interface MarkdownSourceEditorHandle {
  getMarkdown: () => string;
}

type Appearance = "dark" | "light";

interface MarkdownSourceEditorProps {
  value: string;
  appearance: Appearance;
  onChange: (markdown: string) => void;
  onSave: () => void;
}

// Structural theme only — colours come from the highlight styles below and the
// CSS variables in markdownSourceEditor.css, so the editor chrome tracks the
// app's light/dark palette automatically.
const editorTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "13px" },
  ".cm-scroller": {
    fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace",
    lineHeight: "1.6",
  },
  ".cm-content": { padding: "12px 0" },
});

// One Dark-derived palette — legible markdown + embedded-code highlighting on
// the app's dark background.
const darkHighlight = HighlightStyle.define([
  { tag: [t.heading, t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6], color: "#61afef", fontWeight: "600" },
  { tag: t.strong, fontWeight: "700", color: "#d19a66" },
  { tag: t.emphasis, fontStyle: "italic", color: "#c678dd" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.link, t.url], color: "#61afef", textDecoration: "underline" },
  { tag: t.monospace, color: "#98c379" },
  { tag: [t.contentSeparator, t.meta, t.processingInstruction], color: "#7f848e" },
  { tag: t.quote, color: "#98c379", fontStyle: "italic" },
  { tag: [t.list], color: "#c678dd" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "#7f848e", fontStyle: "italic" },
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword], color: "#c678dd" },
  { tag: [t.string, t.special(t.string)], color: "#98c379" },
  { tag: [t.number, t.bool, t.atom], color: "#d19a66" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.propertyName], color: "#61afef" },
  { tag: [t.typeName, t.className, t.namespace], color: "#e5c07b" },
  { tag: [t.tagName], color: "#e06c75" },
  { tag: [t.attributeName], color: "#d19a66" },
  { tag: [t.operator, t.punctuation, t.separator], color: "#abb2bf" },
]);

// One Light-derived palette for the app's light appearance.
const lightHighlight = HighlightStyle.define([
  { tag: [t.heading, t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6], color: "#4078f2", fontWeight: "600" },
  { tag: t.strong, fontWeight: "700", color: "#b76b01" },
  { tag: t.emphasis, fontStyle: "italic", color: "#a626a4" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.link, t.url], color: "#4078f2", textDecoration: "underline" },
  { tag: t.monospace, color: "#50a14f" },
  { tag: [t.contentSeparator, t.meta, t.processingInstruction], color: "#a0a1a7" },
  { tag: t.quote, color: "#50a14f", fontStyle: "italic" },
  { tag: [t.list], color: "#a626a4" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "#a0a1a7", fontStyle: "italic" },
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword], color: "#a626a4" },
  { tag: [t.string, t.special(t.string)], color: "#50a14f" },
  { tag: [t.number, t.bool, t.atom], color: "#b76b01" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.propertyName], color: "#4078f2" },
  { tag: [t.typeName, t.className, t.namespace], color: "#c18401" },
  { tag: [t.tagName], color: "#e45649" },
  { tag: [t.attributeName], color: "#b76b01" },
  { tag: [t.operator, t.punctuation, t.separator], color: "#383a42" },
]);

function highlightFor(appearance: Appearance) {
  return syntaxHighlighting(appearance === "dark" ? darkHighlight : lightHighlight);
}

const MarkdownSourceEditor = forwardRef<
  MarkdownSourceEditorHandle,
  MarkdownSourceEditorProps
>(function MarkdownSourceEditor({ value, appearance, onChange, onSave }, ref) {
  const rootRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const themeCompartment = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);

  useEffect(() => {
    onChangeRef.current = onChange;
    onSaveRef.current = onSave;
  }, [onChange, onSave]);

  useImperativeHandle(
    ref,
    () => ({
      getMarkdown: () => viewRef.current?.state.doc.toString() ?? value,
    }),
    [value],
  );

  // Mount once. The parent remounts (via a key) to reset the buffer to a new
  // base; live edits flow out through onChange.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const saveKeymap = Prec.highest(
      keymap.of([
        {
          key: "Mod-s",
          run: () => {
            onSaveRef.current();
            return true;
          },
        },
      ]),
    );

    const state = EditorState.create({
      doc: value,
      extensions: [
        saveKeymap,
        basicSetup,
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        editorTheme,
        themeCompartment.current.of(highlightFor(appearance)),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
      ],
    });

    const view = new EditorView({ state, parent: root });
    viewRef.current = view;
    view.focus();

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Swap the syntax theme in place when the app appearance changes, without
  // tearing down the editor (preserves the buffer and cursor).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: themeCompartment.current.reconfigure(highlightFor(appearance)),
    });
  }, [appearance]);

  return <div ref={rootRef} className="codezilla-md-source" />;
});

export default MarkdownSourceEditor;
