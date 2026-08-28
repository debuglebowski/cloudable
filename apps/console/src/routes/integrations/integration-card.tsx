import type { ReactNode } from "react";

import type { Integration, IntegrationKind } from "@/api/integrations";
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
  description: string;
  integration: Extract<Integration, { kind: K }> | undefined;
  connectForm: ReactNode;
  onDisconnect: (integration: Extract<Integration, { kind: K }>) => void;
  children: (integration: Extract<Integration, { kind: K }>) => ReactNode;
}

/** One connection card: connected state + disconnect, or the kind-specific connect form. */
export function IntegrationCard<K extends IntegrationKind>({
  title,
  description,
  integration,
  connectForm,
  onDisconnect,
  children,
}: IntegrationCardProps<K>) {
  return (
    <Card className="flex flex-col">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>{title}</CardTitle>
          <Badge variant={integration ? "ok" : "secondary"}>
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
      <CardFooter>
        {integration ? (
          <Button variant="outline" size="sm" onClick={() => onDisconnect(integration)}>
            Disconnect
          </Button>
        ) : (
          connectForm
        )}
      </CardFooter>
    </Card>
  );
}
