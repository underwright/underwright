#!/usr/bin/env bash
# Install the always-on omnigent host for fleet-ops sessions (gh-163).
# Run on the ops host (minipc) as the ops user. Safe to re-run.
#
#   OMNIGENT_SERVER=http://100.119.119.34:8000 ops/install-ops-host.sh
#
# What it does:
#   1. `omnigent host enable` writes and starts ~/.config/systemd/user/omnigent-host.service.
#      It waits for running turns on an existing host, so a session that
#      runs this script detached with systemd-run is not killed mid-turn.
#   2. Installs the 10-always-on.conf drop-in (Restart=always).
#   3. Makes sure user lingering is on, so the unit runs without a login session.
set -euo pipefail

SERVER="${OMNIGENT_SERVER:-http://100.119.119.34:8000}"
OMNIGENT="$(command -v omnigent || echo "$HOME/.local/bin/omnigent")"
DROPIN_DIR="$HOME/.config/systemd/user/omnigent-host.service.d"

echo "[install-ops-host] server=$SERVER omnigent=$OMNIGENT"

if [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]]; then
  echo "[install-ops-host] enabling linger for $USER"
  loginctl enable-linger "$USER"
fi

"$OMNIGENT" host enable --server "$SERVER" --non-interactive

mkdir -p "$DROPIN_DIR"
cat > "$DROPIN_DIR/10-always-on.conf" <<'CONF'
# Managed by underwright ops/install-ops-host.sh (gh-163). Source:
# ops/systemd/omnigent-host.service.d/10-always-on.conf
[Unit]
StartLimitIntervalSec=0

[Service]
Restart=always
RestartSec=10s
RestartPreventExitStatus=
RestartPreventExitStatus=78
CONF

systemctl --user daemon-reload
systemctl --user enable omnigent-host.service
# No restart here: drop-in restart policy applies to the running unit after daemon-reload.
systemctl --user is-active omnigent-host.service
systemctl --user show omnigent-host.service -p Restart -p UnitFileState -p ActiveState
echo "[install-ops-host] done"
