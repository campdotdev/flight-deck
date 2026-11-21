// Sandbox policy builds a session's `sandbox` block and a cache refresh's `sandbox-runtime` settings from one
// function, so the two stay the same (spec 1, "Sandbox policy", ADR 0018). Scenarios check a session's block
// in its settings file. This checks the refresh against it.
import { describe, expect, test } from "bun:test";
import type { Folders } from "../../src/folders/index.ts";
import { sandboxPolicy } from "../../src/sandbox-policy/index.ts";

const folders: Folders = {
  data: "/Users/hunter/.local/share/flight-deck",
  config: "/Users/hunter/.config/flight-deck",
  sessionRoot: "/Users/Shared/flight-deck/hunter",
  home: "/Users/hunter",
};
const versionFolder = "/Users/hunter/.local/share/flight-deck/versions/0.1.0";
const record = { sandbox: { hosts: ["registry.npmjs.org", "*.example.com"], read_paths: ["~/.nvm"] } };
const repo = "campdotdev/shaders";

const session = sandboxPolicy({
  kind: "session",
  folders,
  repo,
  record,
  versionFolder,
  worktree: "/Users/Shared/flight-deck/hunter/worktrees/abc123",
  sessionFolder: "/Users/Shared/flight-deck/hunter/sessions/abc123",
});

const refresh = sandboxPolicy({
  kind: "refresh",
  folders,
  repo,
  record,
  versionFolder,
  worktree: "/Users/Shared/flight-deck/hunter/worktrees/cache-campdotdev-shaders",
  sessionFolder: "/Users/Shared/flight-deck/hunter/sessions/def456",
});

describe("a session's sandbox block", () => {
  test("is the whole block spec 1 lists", () => {
    expect(session).toEqual({
      enabled: true,
      allowUnsandboxedCommands: false,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      filesystem: {
        denyRead: ["/Users/hunter/", "/Users/Shared/flight-deck/hunter"],
        allowRead: [
          "/Users/Shared/flight-deck/hunter/worktrees/abc123",
          "/Users/Shared/flight-deck/hunter/sessions/abc123",
          "/Users/hunter/.local/share/flight-deck/versions/0.1.0/skills",
          "/Users/hunter/.local/share/flight-deck/versions/0.1.0/plugin",
          "/Users/hunter/.claude/projects/-Users-Shared-flight-deck-hunter-worktrees-abc123",
          "/Users/hunter/.local/share/flight-deck/repos/campdotdev/shaders/clone",
          "/Users/Shared/flight-deck/hunter/etc",
          "/Users/hunter/.nvm",
        ],
        allowWrite: [
          "/Users/Shared/flight-deck/hunter/sessions/abc123/outbox",
          "/Users/Shared/flight-deck/hunter/sessions/abc123/tmp",
          "/Users/Shared/flight-deck/hunter/sessions/abc123/deps",
          "/Users/Shared/flight-deck/hunter/sessions/abc123/home",
        ],
        denyWrite: ["/Users/hunter/.local/share/flight-deck/repos/campdotdev/shaders/clone/.git"],
      },
      network: {
        allowedDomains: ["registry.npmjs.org", "*.example.com"],
        deniedDomains: ["github.com", "api.github.com", "uploads.github.com"],
        allowLocalBinding: true,
      },
    });
  });
});

describe("a cache refresh's sandbox-runtime settings", () => {
  test("use the same hosts and the same denied hosts, and allow no local binding", () => {
    expect(refresh.network).toEqual({ ...session.network, allowLocalBinding: false });
  });

  test("use the same read rules for the scratch worktree, and reopen only the repo's own cache in the session root", () => {
    expect(refresh.filesystem.denyRead).toEqual(session.filesystem.denyRead);
    expect(refresh.filesystem.allowRead).toEqual([
      "/Users/Shared/flight-deck/hunter/worktrees/cache-campdotdev-shaders",
      "/Users/Shared/flight-deck/hunter/sessions/def456",
      "/Users/hunter/.local/share/flight-deck/versions/0.1.0/skills",
      "/Users/hunter/.local/share/flight-deck/versions/0.1.0/plugin",
      "/Users/hunter/.claude/projects/-Users-Shared-flight-deck-hunter-worktrees-cache-campdotdev-shaders",
      "/Users/hunter/.local/share/flight-deck/repos/campdotdev/shaders/clone",
      "/Users/Shared/flight-deck/hunter/etc",
      "/Users/hunter/.nvm",
      "/Users/Shared/flight-deck/hunter/cache/campdotdev/shaders",
    ]);
  });

  test("write the scratch worktree, its deps/, its temp folder, its home/, and the cache, and never the clone's .git/", () => {
    expect(refresh.filesystem.allowWrite).toEqual([
      "/Users/Shared/flight-deck/hunter/worktrees/cache-campdotdev-shaders",
      "/Users/Shared/flight-deck/hunter/sessions/def456/deps",
      "/Users/Shared/flight-deck/hunter/sessions/def456/tmp",
      "/Users/Shared/flight-deck/hunter/sessions/def456/home",
      "/Users/Shared/flight-deck/hunter/cache/campdotdev/shaders",
    ]);
    expect(refresh.filesystem.denyWrite).toEqual(session.filesystem.denyWrite);
  });

  test("hold no Claude Code keys", () => {
    expect(Object.keys(refresh).sort()).toEqual(["filesystem", "network"]);
  });
});
