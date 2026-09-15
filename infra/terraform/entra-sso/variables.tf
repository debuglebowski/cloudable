variable "console_origin" {
  description = "Scheme and host the console is served on, without a trailing slash, e.g. \"https://cloudable.example.com\". The SAML entityID and Reply URL are derived from it, and the control plane rejects an assertion whose Audience does not match, so this must be the origin people actually browse to."
  type        = string

  validation {
    condition     = can(regex("^https://[^/]+$", var.console_origin))
    error_message = "console_origin must be an https origin with no path or trailing slash, e.g. https://cloudable.example.com."
  }
}

variable "sso_provider_id" {
  description = "Must match CONFIGURED_IDP_PROVIDER_ID in the control plane's config.ts, which is what `control-plane`'s own `sso_provider_id` output reports. Fixed rather than generated: that is what lets the Reply URL be correct on a first apply instead of needing a second pass once someone has clicked Connect."
  type        = string
  default     = "configured"
}

variable "display_name" {
  description = "Name of the application as it appears in Entra, to the people signing in and to whoever audits the directory later."
  type        = string
  default     = "Cloudable"
}

variable "signing_certificate_subject" {
  description = "Subject of the SAML token-signing certificate Entra creates for this application."
  type        = string
  default     = "CN=Cloudable SAML Signing"
}

variable "owners" {
  description = "Object ids that own the application and its service principal. Defaults to whoever applies this module, which is almost always what you want: an application with no owner can be read back only by a tenant-wide admin, so the next plan fails for the identity that created it. Pass a group's object id to hand ownership to a team instead."
  type        = list(string)
  default     = null
}
