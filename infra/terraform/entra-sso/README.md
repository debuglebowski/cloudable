# Cloudable — Entra SSO application (Terraform)

Creates the Microsoft Entra enterprise application the console federates against, so
people sign in to Cloudable with their existing work account.

**You do not need this module.** Cloudable works without SSO — `control-plane` leaves
`idp_metadata_url` null by default and the console manages identity providers itself.
And if you already have an Entra application, skip this and pass its federation
metadata URL straight to `control-plane`. This exists so the common case is describable
in code instead of a sequence of portal clicks.

## Why it is separate from `control-plane`

Azure has two planes. Your subscription holds infrastructure; your directory holds
people and applications. Subscription roles like Owner and Contributor grant nothing in
the directory, so creating an app registration needs a Microsoft Graph permission
(`Application.ReadWrite.OwnedBy`) or an Entra role (Application Administrator) — both
tenant-wide over app registrations.

An unattended CI identity holding that is a bigger blast radius than one application is
worth, especially for an application that is created once and then changes about never.
So the expected shape is:

- `control-plane` is applied by CI, with subscription RBAC only.
- This module is applied by a person, rarely, with their own admin rights.
- It has **its own state**, so the pipeline that deploys the control plane holds no
  credentials for the directory's state.

The record of what changed here is Entra's own audit log rather than a CI run, so export
it somewhere durable if you are answering to an auditor. That export is not part of this
module: only you know which workspace keeps your evidence, and wiring it here would drag
the `azurerm` provider into a module that is otherwise purely a directory concern.

## Usage

```hcl
module "entra_sso" {
  source = "git::https://github.com/debuglebowski/cloudable.git//infra/terraform/entra-sso?ref=<commit>"

  console_origin = "https://cloudable.example.com"
}

# ...then, in the configuration your CI applies:
module "control_plane" {
  source = "git::https://github.com/debuglebowski/cloudable.git//infra/terraform/control-plane?ref=<commit>"

  # Copied as a literal, not read through the other state — that is the point.
  idp_metadata_url  = "https://login.microsoftonline.com/<tenant>/federationmetadata/..."
  idp_email_domains = ["example.com"]
  # ...
}
```

`console_origin` must be the origin people actually browse to. The SAML entityID and
Reply URL are derived from it, and the control plane rejects any assertion whose
Audience does not match.

`idp_email_domains` is load-bearing: `@better-auth/sso` only trusts a provider for users
whose email domain matches, and only a trusted provider can attach a SAML identity to an
account that already exists. Get it wrong and every sign-in fails with
`account_not_linked`.

## Applying it

```
tofu init && tofu apply
```

as someone who can create app registrations in your tenant. Then take
`federation_metadata_url` from the output.

Ownership matters: the module sets whoever applies it as the application's owner. An
application with no owner can be read back only by a tenant-wide admin, so the next plan
fails for the very identity that created it.
