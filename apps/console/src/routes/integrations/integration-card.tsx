import type { ReactNode } from "react";

import type { Integration, IntegrationKind } from "@/api/integrations";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export interface IntegrationCardProps<K extends IntegrationKind> {
  title: string;
  /** Small leading icon naming this card's kind — same "icon square before a
   * title" convention as reports.png's own dashboard-card grid (each card
   * there leads with a colored icon square too), just at the card's smaller
   * scale. A plain SVG component so both lucide icons and brand marks (e.g.
   * `@icons-pack/react-simple-icons`) fit — both render a real `<svg>` and
   * accept `className`. Plain call-signature type (not `ComponentType`) so it
   * doesn't get compared against a `forwardRef` component's `defaultProps` —
   * that comparison fails under `exactOptionalPropertyTypes` for both icon
   * sets. */
  icon: (props: { className?: string }) => ReactNode;
  description: string;
  integration: Extract<Integration, { kind: K }> | undefined;
  connectForm: ReactNode;
  onDisconnect: (integration: Extract<Integration, { kind: K }>) => void;
  children: (integration: Extract<Integration, { kind: K }>) => ReactNode;
  /** Extra footer action shown alongside Disconnect once connected — e.g. Azure's
   * "Configure" catalog dialog. Omitted for every card that doesn't need one. */
  secondaryAction?: ReactNode;
}

/** One connection card: connected state + disconnect, or the kind-specific connect form. */
export function IntegrationCard<K extends IntegrationKind>({
  title,
  icon: Icon,
  description,
  integration,
  connectForm,
  onDisconnect,
  children,
  secondaryAction,
}: IntegrationCardProps<K>) {
  return (
    <Card className="flex flex-col">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          {/* min-w-0 + truncate on the title: at this card's width (three per
              row), "Identity provider" + the "Not connected" badge don't both
              fit on one line, and a bare flex child wraps its text rather than
              shrinking — "Identity" / "provider" split across two lines,
              floating next to a one-line icon+badge row. An ellipsis is a much
              quieter failure mode than a mid-title line break. */}
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
              <Icon className="size-3.5" />
            </span>
            <CardTitle className="truncate">{title}</CardTitle>
          </div>
          <Badge variant={integration ? "ok" : "secondary"} dot={!integration} className="shrink-0">
            {integration ? "Connected" : "Not connected"}
          </Badge>
        </div>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-2 text-sm">
        {integration ? (
          <>
            {children(integration)}
            <span className="text-xs text-muted-foreground">
              Connected {new Date(integration.connectedAt).toLocaleString()}
            </span>
          </>
        ) : (
          <p className="text-muted-foreground">Not connected.</p>
        )}
      </CardContent>
      <CardFooter className="gap-2">
        {integration ? (
          <>
            {secondaryAction}
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" size="sm">
                  Disconnect
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Disconnect {title.toLowerCase()}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Cloudable stops using it immediately — nothing is deleted on the other side.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={() => onDisconnect(integration)}>
                    Disconnect
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        ) : (
          connectForm
        )}
      </CardFooter>
    </Card>
  );
}
