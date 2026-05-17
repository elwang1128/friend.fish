#!/usr/bin/env bash
# Install the friend.fish publisher as a user-level systemd service.
#
# Idempotent: rerun to pick up template changes or to repair a broken install.
#
# Env overrides:
#   NIX_BIN     Path to the nix binary (default: $(command -v nix))
#   UNIT_NAME   Service name (default: friend-fish-publisher.service)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

UNIT_NAME="${UNIT_NAME:-friend-fish-publisher.service}"
UNIT_SRC="${SCRIPT_DIR}/friend-fish-publisher.service"
UNIT_DEST_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_DEST="${UNIT_DEST_DIR}/${UNIT_NAME}"

ENV_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/friend-fish-publisher"
ENV_FILE="${ENV_DIR}/env"

NIX_BIN="${NIX_BIN:-$(command -v nix || true)}"
if [[ -z "${NIX_BIN}" ]]; then
  echo "error: 'nix' not found on PATH; set NIX_BIN to its absolute path" >&2
  exit 1
fi

if [[ ! -f "${UNIT_SRC}" ]]; then
  echo "error: unit template not found at ${UNIT_SRC}" >&2
  exit 1
fi

mkdir -p "${UNIT_DEST_DIR}" "${ENV_DIR}"

if [[ ! -f "${ENV_FILE}" ]]; then
  cat > "${ENV_FILE}" <<'EOF'
# friend.fish publisher environment.
# Set RTSPS_SOURCE to the camera URL, e.g.
#   RTSPS_SOURCE=rtsps://192.0.2.1:7441/AbCdEf?enableSrtp
RTSPS_SOURCE=

# Optional overrides:
#MOQ_BROADCAST=friend.fish/tank
#MOQ_RELAY_URL=https://cdn.moq.dev/anon
EOF
  chmod 600 "${ENV_FILE}"
  echo "Created ${ENV_FILE} (edit to set RTSPS_SOURCE)."
fi

# Materialize the unit file by substituting paths into the template.
sed \
  -e "s|__WORKING_DIRECTORY__|${REPO_DIR}|g" \
  -e "s|__ENV_FILE__|${ENV_FILE}|g" \
  -e "s|__NIX_BIN__|${NIX_BIN}|g" \
  "${UNIT_SRC}" > "${UNIT_DEST}"

systemctl --user daemon-reload
systemctl --user enable "${UNIT_NAME}" >/dev/null

linger_state="$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || echo no)"
if [[ "${linger_state}" != "yes" ]]; then
  echo
  echo "Linger is disabled for $USER — the service will not start at boot until you run:"
  echo "  sudo loginctl enable-linger $USER"
fi

rtsps_set="$(grep -E '^RTSPS_SOURCE=.+' "${ENV_FILE}" || true)"
if [[ -z "${rtsps_set}" ]]; then
  echo
  echo "RTSPS_SOURCE is empty in ${ENV_FILE}."
  echo "Set it, then start the service with:"
  echo "  systemctl --user start ${UNIT_NAME}"
else
  systemctl --user restart "${UNIT_NAME}"
  echo
  echo "Service installed and started. Useful commands:"
  echo "  systemctl --user status ${UNIT_NAME}"
  echo "  journalctl --user -u ${UNIT_NAME} -f"
fi
