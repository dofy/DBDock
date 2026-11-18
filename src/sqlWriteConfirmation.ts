import type { FeedbackAsk } from "./components/FeedbackDialog";
import { ENV_LABEL } from "./api";
import { t, tf } from "./i18n";

export function confirmSqlWrite(ask: FeedbackAsk, {
  connectionName, env, object, title, action, summary, sql, destructive,
}: {
  connectionName: string;
  env: string;
  object?: string;
  title: string;
  action: string;
  summary?: string;
  sql?: string;
  destructive?: boolean;
}) {
  const label = ENV_LABEL[env];
  const connection = label ? `[${t(label)}] ${connectionName}` : connectionName;
  const target = tf("Target: {name}", { name: object ? `${connection} / ${object}` : connection });
  const sqlPreview = sql && (sql.length > 1200 ? `${sql.slice(0, 1200)}\n…` : sql);
  return ask(summary ?? "", {
    title: env === "production" ? tf("Production · {action}", { action: title }) : title,
    kind: env === "production" || destructive ? "danger" : "warning",
    target,
    preview: sqlPreview,
    okLabel: action,
  });
}
