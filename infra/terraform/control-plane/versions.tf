terraform {
  required_version = ">= 1.5.0"

  required_providers {
    azurerm = {
      source = "hashicorp/azurerm"
      # Deliberately wide (3.100 through, but not including, 5.0): this
      # module's own resources need nothing past v3, but a root config that
      # calls this module alongside v4-only resources of its own (e.g. a
      # custom-domain managed certificate — see README.md's recipe) needs a
      # provider version compatible with both, and Terraform resolves one
      # provider version per configuration, not one per module. Verified
      # against a real plan on azurerm v4.81.0: this module's existing v3
      # resources plan identically, no changes needed.
      version = ">= 3.100, < 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "azurerm" {
  features {}
}
