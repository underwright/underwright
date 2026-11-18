#!/usr/bin/env bash
# Install the always-on omnigent host for fleet-ops sessions (gh-163).
# Run on the ops host (minipc) as the ops user. Safe to re-run.
#
#   OMNIGENT_SERVER=http://100.119.119.34:8000 ops/install-ops-host.sh
#
# What it does:
#   1. Makes sure user lingering is on, so the unit runs without a login session.
#   2. Picks the host unit. If ~/.config/systemd/user/omnigent.service exists
#      (the combined `omnigent.host._daemon_entry --local` daemon, which is what
#      minipc runs), that unit already is the host. It is adopted, and
#      `omnigent host enable` is NOT run, because that would start a second
#      daemon registering under the same host name. Otherwise
#      `omnigent host enable` writes and starts omnigent-host.service. It
#      waits for running turns on an existing host, so a session that runs this
#      script detached with systemd-run is not killed mid-turn.
#   3. Installs the 10-always-on.conf drop-in (Restart=always) on that unit.
set -euo pipefail

SERVER="${OMNIGENT_SERVER:-http://100.119.119.34:8000}"
OMNIGENT="$(command -v omnigent || echo "$HOME/.local/bin/omnigent")"
UNIT_DIR="$HOME/.config/systemd/user"

echo "[install-ops-host] server=$SERVER omnigent=$OMNIGENT"

if [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]]; then
  echo "[install-ops-host] enabling linger for $USER"
  loginctl enable-linger "$USER"
fi

if [[ -f "$UNIT_DIR/omnigent.service" ]]; then
  UNIT=omnigent.service
  echo "[install-ops-host] adopting existing $UNIT (combined server+host daemon); skipping 'omnigent host enable'"
else
  UNIT=omnigent-host.service
  "$OMNIGENT" host enable --server "$SERVER" --non-interactive
fi
DROPIN_DIR="$UNIT_DIR/$UNIT.d"

mkdir -p "$DROPIN_DIR"
cat > "$DROPIN_DIR/10-always-on.conf" <<'CONF'
# Managed by underwright ops/install-ops-host.sh (gh-163). Source:
# ops/systemd/10-always-on.conf
[Unit]
StartLimitIntervalSec=0

[Service]
Restart=always
RestartSec=10s
RestartPreventExitStatus=
RestartPreventExitStatus=78
CONF

systemctl --user daemon-reload
systemctl --user enable "$UNIT"
# No restart here: drop-in restart policy applies to the running unit after daemon-reload.
systemctl --user is-active "$UNIT"
systemctl --user show "$UNIT" -p Restart -p UnitFileState -p ActiveState
echo "[install-ops-host] done"
