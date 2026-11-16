export type Locale = "en" | "zh-CN" | "zh-TW" | "ja";

export function resolveLocale(preference: string, system: readonly string[] = navigator.languages): Locale {
  if (preference !== "system") return (["en", "zh-CN", "zh-TW", "ja"] as string[]).includes(preference) ? preference as Locale : "en";
  for (const lang of system) {
    const tag = lang.toLowerCase();
    if (tag.startsWith("zh")) return /hant|\b(tw|hk|mo)\b/.test(tag) ? "zh-TW" : "zh-CN";
    if (tag.startsWith("ja")) return "ja";
    if (tag.startsWith("en")) return "en";
  }
  return "en";
}
