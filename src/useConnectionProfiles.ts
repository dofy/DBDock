import { useCallback, useEffect, useState } from "react";
import { api, errText, type ConnectionConfig } from "./api";
import { useToast } from "./components/Toast";
import { clearHealth } from "./healthHistory";
import { tf } from "./i18n";

export function useConnectionProfiles(pruneConnectionHistory: (connections: ConnectionConfig[]) => void) {
  const toast = useToast();
  const [conns, setConns] = useState<ConnectionConfig[]>([]);
  const [groups, setGroups] = useState<string[]>([]);
  const [editing, setEditing] = useState<ConnectionConfig | { newInGroup: string; fromUrl?: boolean } | null>(null);

  const reload = useCallback(async () => {
    try {
      const [connections, groups] = await Promise.all([api.listConnections(), api.listGroups()]);
      setConns(connections);
      setGroups(groups);
      pruneConnectionHistory(connections);
    } catch (e) {
      toast("error", errText(e));
    }
  }, [toast, pruneConnectionHistory]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const openNewConnection = () => setEditing({ newInGroup: "" });
  const openNewConnectionFromUrl = () => setEditing((current) => current ?? { newInGroup: "", fromUrl: true });
  const closeEditor = () => setEditing(null);
  const onSaved = (connection: ConnectionConfig) => {
    clearHealth([connection.id]);
    closeEditor();
    toast("ok", tf("Saved {name}", { name: connection.name }));
    void reload();
  };

  return { conns, groups, editing, setEditing, reload, openNewConnection, openNewConnectionFromUrl, closeEditor, onSaved };
}
