#!/bin/bash
# One-off: move /home onto the machine's persistent data disk.
#
# ONLY for machines provisioned before /home lived there (cloudInitFor's
# homeVolumeSection, commit 19b14ad). New machines are already correct, and this
# script refuses to run on one.
#
# WHY IT MATTERS: reimage deletes the OS disk and re-attaches the data disk. A machine
# still holding /home on the OS disk loses everything in it at the next upgrade. This
# already happened once in production, to cosmic-otter on 2026-09-14.
#
# HOW TO RUN IT — not directly. It stops cloudable-tunnel-daemon, which is the session
# you would be running it from, so it has to live outside that session's process tree:
#
#   cloudable connect <machine>
#   cat > /var/tmp/migrate-home.sh <<'"'"'MIGRATE'"'"'
#   ...paste this file...
#   MIGRATE
# TimeoutStartSec=infinity, not 0: systemd reads 0 as zero seconds and kills the unit
# the instant it starts. Observed doing exactly that on 2026-09-15.
#
#   sudo systemd-run --unit=cloudable-home-migrate --collect \
#     --property=Type=oneshot --property=TimeoutStartSec=infinity \
#     --property=StandardOutput=append:/var/log/cloudable-home-migrate.log \
#     --property=StandardError=append:/var/log/cloudable-home-migrate.log \
#     /bin/bash /var/tmp/migrate-home.sh
#
# Your session dies partway through and the machine reboots. Reconnect and read
# /var/log/cloudable-home-migrate.log.
#
# It is safe to stop at any point: nothing is deleted. The OS-disk home is RENAMED to
# /home.pre-cloudable and left there, and the script refuses to reboot unless the copy
# verifies byte for byte. Remove /home.pre-cloudable by hand once you are satisfied.
#
# See docs/lifecycle.md, "Where a machine's files live".

set -euo pipefail
OS_USER=cloudable
OLD_MOUNT=/mnt/cloudable-data
OSDISK_HOME=/home.pre-cloudable
echo "=== cloudable /home migration $(date -Is) ==="

# Preflight. Every assertion is an explicit if/exit: `! cmd` would NOT trip set -e —
# bash exempts !-inverted commands — so a preflight written that way asserts nothing.
if mountpoint -q /home; then echo "/home is already a mount point" >&2; exit 1; fi
if ! mountpoint -q "$OLD_MOUNT"; then echo "$OLD_MOUNT not mounted" >&2; exit 1; fi
if ! getent passwd "$OS_USER" >/dev/null; then echo "no $OS_USER account" >&2; exit 1; fi
DEVICE=$(findmnt -n -o SOURCE --target "$OLD_MOUNT")
STRAY=$(find "$OLD_MOUNT" -mindepth 1 -maxdepth 1 -not -name lost+found | wc -l)
if [ "$STRAY" != 0 ]; then echo "$OLD_MOUNT is not empty - refusing" >&2; exit 1; fi
NEED=$(du -sk /home | cut -f1)
FREE=$(df -Pk "$OLD_MOUNT" | awk 'NR==2 {print $4}')
if [ "$FREE" -lt $((NEED * 12 / 10)) ]; then echo "need ${NEED}k have ${FREE}k" >&2; exit 1; fi

# rsync is not guaranteed on a minimal image and there is no way to check from
# outside the machine, so both passes fall back to cp. The difference matters only in
# pass 2: cp cannot delete, so a file removed during the live window reappears. A
# harmless superset, and the alternative is a migration that aborts halfway.
copy_home() {
  if command -v rsync >/dev/null; then
    rsync -aHAX --numeric-ids --exclude=/lost+found "$@" /home/ "$OLD_MOUNT"/
  else
    cp -a /home/. "$OLD_MOUNT"/
  fi
}

# Pass 1: the long copy, while the person keeps working.
copy_home

# Quiesce. Only the tunnel daemon: the agent runs as root from /opt, never touches
# /home, and leaving it up keeps the machine visible to the control plane throughout.
systemctl stop cloudable-tunnel-daemon
pkill -u "$OS_USER" || true
sleep 5
pkill -KILL -u "$OS_USER" || true

# Pass 2: catch writes from the live window.
copy_home --delete
sync

# Swap to exactly the end state the new cloud-init produces.
umount "$OLD_MOUNT"
rmdir "$OLD_MOUNT"
grep -v "^[^#].*[[:space:]]$OLD_MOUNT[[:space:]]" /etc/fstab > /etc/fstab.new || true
if [ -s /etc/fstab.new ]; then mv /etc/fstab.new /etc/fstab; fi
mv /home "$OSDISK_HOME"
mkdir -m 755 /home
DISK_UUID=$(blkid -s UUID -o value "$DEVICE")
echo "UUID=$DISK_UUID /home ext4 defaults,nofail,x-systemd.device-timeout=30s 0 2" >> /etc/fstab
mount /home
echo "seeded_at=$(date -Is)" > /home/.cloudable-home-volume
chmod 600 /home/.cloudable-home-volume

# Verify BEFORE rebooting, while the OS-disk copy is still intact and recoverable.
if [ "$(findmnt -n -o SOURCE --target /home)" != "$DEVICE" ]; then echo "/home not on $DEVICE" >&2; exit 1; fi
if [ "$(stat -c %u "/home/$OS_USER")" != "$(id -u "$OS_USER")" ]; then echo "wrong uid" >&2; exit 1; fi
if ! diff -r -q --no-dereference "$OSDISK_HOME/$OS_USER" "/home/$OS_USER"; then
  echo "content differs - NOT rebooting, /home still recoverable from $OSDISK_HOME" >&2
  exit 1
fi
echo "verified: /home on $DEVICE, content identical"
systemctl reboot
