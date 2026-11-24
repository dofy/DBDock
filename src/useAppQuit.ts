import { invoke } from "@tauri-apps/api/core";
import { useRef } from "react";
import { errText } from "./api";
import { useFeedbackDialog } from "./components/FeedbackDialog";
import { useToast } from "./components/Toast";
import { t } from "./i18n";
import { quitDecision } from "./quitGuard";
import type { useConnectionSessions } from "./useConnectionSessions";

type QuitState = Pick<ReturnType<typeof useConnectionSessions>, "opened" | "connecting" | "dirtyTabs">;

export function useAppQuit({ opened, connecting, dirtyTabs }: QuitState) {
  const toast = useToast();
  const { ask, message } = useFeedbackDialog();
  const quitPending = useRef(false);

  return async (restart = false) => {
    if (quitPending.current) return;
    quitPending.current = true;
    try {
      const busy = [...dirtyTabs.current.values()].some((tabs) => [...tabs.values()].includes("busy"));
      const overlays = restart ? '.modal-backdrop:not([hidden], .settings-backdrop)' : '.modal-backdrop:not([hidden])';
      const decision = quitDecision(opened.length, connecting.length, !!document.querySelector(overlays), busy);
      if (decision === "blocked") {
        await message(t(restart ? "Wait for the commit to finish before restarting." : "Wait for the commit to finish before quitting."), { kind: "warning" });
        return;
      }
      if (decision === "confirm") {
        const confirmed = await ask(t(restart ? "Restart DBDock? Open connections will close and unsaved edits will be lost." : "Quit DBDock? Open connections will close and unsaved edits will be lost."), {
          title: t(restart ? "Restart DBDock" : "Quit DBDock"), kind: "warning", okLabel: t(restart ? "Restart" : "Quit"),
        });
        if (!confirmed) return;
      }
      await invoke("confirm_quit", { restart });
    } catch (e) {
      toast("error", errText(e));
    } finally {
      quitPending.current = false;
    }
  };
}
