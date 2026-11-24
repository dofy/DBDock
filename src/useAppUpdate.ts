import { invoke, isTauri } from "@tauri-apps/api/core";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "./components/Toast";
import { t, tf } from "./i18n";
import { getSettings } from "./settings";

const STARTUP_DELAY = 10_000;
const CHECK_INTERVAL = 24 * 60 * 60 * 1000;

export function useAppUpdate(automatic: boolean, restart: () => Promise<void>) {
  const toast = useToast();
  const [supported, setSupported] = useState(false);
  const [available, setAvailable] = useState<Update | null>(null);
  const [installed, setInstalled] = useState(false);
  const [status, setStatus] = useState<"checking" | "installing" | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    void invoke<boolean>("supports_app_updates").then((value) => {
      if (active) setSupported(value);
    }).catch(() => {});
    return () => { active = false; };
  }, []);

  const checkForUpdates = useCallback(async (manual: boolean) => {
    if (busy.current) return;
    if (!manual && !getSettings().automaticallyCheckForUpdates) return;
    busy.current = true;
    setStatus("checking");
    try {
      const update = await check({ timeout: 20_000 });
      if (!update) {
        if (manual) toast("info", t("DBDock is up to date."));
        return;
      }
      if (!manual && !getSettings().automaticallyCheckForUpdates) {
        await update.close();
        return;
      }
      setAvailable(update);
      toast("info", tf("DBDock {version} is available.", { version: update.version }));
    } catch {
      if (manual) toast("error", t("Could not check for updates. Try again later."));
    } finally {
      busy.current = false;
      setStatus(null);
    }
  }, [toast]);

  useEffect(() => {
    if (!supported || !automatic || available || installed) return;
    const run = () => { void checkForUpdates(false); };
    const startup = window.setTimeout(run, STARTUP_DELAY);
    const daily = window.setInterval(run, CHECK_INTERVAL);
    return () => {
      window.clearTimeout(startup);
      window.clearInterval(daily);
    };
  }, [supported, automatic, available, installed, checkForUpdates]);

  const run = async () => {
    if (!supported || busy.current) return;
    if (installed) {
      await restart();
      return;
    }
    if (!available) {
      await checkForUpdates(true);
      return;
    }

    busy.current = true;
    setStatus("installing");
    try {
      await available.downloadAndInstall(undefined, { timeout: 120_000 });
      setInstalled(true);
      setAvailable(null);
      toast("ok", t("Update installed. Restart DBDock to finish."));
      await available.close().catch(() => {});
    } catch {
      toast("error", t("Could not install the update. Try again later."));
    } finally {
      busy.current = false;
      setStatus(null);
    }
  };

  const label = status === "checking" ? t("Checking for updates…")
    : status === "installing" ? t("Installing update…")
    : installed ? t("Restart to finish update")
    : available ? tf("Install {version}", { version: available.version })
    : t("Check for Updates");

  return { supported, pending: !!available || installed, busy: status !== null, label, run };
}
