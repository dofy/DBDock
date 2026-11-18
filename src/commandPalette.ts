export interface PaletteCommand {
  id: string;
  label: string;
  category: string;
  path?: string;
  shortcut?: string;
  keywords?: string;
  detail?: string;
  favorite?: boolean;
  badge?: { label: string; className: string };
  run: () => void;
}

/** Search command names, localized categories and English aliases; never query user data elsewhere. */
export function filterCommands(commands: readonly PaletteCommand[], query: string): PaletteCommand[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  if (!terms.length) return [...commands];
  return commands.filter((command) => {
    const text = [command.label, command.category, command.path, command.shortcut, command.keywords, command.badge?.label].filter(Boolean).join(" ").toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
}
