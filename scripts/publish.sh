#!/usr/bin/env bash
# Bridge the camera's RTSPS feed into the friend.fish MoQ broadcast.
#
# Required:
#   RTSPS_SOURCE  Camera URL, e.g. rtsps://<console-ip>:7441/<token>?enableSrtp
#
# Optional:
#   MOQ_BROADCAST  Broadcast name on the relay (default: friend.fish/tank)
#   MOQ_RELAY_URL  Relay URL (default: https://cdn.moq.dev/anon)
#
# Run from a `nix develop` shell so ffmpeg and moq-cli are on PATH.
#
# The /anon path on cdn.moq.dev is the public-namespace endpoint; without it
# the relay closes the WebTransport CONNECT.

set -euo pipefail

: "${RTSPS_SOURCE:?Set RTSPS_SOURCE to the camera rtsps:// URL}"

BROADCAST="${MOQ_BROADCAST:-friend.fish/tank}"
RELAY_URL="${MOQ_RELAY_URL:-https://cdn.moq.dev/anon}"

ffmpeg -rtsp_transport tcp -i "$RTSPS_SOURCE" \
  -c:v copy -an \
  -f mp4 -movflags +frag_keyframe+empty_moov+default_base_moof - \
  | moq-cli publish --url "$RELAY_URL" --broadcast "$BROADCAST" fmp4
