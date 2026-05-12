{
  description = "friend.fish dev shell";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  inputs.flake-utils.url = "github:numtide/flake-utils";

  outputs = { nixpkgs, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (system: {
      devShells.default = nixpkgs.legacyPackages.${system}.mkShell {
        packages = [ nixpkgs.legacyPackages.${system}.nodejs_22 ];
      };
    });
}
