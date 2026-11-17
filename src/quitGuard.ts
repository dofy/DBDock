export type QuitDecision = "blocked" | "confirm" | "exit";

export function quitDecision(openSessions: number, connecting: number, editing: boolean, busy: boolean): QuitDecision {
  if (busy) return "blocked";
  return openSessions > 0 || connecting > 0 || editing ? "confirm" : "exit";
}
