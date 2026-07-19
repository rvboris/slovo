#!/usr/bin/env node
// Builds the slovo-input-helper sidecar binary for the current Linux target and
// stages it at src-tauri/binaries/slovo-input-helper-<triple>, which is where
// Tauri's `bundle.externalBin` expects platform-suffixed sidecars to live.
//
// Scope:
//   - Linux-only. Skips cleanly (exit 0) on other platforms so the same
//     npm scripts can be referenced from platform-agnostic configs without
//     breaking non-Linux hosts.
//   - Invoked from Tauri beforeDevCommand / beforeBuildCommand (via the Linux
//     config override), never from build.rs, to avoid re-entering Cargo during
//     the very build Cargo is performing.
//
// Exit codes:
//   0  success (or skipped on non-Linux)
//   1  misconfiguration / unknown target / staging failure
//   N  forwarded from cargo when the build fails

"use strict";

import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  copyFileSync,
  chmodSync,
  existsSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const REPO_ROOT = join(__dirname, "..");
const SRC_TAURI_DIR = join(REPO_ROOT, "src-tauri");
const BINARIES_DIR = join(SRC_TAURI_DIR, "binaries");
const CARGO_BIN_NAME = "slovo-input-helper";
// Tauri externalBin suffix uses the rust target triple verbatim (no vendor/os
// remapping). These are the Linux triples we explicitly support. Reject unknown
// triples loudly rather than silently emitting a mis-named sidecar.
const SUPPORTED_LINUX_TRIPLES = new Set([
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
  "x86_64-unknown-linux-musl",
  "aarch64-unknown-linux-musl",
]);

function info(msg) {
  // Progress/diagnostic output goes to stderr so it is not lost when stdout is
  // piped (e.g. captured by Tauri) and so stdout stays reserved for any
  // machine-readable result a future caller might want.
  process.stderr.write(`[build-helper] ${msg}\n`);
}
function fatal(msg, code = 1) {
  process.stderr.write(`[build-helper] ERROR: ${msg}\n`);
  // Flush stdout/stderr before exiting so piped consumers never lose the
  // final diagnostic.
  process.exit(code);
}

/**
 * Parse argv. Mode (--debug/--release) is required and explicit so callers
 * cannot accidentally inherit an ambient PROFILE/CARGO_* env value that picks
 * the wrong artifact. Target is optional and resolved from the environment.
 * --platform overrides the OS skip check (for tests only).
 */
function parseArgs(argv) {
  const opts = { debug: null, target: null, platformOverride: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--debug") opts.debug = true;
    else if (a === "--release") opts.debug = false;
    else if (a === "--target") {
      opts.target = argv[++i];
      if (!opts.target) fatal("--target requires a value");
    } else if (a.startsWith("--target=")) {
      opts.target = a.slice("--target=".length);
    } else if (a === "--platform") {
      opts.platformOverride = argv[++i];
      if (!opts.platformOverride) fatal("--platform requires a value");
    } else if (a.startsWith("--platform=")) {
      opts.platformOverride = a.slice("--platform=".length);
    } else if (a === "-h" || a === "--help") {
      process.stdout.write(
        [
          "Usage: node scripts/build-helper.js [--debug|--release] [--target <triple>] [--platform <os>]",
          "",
          "  --debug            Build helper in debug profile.",
          "  --release          Build helper in release profile.",
          "  --target <triple>  Rust target triple (default: resolved from env/host).",
          "  --platform <os>    Override OS skip check (testing only).",
          "",
        ].join("\n") + "\n"
      );
      process.exit(0);
    } else {
      fatal(`Unknown argument: ${a}`);
    }
  }
  if (opts.debug === null) {
    fatal("Missing mode: pass exactly one of --debug or --release.");
  }
  return opts;
}

/** True if the (effective) host is Linux. */
function isLinuxHost(platformOverride) {
  const os = platformOverride || process.platform;
  return os === "linux";
}

/**
 * Resolve the rust target triple. Priority:
 *   1. Explicit --target on the CLI.
 *   2. CARGO_BUILD_TARGET (cargo-native env).
 *   3. TAURI_ENV_TARGET_TRIPLE (set by Tauri during bundle builds).
 *   4. `rustc -vV` host triple.
 */
function resolveTargetTriple(cliTarget) {
  if (cliTarget) return cliTarget;
  const cargoEnv = process.env.CARGO_BUILD_TARGET;
  if (cargoEnv && cargoEnv.trim()) return cargoEnv.trim();
  const tauriEnv = process.env.TAURI_ENV_TARGET_TRIPLE;
  if (tauriEnv && tauriEnv.trim()) return tauriEnv.trim();
  return hostTripleFromRustc();
}

function hostTripleFromRustc() {
  const out = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
  if (out.error || out.status !== 0) {
    fatal(
      `Could not determine target triple and rustc -vV failed: ${
        out.error ? out.error.message : out.stderr
      }`
    );
  }
  const m = /host:\s*(\S+)/.exec(out.stdout);
  if (!m) {
    fatal(`Could not parse host triple from rustc -vV output:\n${out.stdout}`);
  }
  return m[1];
}

/**
 * Validate the resolved triple. Refuse unknown triples loudly rather than emit
 * a sidecar with a name that won't match any Tauri lookup.
 */
function assertSupportedLinuxTriple(triple) {
  if (SUPPORTED_LINUX_TRIPLES.has(triple)) return;
  const isLinuxish = triple.includes("-linux-") || triple.endsWith("-linux");
  if (isLinuxish) {
    fatal(
      `Target triple '${triple}' looks like Linux but is not in the explicitly supported list ` +
        `(${[...SUPPORTED_LINUX_TRIPLES].join(", ")}). Add it to SUPPORTED_LINUX_TRIPLES if intended.`
    );
  }
  fatal(
    `Target triple '${triple}' is not a supported Linux target. slovo-input-helper is Linux-only.`
  );
}

function cargoBuild({ debug, target }) {
  // Always pass --target explicitly so the target/ layout is predictable and
  // TAURI_ENV_TARGET_TRIPLE cannot silently change where the artifact lands.
  // cargo has no --debug flag; debug is the default and release is opt-in via
  // --release.
  const args = [
    "build",
    "-p",
    "slovo-input-helper",
    "--manifest-path",
    join(SRC_TAURI_DIR, "Cargo.toml"),
  ];
  if (!debug) args.push("--release");
  args.push("--target", target);
  info(`cargo ${args.join(" ")}  (cwd: ${SRC_TAURI_DIR})`);
  // Run cargo from src-tauri. spawnSync with arg vector — no shell interpolation.
  const result = spawnSync("cargo", args, {
    cwd: SRC_TAURI_DIR,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) fatal(`Failed to spawn cargo: ${result.error.message}`);
  if (result.status !== 0) fatal(`cargo build failed (exit ${result.status})`, result.status);
}

function locateArtifact({ debug, target }) {
  const profileDir = debug ? "debug" : "release";
  const exe = join(SRC_TAURI_DIR, "target", target, profileDir, CARGO_BIN_NAME);
  if (!existsSync(exe)) fatal(`Expected cargo output not found: ${exe}`);
  return exe;
}

function stageSidecar(srcExe, triple) {
  // Create the destination dir safely. recursive mkdir is idempotent and does
  // not throw if the dir already exists; we verify it is a directory after.
  mkdirSync(BINARIES_DIR, { recursive: true, mode: 0o755 });
  const dirStat = statSync(BINARIES_DIR);
  if (!dirStat.isDirectory()) fatal(`${BINARIES_DIR} exists and is not a directory`);
  const dest = join(BINARIES_DIR, `${CARGO_BIN_NAME}-${triple}`);
  copyFileSync(srcExe, dest);
  chmodSync(dest, 0o755);
  const st = statSync(dest);
  info(`staged sidecar: ${dest} (${st.size} bytes, mode 0o755)`);
  return dest;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!isLinuxHost(opts.platformOverride)) {
    const os = opts.platformOverride || process.platform;
    info(`Not Linux (platform='${os}'); skipping slovo-input-helper sidecar build.`);
    return;
  }
  const triple = resolveTargetTriple(opts.target);
  assertSupportedLinuxTriple(triple);
  info(`target triple: ${triple}`);
  info(`mode: ${opts.debug ? "debug" : "release"}`);
  cargoBuild({ debug: opts.debug, target: triple });
  const exe = locateArtifact({ debug: opts.debug, target: triple });
  stageSidecar(exe, triple);
}

main();
