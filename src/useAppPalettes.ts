import { useCallback, useEffect, useRef, useState } from "react";
import type { ConnectionConfig } from "./api";
import type { PaletteCommand } from "./commandPalette";
import { pruneNavigation, readNavigation, saveNavigation, toggleFavorite, visitTarget,
  type NavigationCatalog, type NavigationTarget } from "./navigation";
import type { useConnectionSessions } from "./useConnectionSessions";

export function useAppPalettes(conns: ConnectionConfig[], connect: ReturnType<typeof useConnectionSessions>["connect"]) {
  const [showCommand, setShowCommand] = useState(false);
  const [showQuick, setShowQuick] = useState(false);
  const [navigation, setNavigation] = useState(() => readNavigation(localStorage));
  const [catalog, setCatalog] = useState<NavigationCatalog>();
  const recordVisit = useCallback((target: NavigationTarget) => setNavigation((current) => visitTarget(current, target)), []);
  useEffect(() => { saveNavigation(localStorage, navigation); }, [navigation]);
  const previousFocus = useRef<HTMLElement | null>(null);
  const pendingCommand = useRef<PaletteCommand | null>(null);
  const openPalette = (setOpen: (visible: boolean) => void) => {
    if (document.querySelector('.modal-backdrop:not([hidden]), .palette-backdrop')) return;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpen(true);
  };
  const openCommands = () => openPalette(setShowCommand);
  const openQuick = () => openPalette(setShowQuick);
  const closeCommands = () => setShowCommand(false);
  const closeQuick = () => setShowQuick(false);
  useEffect(() => {
    if (showCommand || showQuick) return;
    const command = pendingCommand.current; pendingCommand.current = null;
    const focus = previousFocus.current;
    previousFocus.current = null;
    if (command) { command.run(); return; }
    focus?.focus();
  }, [showCommand, showQuick]);

  const navigate = (target: NavigationTarget) => {
    closeQuick();
    const connection = conns.find((item) => item.id === target.connectionId);
    if (connection) void connect(connection, target);
  };

  const pruneConnectionHistory = useCallback((connections: ConnectionConfig[]) => {
    const ids = new Set(connections.map(({ id }) => id));
    setNavigation((current) => pruneNavigation(current, ids));
  }, []);
  const toggleFavoriteTarget = (target: NavigationTarget) => setNavigation((current) => toggleFavorite(current, target));
  const runCommand = (command: PaletteCommand) => {
    pendingCommand.current = command;
    closeCommands();
  };

  return {
    showCommand, showQuick, openCommands, openQuick, closeCommands, closeQuick, runCommand,
    catalog, setCatalog, navigation, recordVisit, pruneConnectionHistory, toggleFavoriteTarget, navigate,
  };
}
