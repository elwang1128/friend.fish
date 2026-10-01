# Livestream publisher

The publisher container bridges the local RTSPS camera feed to the MoQ relay.
Run it as a rootless Quadlet so systemd can restart it and Podman can update it.

Create `~/.config/containers/systemd/friend-fish.container`:

```ini
[Unit]
Description=Friend Fish livestream
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=0

[Container]
Image=ghcr.io/elwang1128/friend.fish:latest
ContainerName=friend-fish
Pull=newer
AutoUpdate=registry
EnvironmentFile=%h/.config/friend-fish/publisher.env
Environment=TZ=America/Los_Angeles

[Service]
Restart=always
RestartSec=5min

[Install]
WantedBy=default.target
```

Create `~/.config/friend-fish/publisher.env` with the publisher configuration:

```text
MOQ_RELAY_URL=https://cdn.moq.pro/example?jwt=replace-me
RTSPS_SOURCE=rtsps://camera.example:7441/example?enableSrtp
```

Protect the environment file and start the service:

```sh
chmod 600 ~/.config/friend-fish/publisher.env
systemctl --user daemon-reload
systemctl --user enable --now friend-fish.service
systemctl --user enable --now podman-auto-update.timer
```

`AutoUpdate=registry` updates a healthy running container. `Pull=newer` checks
the registry whenever systemd recreates the container, including after a crash.
Both settings are required so a broken image can be replaced automatically.

Check the service and update configuration:

```sh
systemctl --user status friend-fish.service
podman auto-update --dry-run
systemctl --user list-timers podman-auto-update.timer
```
