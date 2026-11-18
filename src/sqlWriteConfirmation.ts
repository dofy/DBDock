import { ask } from "@tauri-apps/plugin-dialog";
import { ENV_LABEL } from "./api";
import { t, tf } from "./i18n";

export function confirmSqlWrite({
  connectionName, env, object, title, action, summary, sql,
}: {
  connectionName: string;
  env: string;
  object?: string;
  title: string;
  action: string;
  summary?: string;
  sql?: string;
}) {
  const label = ENV_LABEL[env];
  const connection = label ? `[${t(label)}] ${connectionName}` : connectionName;
  const target = tf("Target: {name}", { name: object ? `${connection} / ${object}` : connection });
  const sqlPreview = sql && (sql.length > 1200 ? `${sql.slice(0, 1200)}\n…` : sql);
  return ask([target, summary, sqlPreview].filter(Boolean).join("\n\n"), {
    title: env === "production" ? tf("Production · {action}", { action: title }) : title,
    kind: "warning",
    okLabel: action,
    cancelLabel: t("Cancel"),
  });
}
