import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Search } from "lucide-react";
import { t } from "../i18n";
import { filterCommands, type PaletteCommand } from "../commandPalette";

export function CommandPalette({ commands, onClose, onRun }: { commands: PaletteCommand[]; onClose: () => void; onRun: (command: PaletteCommand) => void }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const matches = filterCommands(commands, query);
  const selected = Math.min(index, Math.max(0, matches.length - 1));
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }); }, [selected, query]);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
    else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault(); event.stopPropagation();
      if (matches.length) setIndex((selected + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length);
    } else if (event.key === "Enter") {
      event.preventDefault(); event.stopPropagation();
      if (!event.repeat && matches[selected]) onRun(matches[selected]);
    }
  };
  return <div className="palette-backdrop" onMouseDown={onClose}>
    <div className="command-palette" role="dialog" aria-modal="true" aria-label={t("Command palette")} onMouseDown={(event) => event.stopPropagation()}>
      <div className="palette-search"><Search size={17} aria-hidden="true"/><input autoFocus role="combobox" aria-expanded="true" aria-controls="palette-results" aria-autocomplete="list" aria-activedescendant={matches.length ? `palette-option-${selected}` : undefined} aria-label={t("Search commands")} placeholder={t("Search commands")} value={query} onChange={(event) => { setQuery(event.target.value); setIndex(0); }} onKeyDown={onKeyDown} spellCheck={false}/><kbd>esc</kbd></div>
      <div className="palette-results" id="palette-results" role="listbox" ref={list}>
        {matches.length ? matches.map((command, position) => <button key={command.id} type="button" className="palette-item" id={`palette-option-${position}`} role="option" aria-selected={position === selected} onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setIndex(position)} onClick={() => onRun(command)}><span className="palette-title">{command.label}</span><span className="palette-category">{command.category}</span><kbd className="palette-shortcut" aria-hidden={!command.shortcut || undefined}>{command.shortcut || ""}</kbd></button>) : <div className="palette-empty">{t("No matching commands")}</div>}
      </div>
      <div className="palette-footer"><span>{t("Choose a command")}</span><span>↑↓ · ↵</span></div>
    </div>
  </div>;
}
