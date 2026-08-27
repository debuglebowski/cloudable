import { Badge, type BadgeProps } from "@/components/ui/badge";

export interface ControlStatusProps {
  status: "pass" | "fail" | "unknown";
  label: string;
  evidenceHref?: string;
}

const STATUS_VARIANT: Record<ControlStatusProps["status"], BadgeProps["variant"]> = {
  pass: "ok",
  fail: "drift",
  unknown: "stale",
};

export function ControlStatus({ status, label, evidenceHref }: ControlStatusProps) {
  const badge = <Badge variant={STATUS_VARIANT[status]}>{label}</Badge>;

  if (!evidenceHref) {
    return badge;
  }

  return (
    <a href={evidenceHref} className="inline-flex w-fit items-center hover:underline">
      {badge}
    </a>
  );
}
