import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Search, Star } from "lucide-react";
import { t } from "../i18n";
import { filterCommands, type PaletteCommand } from "../commandPalette";

interface Props {
  commands: PaletteCommand[];
  onClose: () => void;
  onRun: (command: PaletteCommand) => void;
  label?: string;
  placeholder?: string;
  empty?: string;
  controls?: ReactNode;
  status?: ReactNode;
  onFavorite?: (command: PaletteCommand) => void;
  preview?: boolean;
}

function isInputMethodKey(event: KeyboardEvent) {
  // macOS WebKit can end composition before the confirming keydown, which still carries keyCode 229.
  return event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
}

export function CommandPalette({ commands, onClose, onRun, label = t("Command palette"), placeholder = t("Search commands"),
  empty = t("No matching commands"), controls, status, onFavorite, preview }: Props) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string>();
  const listId = useId();
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const matches = filterCommands(commands, query);
  const selected = Math.max(0, matches.findIndex((command) => command.id === selectedId));
  const current = matches[selected];

  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }); }, [current?.id, selected]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isInputMethodKey(event)) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault(); event.stopPropagation();
      if (matches.length) setSelectedId(matches[(selected + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length].id);
    } else if (event.key === "Enter") {
      event.preventDefault(); event.stopPropagation();
      if (!event.repeat && current) onRun(current);
    }
  };

  return <div className="palette-backdrop" onMouseDown={onClose}>
    <div className="command-palette" role="dialog" aria-modal="true" aria-label={label} onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (isInputMethodKey(event)) return;
        if (event.key === "Escape") {
          event.preventDefault(); event.stopPropagation(); onClose();
        }
        if (event.key === "Tab") {
          const focusable = event.currentTarget.querySelectorAll<HTMLElement>('input, button:not(:disabled):not([tabindex="-1"])');
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey ? event.target === first : event.target === last) {
            event.preventDefault();
            (event.shiftKey ? last : first)?.focus();
          }
        }
      }}>
      <div className="palette-search"><Search size={17} aria-hidden="true"/><input ref={input} autoFocus role="combobox" aria-expanded="true" aria-controls={listId}
        aria-autocomplete="list" aria-activedescendant={current ? `${listId}-${selected}` : undefined} aria-label={placeholder} placeholder={placeholder}
        value={query} onChange={(event) => { setQuery(event.target.value); setSelectedId(undefined); }} onKeyDown={onKeyDown} spellCheck={false}/><kbd>Esc</kbd></div>
      {controls && <div className="palette-controls" onClick={() => { setSelectedId(undefined); input.current?.focus(); }}>{controls}</div>}
      {status && <div className="palette-status" role="status">{status}</div>}
      <div className="palette-results" id={listId} role="listbox" aria-label={label} ref={list}>
        {matches.length ? matches.map((command, position) => <button key={command.id} type="button" className="palette-item" id={`${listId}-${position}`} role="option"
          aria-selected={position === selected} tabIndex={-1} onMouseDown={(event) => event.preventDefault()} onMouseMove={() => setSelectedId(command.id)} onClick={() => onRun(command)}>
          {command.favorite && <Star size={13} className="palette-star" fill="currentColor" aria-hidden="true" />}
          {command.path ? <span className="palette-object">
            <span className="palette-title" title={command.label}>{command.label}</span>
            <span className="palette-path">{command.path}</span>
          </span> : <span className="palette-title" title={command.detail ?? command.label}>{command.label}</span>}
          {command.badge && <span className={command.badge.className}>{command.badge.label}</span>}
          {command.category && <span className="palette-category" title={command.category}>{command.category}</span>}
          {!onFavorite && !preview && <span className="palette-shortcut" aria-hidden={!command.shortcut || undefined}>
            {command.shortcut && <kbd>{command.shortcut}</kbd>}
          </span>}
        </button>) : <div className="palette-empty">{empty}</div>}
      </div>
      {preview && current?.detail && <pre className="palette-preview">{current.detail}</pre>}
      <div className="palette-footer">
        {onFavorite ? <button className="palette-favorite" type="button" disabled={!current} aria-pressed={current?.favorite ?? false}
          onClick={() => { if (current) { setSelectedId(current.id); onFavorite(current); } input.current?.focus(); }}>
          <Star size={14} fill={current?.favorite ? "currentColor" : "none"} aria-hidden="true" />
          {t(current?.favorite ? "Remove favorite" : "Add favorite")}
        </button> : <span>{preview ? t("Load into editor") : t("Choose a command")}</span>}
        <span className="palette-navigation"><kbd>↑</kbd><kbd>↓</kbd><kbd>↵</kbd></span>
      </div>
    </div>
  </div>;
}
