import { type FormEvent, useId, useState } from "react";

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** Connect form for an identity provider — SCIM 2.0 + OIDC discovery, never a client secret. */
export function IdpConnectDialog() {
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState("");
  const [metadataUrl, setMetadataUrl] = useState("");
  const connect = useConnectIntegration();
  const providerId = useId();
  const metadataId = useId();

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    connect.mutate(
      { kind: "idp", identifier: provider, config: { provider, metadataUrl } },
      {
        onSuccess: () => {
          setOpen(false);
          setProvider("");
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
          <DialogTitle>Connect identity provider</DialogTitle>
          <DialogDescription>
            SCIM 2.0 + OIDC against any IdP. Optional — Cloudable never asks for a client secret
            here; federate it on the IdP's own side.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={handleSubmit}>
          <div className="flex flex-col gap-1">
            <Label htmlFor={providerId}>Provider name</Label>
            <Input
              id={providerId}
              required
              placeholder="Entra ID"
              value={provider}
              onChange={(event) => setProvider(event.target.value)}
            />
          </div>
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

/** Connect form for Azure workload identity federation — three non-secret identifiers only. */
export function CloudConnectDialog() {
  const [open, setOpen] = useState(false);
  const [tenantId, setTenantId] = useState("");
  const [applicationId, setApplicationId] = useState("");
  const [subscriptionId, setSubscriptionId] = useState("");
  const connect = useConnectIntegration();
  const tenantIdId = useId();
  const applicationIdId = useId();
  const subscriptionIdId = useId();

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    connect.mutate(
      {
        kind: "cloud",
        identifier:
          subscriptionId.length > 8
            ? `Azure — subscription ${subscriptionId.slice(0, 8)}…`
            : `Azure — subscription ${subscriptionId}`,
        config: { tenantId, applicationId, subscriptionId },
      },
      {
        onSuccess: () => {
          setOpen(false);
          setTenantId("");
          setApplicationId("");
          setSubscriptionId("");
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
          <DialogTitle>Connect Azure</DialogTitle>
          <DialogDescription>
            Workload identity federation. Three non-secret identifiers — Cloudable never receives a
            client secret. Run Cloudable's Terraform template on your side to create the app
            registration and federated credential, scoped to a single resource group.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={handleSubmit}>
          <div className="flex flex-col gap-1">
            <Label htmlFor={tenantIdId}>Tenant ID</Label>
            <Input
              id={tenantIdId}
              required
              className="font-mono"
              value={tenantId}
              onChange={(event) => setTenantId(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={applicationIdId}>Application (client) ID</Label>
            <Input
              id={applicationIdId}
              required
              className="font-mono"
              value={applicationId}
              onChange={(event) => setApplicationId(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={subscriptionIdId}>Subscription ID</Label>
            <Input
              id={subscriptionIdId}
              required
              className="font-mono"
              value={subscriptionId}
              onChange={(event) => setSubscriptionId(event.target.value)}
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

export const SECRET_STORE_PROVIDER_LABEL: Record<SecretStoreConfig["provider"], string> = {
  azure_key_vault: "Azure Key Vault",
  "1password": "1Password",
};

/** Connect form for a secret store — a pointer at the customer's own vault, never a secret value. */
export function SecretStoreConnectDialog() {
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState<SecretStoreConfig["provider"]>("azure_key_vault");
  const [vaultUrl, setVaultUrl] = useState("");
  const connect = useConnectIntegration();
  const providerId = useId();
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
          <DialogTitle>Connect secret store</DialogTitle>
          <DialogDescription>
            Cloudable is the injector, never the vault. Point at your own store by URL — this form
            never asks for a secret value, and Cloudable fetches at runtime without ever writing it
            to disk.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={handleSubmit}>
          <div className="flex flex-col gap-1">
            <Label htmlFor={providerId}>Store</Label>
            <Select
              value={provider}
              onValueChange={(value) => setProvider(value as SecretStoreConfig["provider"])}
            >
              <SelectTrigger id={providerId}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="azure_key_vault">Azure Key Vault</SelectItem>
                <SelectItem value="1password">1Password</SelectItem>
              </SelectContent>
            </Select>
          </div>
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
