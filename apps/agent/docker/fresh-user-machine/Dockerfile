# A fresh Ubuntu 24.04 machine as its owner first meets it, for the checks that run the
# agent's per-user commands through a real shell (`runAsUser` in `src/global-tools.ts`).
#
# What matters is what a real machine has and a fake command runner does not:
# - the machine user is in the `sudo` group and has never used sudo, so
#   `/etc/bash.bashrc` prints its sudo tip on stdout in every interactive shell
#   (no `~/.sudo_as_admin_successful`, no `~/.hushlogin`);
# - npm is Ubuntu's, whose global folder is `/usr/local`, which the user cannot write.
#
# Built by the checks themselves (`src/testing/fresh-user-machine.ts`), never by hand.
FROM ubuntu:24.04

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       ca-certificates sudo npm \
    && rm -rf /var/lib/apt/lists/*

ARG MACHINE_OS_USER=cloudable
RUN useradd --create-home --shell /bin/bash --groups sudo ${MACHINE_OS_USER}

CMD ["sleep", "infinity"]
