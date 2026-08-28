# Dummy values for `terraform validate` / offline `terraform plan` only.
# Never apply with these — no real Azure account exists in this build.
# See README.md.

resource_group_name     = "cloudable-control-plane-dummy"
location                = "westeurope"
name_prefix             = "cloudable"
postgres_admin_password = "Dummy-Password-Only-1234!"
better_auth_secret      = "dummy-secret-do-not-use-in-real-deploy"
