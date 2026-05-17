{
  description = "friend.fish dev shell";

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
      let pkgs = nixpkgs.legacyPackages.${system}; in {
        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.nodejs_22
            pkgs.ffmpeg
            moq.packages.${system}.moq-cli
          ];
        };
      });
}
