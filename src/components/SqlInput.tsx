import { useMemo, useRef } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { EditorState, Prec } from "@codemirror/state";
import { acceptCompletion } from "@codemirror/autocomplete";
import { keymap } from "@codemirror/view";
import type { Kind } from "../api";
import { sqlExtensions } from "../sqlComplete";

interface Props {
  kind: Kind;
  table: string;
  columns: string[];
  value: string;
  onChange: (v: string) => void;
  /** Enter, when no completion is open. */
  onSubmit: () => void;
  placeholder?: string;
  dark: boolean;
}

/** Single-line SQL field with column completion for one table (the WHERE filter). */
export function SqlInput({ kind, table, columns, value, onChange, onSubmit, placeholder, dark }: Props) {
  const submit = useRef(onSubmit);
  submit.current = onSubmit;
  const extensions = useMemo(
    () => [
      ...sqlExtensions(kind, { [table]: columns }, table),
      Prec.highest(keymap.of([{ key: "Enter", run: (view) => {
        if (!acceptCompletion(view)) submit.current();
        return true;
      } }])),
      EditorState.transactionFilter.of((tr) => (tr.newDoc.lines > 1 ? [] : tr)),
    ],
    [kind, table, columns],
  );
  return (
    <CodeMirror
      className="sql-input"
      value={value}
      onChange={onChange}
      extensions={extensions}
      placeholder={placeholder}
      theme={dark ? "dark" : "light"}
      basicSetup={{ lineNumbers: false, foldGutter: false, highlightActiveLine: false, highlightActiveLineGutter: false }}
    />
  );
}
