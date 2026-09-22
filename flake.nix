{
  description = ''
    styrir: local command dispatcher, plus the self-hosted Paperclip
    deployment layer under deploy/paperclip/. The interesting outputs for a
    consumer are the packages that wrap that deployment's own scripts
    unmodified in behavior, and the home-manager module that supervises
    Paperclip as a macOS launchd agent carrying that deployment's lockdown
    environment. See deploy/paperclip/README.md for the deployment itself.
  '';

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    { self, nixpkgs, home-manager, ... }:
    let
      supportedSystems = [ "aarch64-darwin" "x86_64-darwin" ];
      forAllSystems = f: nixpkgs.lib.genAttrs supportedSystems f;

      # The deployment this flake exposes. Its behavior is not this flake's
      # to change; see deploy/paperclip/README.md. Packages below install
      # its scripts verbatim so a consumer runs the exact code a person
      # would run by hand from a checkout, not a reimplementation of it.
      deployDir = ./deploy/paperclip;

      mkPackages =
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        rec {
          # `paperclipai` itself is deliberately not packaged here: it is
          # installed on the host through its own managed CLI store
          # (`paperclipai install --version <pinned>`), not nixpkgs. See
          # deploy/paperclip/README.md ("Pinning and upgrading") and
          # deploy/paperclip/VERSION for the version this deployment is
          # pinned to. These packages assume `paperclipai` is already on
          # PATH and fail with a clear error at run time if it is not.

          # The paperclipai CLI, with this deployment's environment file
          # loaded first. Equivalent to running deploy/paperclip/scripts/pc.sh
          # from a checkout; PAPERCLIP_ENV_FILE overrides which env file it
          # loads, so a consumer needs no checkout to use it.
          paperclip-cli = pkgs.runCommand "paperclip-cli" { } ''
            mkdir -p $out/bin
            install -m755 ${deployDir}/scripts/pc.sh $out/bin/paperclip-cli
          '';

          # The Paperclip service entry point: sources the deployment's env
          # file, resolves the tailnet bind address, execs `paperclipai run`.
          # This is exactly deploy/paperclip/scripts/service-run.sh, and it is
          # what the home-manager module below execs — the module does not
          # re-express any part of what this script does.
          paperclip-service-run = pkgs.runCommand "paperclip-service-run" { } ''
            mkdir -p $out/bin
            install -m755 ${deployDir}/scripts/service-run.sh $out/bin/paperclip-service-run
          '';

          # The posture checker (deploy/paperclip/posture/posture-check.mjs),
          # reachable without knowing where in this repository it lives.
          paperclip-posture-check =
            pkgs.runCommand "paperclip-posture-check"
              {
                nativeBuildInputs = [ pkgs.makeWrapper ];
              }
              ''
                mkdir -p $out/share/paperclip-posture $out/bin
                cp -r ${deployDir}/posture/. $out/share/paperclip-posture/
                makeWrapper ${pkgs.nodejs}/bin/node $out/bin/paperclip-posture-check \
                  --add-flags "$out/share/paperclip-posture/posture-check.mjs"
              '';

          default = paperclip-cli;
        };
    in
    {
      packages = forAllSystems mkPackages;

      apps = forAllSystems (system: {
        posture-check = {
          type = "app";
          program = "${self.packages.${system}.paperclip-posture-check}/bin/paperclip-posture-check";
        };
        pc = {
          type = "app";
          program = "${self.packages.${system}.paperclip-cli}/bin/paperclip-cli";
        };
        default = self.apps.${system}.posture-check;
      });

      # A home-manager module, not a nix-darwin module: home-manager's own
      # `launchd.agents` handles user-session launchd agents on darwin
      # without needing nix-darwin. See nix/home-manager-module.nix.
      homeManagerModules.paperclip = import ./nix/home-manager-module.nix { inherit self; };
      homeManagerModules.default = self.homeManagerModules.paperclip;

      checks = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          # Runs the same unit tests as `node --test posture/*.test.mjs`,
          # so `nix flake check` exercises the pure posture-check logic.
          # This does not and cannot exercise the live-instance checks
          # (HTTP, process inspection) — see deploy/paperclip/README.md.
          posture-unit-tests = pkgs.runCommand "paperclip-posture-unit-tests" {
            nativeBuildInputs = [ pkgs.nodejs ];
          } ''
            cp -r ${deployDir}/posture ./posture
            node --test ./posture/*.test.mjs
            touch $out
          '';
        }
      );
    };
}
