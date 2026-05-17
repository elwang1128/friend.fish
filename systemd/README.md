# friend.fish publisher — systemd unit

Runs `scripts/publish.sh` as a supervised, user-level systemd service so the
camera-to-MoQ bridge starts at boot and is restarted automatically after any
crash, network blip, or camera reboot.

## Why a service, not a timer

A timer fires on a schedule; it cannot keep a long-running process alive.
The publisher is a continuous stream, so it belongs in a `.service` unit with
`Restart=always`. The unit here uses `StartLimitIntervalSec=0` to disable the
default rate limit, so it will keep retrying every 5 seconds indefinitely
instead of giving up after a burst of failures.

## Prerequisites

- This repo cloned somewhere on disk (the install script uses its own location
  to find the repo root).
- `nix` on `$PATH` with flakes enabled — the service runs the publisher via
  `nix develop --command`, which pulls in `ffmpeg` and `moq-cli` from
  `flake.nix`.
- systemd with user instance support (any modern Linux distro).

## Install

```sh
./systemd/install.sh
```

The script:

1. Renders `friend-fish-publisher.service` with absolute paths baked in and
   writes it to `~/.config/systemd/user/friend-fish-publisher.service`.
2. Creates `~/.config/friend-fish-publisher/env` with a stub `RTSPS_SOURCE=`
   (chmod 600) on first run. **Edit it** and set the camera URL.
3. Reloads the user daemon, enables the unit, and starts it if `RTSPS_SOURCE`
   is set.

Rerun the script after editing the template, moving the repo, or upgrading
nix — it is idempotent.

### Start on boot

User services only run while the user has an active session. To start the
service at boot without logging in, enable linger once:

```sh
sudo loginctl enable-linger "$USER"
```

The install script prints this hint when linger is disabled.

## Configure

`~/.config/friend-fish-publisher/env`:

```sh
RTSPS_SOURCE=rtsps://192.0.2.1:7441/AbCdEf?enableSrtp
# MOQ_BROADCAST=friend.fish/tank
# MOQ_RELAY_URL=https://cdn.moq.dev/anon
```

After editing, restart the service:

```sh
systemctl --user restart friend-fish-publisher.service
```

## Operate

```sh
systemctl --user status  friend-fish-publisher.service
systemctl --user restart friend-fish-publisher.service
systemctl --user stop    friend-fish-publisher.service
systemctl --user disable friend-fish-publisher.service   # don't start at boot
journalctl --user -u friend-fish-publisher.service -f    # follow logs
```

## Uninstall

```sh
systemctl --user disable --now friend-fish-publisher.service
rm ~/.config/systemd/user/friend-fish-publisher.service
systemctl --user daemon-reload
# Optional:
rm -r ~/.config/friend-fish-publisher
sudo loginctl disable-linger "$USER"
```
