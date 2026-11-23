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

  return async () => {
    if (quitPending.current) return;
    quitPending.current = true;
    try {
      const busy = [...dirtyTabs.current.values()].some((tabs) => [...tabs.values()].includes("busy"));
      const decision = quitDecision(opened.length, connecting.length, !!document.querySelector('.modal-backdrop:not([hidden])'), busy);
      if (decision === "blocked") {
        await message(t("Wait for the commit to finish before quitting."), { kind: "warning" });
        return;
      }
      if (decision === "confirm") {
        const confirmed = await ask(t("Quit DBDock? Open connections will close and unsaved edits will be lost."), {
          title: t("Quit DBDock"), kind: "warning", okLabel: t("Quit"),
        });
        if (!confirmed) return;
      }
      await invoke("confirm_quit");
    } catch (e) {
      toast("error", errText(e));
    } finally {
      quitPending.current = false;
    }
  };
}
