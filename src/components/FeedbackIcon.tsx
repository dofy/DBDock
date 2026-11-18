import { CircleCheck, CircleHelp, CircleX, Info, OctagonAlert, TriangleAlert } from "lucide-react";

const icons = {
  question: CircleHelp,
  info: Info,
  warning: TriangleAlert,
  danger: OctagonAlert,
  error: CircleX,
  ok: CircleCheck,
};

export type FeedbackKind = keyof typeof icons;

export function FeedbackIcon({ kind, size }: { kind: FeedbackKind; size: number }) {
  const Icon = icons[kind];
  return <span className="feedback-icon" aria-hidden="true"><Icon size={size} /></span>;
}
