{
  description = "friend.fish — RTSPS-to-MoQ publisher";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    moq = {
      url = "github:moq-dev/moq";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { nixpkgs, flake-utils, moq, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        moq-cli = moq.packages.${system}.moq-cli;

        # Bridges the camera's RTSPS feed into the friend.fish MoQ broadcast.
        # Required env: RTSPS_SOURCE (rtsps:// URL).
        # Optional:     MOQ_BROADCAST, MOQ_RELAY_URL.
        publish = pkgs.writeShellApplication {
          name = "friend-fish-publish";
          runtimeInputs = [ pkgs.ffmpeg moq-cli ];
          text = ''
            : "''${RTSPS_SOURCE:?Set RTSPS_SOURCE to the camera rtsps:// URL}"

            BROADCAST="''${MOQ_BROADCAST:-friend.fish/tank}"
            RELAY_URL="''${MOQ_RELAY_URL:-https://cdn.moq.dev/anon}"

            ffmpeg \
              -fflags nobuffer -flags low_delay \
              -rtsp_transport tcp -i "$RTSPS_SOURCE" \
              -c:v copy -an \
              -f mp4 -movflags +frag_every_frame+empty_moov+default_base_moof+omit_tfhd_offset - \
              | moq-cli publish --url "$RELAY_URL" --broadcast "$BROADCAST" fmp4
          '';
        };

        # Minimal layered image — only ffmpeg, moq-cli, cacert, and the
        # publish wrapper end up in the closure. Build with
        # `nix build .#docker && docker load < result`.
        docker = pkgs.dockerTools.buildLayeredImage {
          name = "friend-fish-publisher";
          tag = "latest";
          contents = [ pkgs.cacert ];
          config = {
            Entrypoint = [ "${publish}/bin/friend-fish-publish" ];
            Env = [
              "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
            ];
          };
        };
      in {
        packages = {
          inherit publish docker;
          default = publish;
        };

        apps.default = {
          type = "app";
          program = "${publish}/bin/friend-fish-publish";
        };

        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.nodejs_22
            pkgs.ffmpeg
            moq-cli
            publish
          ];
        };
      });
}
