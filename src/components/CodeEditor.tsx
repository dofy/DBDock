import { useMemo, useRef } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { Vim, getCM, vim } from "@replit/codemirror-vim";
import { closeCompletion, completionStatus } from "@codemirror/autocomplete";
import { Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { json } from "@codemirror/lang-json";
import { useDarkMode, useSettings } from "../settings";

// Ex commands are global in the Vim plugin: `:w` saves whichever editor last had focus.
let writeHandler: (() => void) | undefined;
Vim.defineEx("write", "w", () => writeHandler?.());

/**
 * Vim bindings for any CodeMirror instance. `onWrite` runs for `:w` while this
 * editor is (or was last) focused. Put it first in the extension list.
 */
export function vimExtension(onWrite?: () => void): Extension {
  return [
    // One Esc closes an open completion *and* leaves insert mode, like plain Vim.
    Prec.highest(
      EditorView.domEventHandlers({
        keydown: (e, view) => {
          if (e.key === "Escape" && completionStatus(view.state) === "active") {
            closeCompletion(view);
            const cm = getCM(view);
            if (cm) Vim.exitInsertMode(cm as never);
            e.preventDefault();
            return true;
          }
          return false;
        },
      }),
    ),
    vim(),
    EditorView.domEventHandlers({
      focus: () => {
        writeHandler = onWrite;
      },
    }),
  ];
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  language?: "json" | "plain";
  /** ⌘S, and `:w` in Vim mode. */
  onSave?: () => void;
  /** Defaults to the system appearance. */
  dark?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
}

/** Multi-line editor for raw files and documents; honours the Vim setting. */
export function CodeEditor({ value, onChange, language = "plain", onSave, dark, autoFocus, placeholder }: Props) {
  const { vim: vimOn } = useSettings();
  const selectedDark = useDarkMode();
  const isDark = dark ?? selectedDark;
  const save = useRef(onSave);
  save.current = onSave;
  const extensions = useMemo(() => {
    const ext: Extension[] = [];
    if (vimOn) ext.push(vimExtension(() => save.current?.()));
    if (language === "json") ext.push(json());
    ext.push(
      Prec.high(
        keymap.of([
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              save.current?.();
              return true;
            },
          },
        ]),
      ),
    );
    return ext;
  }, [vimOn, language]);
  return (
    <div className={`code-editor ${vimOn ? "vim-on" : ""}`}>
      <CodeMirror value={value} onChange={onChange} extensions={extensions} theme={isDark ? "dark" : "light"} height="100%" autoFocus={autoFocus} placeholder={placeholder} />
      {vimOn && <span className="vim-badge">VIM</span>}
    </div>
  );
}
