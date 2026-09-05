import { type FormEvent, useId, useState } from "react";

import type { CloudProvider } from "@/api/integrations";
import { useConnectIntegration } from "@/api/integrations";
import type { SecretStoreConfig } from "@/api/integrations";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Connect form for Microsoft Entra ID — SCIM 2.0 + OIDC discovery, never a client secret.
 * Fieldless on provider (there's only one) — just the tenant's own federation metadata URL. */
export function IdpConnectDialog() {
  const [open, setOpen] = useState(false);
  const [metadataUrl, setMetadataUrl] = useState("");
  const connect = useConnectIntegration();
  const metadataId = useId();

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    connect.mutate(
      {
        kind: "idp",
        identifier: "Microsoft Entra ID",
        config: { provider: "entra_id", metadataUrl },
      },
      {
        onSuccess: () => {
          setOpen(false);
          setMetadataUrl("");
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">Connect</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect Microsoft Entra ID</DialogTitle>
          <DialogDescription>
            SCIM 2.0 + OIDC against your Entra tenant. Optional — Cloudable never asks for a client
            secret here; federate it on Entra's own side.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={handleSubmit}>
          <div className="flex flex-col gap-1">
            <Label htmlFor={metadataId}>Federation metadata / discovery URL</Label>
            <Input
              id={metadataId}
              required
              type="url"
              placeholder="https://login.microsoftonline.com/…/federationmetadata.xml"
              value={metadataUrl}
              onChange={(event) => setMetadataUrl(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={connect.isPending}>
              {connect.isPending ? "Connecting…" : "Connect"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const CLOUD_PROVIDER_LABEL: Record<CloudProvider, string> = {
  azure: "Azure",
  docker: "Docker",
  fake: "Fake",
};

/**
 * Enables one cloud provider for the org — fieldless. Azure's credential is
 * this deployment's own ambient managed identity (one subscription for the
 * whole deployment, see `GET /api/v1/provisioning/capabilities`), not a
 * per-org federation the console collects — there is nothing to fill in for
 * any of the three providers, only a policy decision to turn one on.
 * (Workload-identity BYOC federation, if it becomes a real feature, is the
 * one that would need a real connect form here — this isn't it.)
 */
export function CloudEnableButton({
  provider,
  disabled,
}: {
  provider: CloudProvider;
  disabled?: boolean;
}) {
  const connect = useConnectIntegration();

  return (
    <Button
      size="sm"
      disabled={disabled || connect.isPending}
      onClick={() =>
        connect.mutate({
          kind: "cloud",
          provider,
          identifier: CLOUD_PROVIDER_LABEL[provider],
          config: { provider },
        })
      }
    >
      {connect.isPending ? "Enabling…" : "Enable"}
    </Button>
  );
}

export const SECRET_STORE_PROVIDER_LABEL: Record<SecretStoreConfig["provider"], string> = {
  azure_key_vault: "Azure Key Vault",
  "1password": "1Password",
};

/** Connect form for one secret store backend — a pointer at the customer's own vault,
 * never a secret value. `provider` is fixed by which card renders this (Azure Key Vault
 * vs 1Password are separate cards, not a dropdown) — `idp`/`secret_store` integrations
 * are single-slot per org, so connecting here replaces whichever one is already
 * connected; `replacesLabel` names it so the dialog can say so before submit. */
export function SecretStoreConnectDialog({
  provider,
  replacesLabel,
}: {
  provider: SecretStoreConfig["provider"];
  replacesLabel?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [vaultUrl, setVaultUrl] = useState("");
  const connect = useConnectIntegration();
  const vaultUrlId = useId();

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    connect.mutate(
      {
        kind: "secret_store",
        identifier: `${SECRET_STORE_PROVIDER_LABEL[provider]} — ${vaultUrl}`,
        config: { provider, vaultUrl },
      },
      {
        onSuccess: () => {
          setOpen(false);
          setVaultUrl("");
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">Connect</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect {SECRET_STORE_PROVIDER_LABEL[provider]}</DialogTitle>
          <DialogDescription>
            Cloudable is the injector, never the vault. Point at your own store by URL — this form
            never asks for a secret value, and Cloudable fetches at runtime without ever writing it
            to disk.
            {replacesLabel && (
              <>
                {" "}
                Replaces the currently connected {replacesLabel} — Cloudable only keeps one secret
                store connected at a time.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={handleSubmit}>
          <div className="flex flex-col gap-1">
            <Label htmlFor={vaultUrlId}>Vault URL</Label>
            <Input
              id={vaultUrlId}
              required
              type="url"
              placeholder="https://my-vault.vault.azure.net/"
              value={vaultUrl}
              onChange={(event) => setVaultUrl(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={connect.isPending}>
              {connect.isPending ? "Connecting…" : "Connect"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
