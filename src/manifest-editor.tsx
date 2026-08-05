import { useEffect, useRef } from "react";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import { yaml } from "@codemirror/lang-yaml";
import { bracketMatching, foldGutter, foldKeymap, HighlightStyle, indentOnInput, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { lintGutter, setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { EditorState, Transaction, type Range } from "@codemirror/state";
import { Decoration, drawSelection, dropCursor, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { tr, type AppLanguage } from "./i18n";
import type { ManifestDiagnostic, ManifestFormat } from "./manifest-format";
import "./manifest-editor.css";

const manifestHighlightStyle = HighlightStyle.define([
  { tag: [tags.propertyName, tags.attributeName, tags.definition(tags.propertyName)], color: "var(--manifest-syntax-key)" },
  { tag: [tags.string, tags.special(tags.string), tags.content, tags.attributeValue], color: "var(--manifest-syntax-string)" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "var(--manifest-syntax-literal)" },
  { tag: [tags.keyword, tags.operatorKeyword, tags.controlKeyword], color: "var(--manifest-syntax-keyword)" },
  { tag: [tags.typeName, tags.className, tags.namespace], color: "var(--manifest-syntax-type)" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "var(--manifest-syntax-comment)", fontStyle: "italic" },
  { tag: [tags.punctuation, tags.separator, tags.brace, tags.squareBracket, tags.paren], color: "var(--manifest-syntax-punctuation)" },
  { tag: [tags.invalid], color: "var(--manifest-syntax-invalid)", textDecoration: "underline" },
]);

const yamlNumberPattern = /^[+-]?(?:(?:0|[1-9][\d_]*)(?:\.[\d_]*)?(?:e[+-]?[\d_]+)?|0x[\da-f_]+|0o[0-7_]+|0b[01_]+|\.(?:inf|nan))$/i;
const yamlLiteralPattern = /^(?:true|false|null|~)$/i;
const yamlScalarLiteralMark = Decoration.mark({ class: "cm-yaml-scalar-literal" });

function yamlScalarDecorations(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const visible of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from: visible.from,
      to: visible.to,
      enter(node) {
        if (node.name !== "Literal" || node.node.parent?.name === "Key") return;
        const value = view.state.doc.sliceString(node.from, node.to).trim();
        if (yamlLiteralPattern.test(value) || yamlNumberPattern.test(value)) {
          ranges.push(yamlScalarLiteralMark.range(node.from, node.to));
        }
      },
    });
  }
  return Decoration.set(ranges, true);
}

const yamlScalarHighlighting = ViewPlugin.fromClass(class {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = yamlScalarDecorations(view);
  }

  update(update: ViewUpdate) {
    this.decorations = yamlScalarDecorations(update.view);
  }
}, {
  decorations: (value) => value.decorations,
});

export function ManifestEditor({
  documentId,
  value,
  format,
  theme,
  fontFamily,
  fontSize,
  diagnostics,
  selection,
  language,
  readOnly = false,
  onChange,
  onFind,
}: {
  documentId: string;
  value: string;
  format: ManifestFormat;
  theme: "light" | "dark";
  fontFamily: string;
  fontSize: number;
  diagnostics: ManifestDiagnostic[];
  selection?: { from: number; to: number };
  language: AppLanguage;
  readOnly?: boolean;
  onChange: (value: string) => void;
  onFind: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onFindRef = useRef(onFind);
  onChangeRef.current = onChange;
  onFindRef.current = onFind;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        foldGutter(),
        lintGutter(),
        history(),
        drawSelection(),
        dropCursor(),
        indentOnInput(),
        bracketMatching(),
        syntaxHighlighting(manifestHighlightStyle),
        highlightActiveLine(),
        EditorState.tabSize.of(2),
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
        EditorView.contentAttributes.of({
          "aria-label": tr(language, "manifestEditor", { format: format.toUpperCase() }),
          "aria-multiline": "true",
          spellcheck: "false",
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !readOnly) onChangeRef.current(update.state.doc.toString());
        }),
        keymap.of([
          {
            key: "Mod-f",
            run: () => {
              onFindRef.current();
              return true;
            },
          },
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
          ...foldKeymap,
        ]),
        format === "json" ? json() : [yaml(), yamlScalarHighlighting],
      ],
    });
    const view = new EditorView({ state, parent: host });
    viewRef.current = view;
    const frame = window.requestAnimationFrame(() => view.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      view.destroy();
      viewRef.current = null;
    };
    // fontSize/fontFamily intentionally omitted: content zoom updates those
    // continuously and must not tear down the CodeMirror instance.
  }, [documentId, format, language, readOnly]);

  // Host styles already inherit into .cm-editor/.cm-scroller. Re-measure after
  // Cmd/Ctrl+wheel font changes so gutters and line heights stay aligned.
  useEffect(() => {
    viewRef.current?.requestMeasure();
  }, [fontSize, fontFamily]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      annotations: Transaction.addToHistory.of(false),
    });
  }, [value, documentId, format]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const length = view.state.doc.length;
    const nextDiagnostics: Diagnostic[] = diagnostics.map((entry) => ({
      from: Math.max(0, Math.min(length, entry.from)),
      to: Math.max(0, Math.min(length, Math.max(entry.from, entry.to))),
      severity: entry.severity,
      source: format.toUpperCase(),
      message: entry.message,
    }));
    view.dispatch(setDiagnostics(view.state, nextDiagnostics));
  }, [diagnostics, documentId, format, value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !selection) return;
    const from = Math.max(0, Math.min(view.state.doc.length, selection.from));
    const to = Math.max(from, Math.min(view.state.doc.length, selection.to));
    view.dispatch({
      selection: { anchor: from, head: to },
      effects: EditorView.scrollIntoView(from, { y: "center" }),
    });
    view.focus();
  }, [selection?.from, selection?.to, documentId, format]);

  return <div ref={hostRef} className={`manifest-editor manifest-theme-${theme}`} style={{ fontFamily, fontSize }} data-format={format} data-document-id={documentId} />;
}

export default ManifestEditor;
