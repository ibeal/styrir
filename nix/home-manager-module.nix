## Home-manager module: the Paperclip launchd agent.
##
## What this agent supervises: the self-hosted Paperclip instance defined by
## deploy/paperclip/ in the styrir repository — authenticated, private,
## tailnet-bound, with product telemetry and feedback-trace sharing off and
## no model-provider credentials. It execs
## deploy/paperclip/scripts/service-run.sh (packaged as
## `paperclip-service-run`) unchanged: that script sources the deployment's
## env file, resolves the host's Tailscale address, and execs `paperclipai
## run`. This module supplies the launchd wiring — login start, restart on
## exit, readable logs, a PATH that makes `tailscale` and the managed
## `paperclipai` launcher findable — and nothing that duplicates or
## re-expresses what that script already does.
##
## Not built here: nix-darwin, a way to run Paperclip's own
## `service install`, or any plist patching. macOS/launchd is the only
## supervision target this module addresses.
{ self }:
{ config, lib, pkgs, ... }:
let
  cfg = config.services.paperclip;

  defaultPackage = self.packages.${pkgs.system}.paperclip-service-run;
in
{
  options.services.paperclip = {
    enable = lib.mkEnableOption "the Paperclip launchd agent (styrir's self-hosted deployment)";

    package = lib.mkOption {
      type = lib.types.package;
      default = defaultPackage;
      defaultText = lib.literalExpression "styrir.packages.<system>.paperclip-service-run";
      description = ''
        Package providing the `paperclip-service-run` executable this agent
        execs. Defaults to styrir's own build of
        `deploy/paperclip/scripts/service-run.sh` — the exact script a
        person runs by hand from a checkout, and the one
        `deploy/paperclip/scripts/up.sh` names as the foreground fallback
        when no launchd agent is installed. Override only to test a
        modified build of that script; the deployment's behavior is not
        something to reimplement in this module.
      '';
    };

    instanceId = lib.mkOption {
      type = lib.types.str;
      default = "default";
      description = ''
        Paperclip instance identifier, passed as
        `paperclipai run --instance <instanceId>`. Matches the instance
        under `~/.paperclip/instances/<instanceId>` that was onboarded on
        this machine.
      '';
    };

    environmentFile = lib.mkOption {
      type = lib.types.path;
      description = ''
        Path to the deployment's `paperclip.env` — the uncommitted, local
        file that carries both this deployment's lockdown settings
        (deployment mode/exposure/bind, telemetry, the feedback-sharing
        default *and* floor) and its secrets (database URL, auth/signing
        keys). Read at service start time by `paperclip-service-run`
        itself, exactly as `scripts/up.sh` and `scripts/pc.sh` read it by
        hand; never copied into the Nix store, and not a flake input.

        This option has no default. Enabling this module without setting
        it fails evaluation instead of silently starting Paperclip with
        none of the deployment's lockdown settings applied.
      '';
    };

    port = lib.mkOption {
      type = lib.types.nullOr lib.types.port;
      default = null;
      description = ''
        Overrides `PORT` in the agent's environment. Leave at the default
        (`null`) to use whatever `environmentFile` specifies, or upstream's
        own default (3100) if it specifies nothing. The port is not a
        secret, so this option exists for changing it without editing the
        env file — but if `environmentFile` also sets `PORT`, that value is
        sourced after this one and wins.
      '';
    };

    extraPath = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [
        "${config.home.homeDirectory}/.local/bin"
        "/opt/homebrew/bin"
        "/usr/local/bin"
        "/usr/bin"
        "/bin"
      ];
      description = ''
        Directories searched, in order, for the host tools Paperclip's
        startup needs — the managed `paperclipai` launcher
        (`~/.local/bin` by default) above all. A launchd agent inherits
        none of a login shell's PATH, which is also why `tailscale` is
        unfindable under the plist `paperclipai service install` generates;
        `paperclip-service-run` resolves a Tailscale binary from a list of
        known install locations on its own, independent of this option, but
        the managed `paperclipai` launcher itself still has to be on PATH
        for this agent to exec anything.
      '';
    };

    logDirectory = lib.mkOption {
      type = lib.types.path;
      default = "${config.home.homeDirectory}/Library/Logs/paperclip";
      description = ''
        Directory for the agent's stdout/stderr logs
        (`paperclip.out.log` / `paperclip.err.log`), created if missing
        when the agent is applied.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    home.activation.paperclipLogDirectory = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      run mkdir -p ${lib.escapeShellArg cfg.logDirectory}
    '';

    launchd.agents.paperclip = {
      enable = true;
      config = {
        Label = "org.styrir.paperclip";
        ProgramArguments = [ "${cfg.package}/bin/paperclip-service-run" ];
        RunAtLoad = true;
        KeepAlive = true;
        StandardOutPath = "${cfg.logDirectory}/paperclip.out.log";
        StandardErrorPath = "${cfg.logDirectory}/paperclip.err.log";
        EnvironmentVariables =
          {
            PATH = lib.concatStringsSep ":" cfg.extraPath;
            PAPERCLIP_ENV_FILE = cfg.environmentFile;
            PAPERCLIP_INSTANCE_ID = cfg.instanceId;
          }
          // lib.optionalAttrs (cfg.port != null) { PORT = toString cfg.port; };
      };
    };
  };
}
