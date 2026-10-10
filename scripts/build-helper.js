#!/usr/bin/env node
// Builds the slovo-input-helper sidecar binary for the current Linux target and
// Stages it at src-tauri/binaries/slovo-input-helper-<triple>, which is where
// Tauri's `bundle.externalBin` expects platform-suffixed sidecars to live.
//
// Scope:
//   - Linux-only. Skips cleanly (exit 0) on other platforms so the same
//     Npm scripts can be referenced from platform-agnostic configs without
//     Breaking non-Linux hosts.
//   - Invoked from Tauri beforeDevCommand / beforeBuildCommand (via the Linux
//     Config override), never from build.rs, to avoid re-entering Cargo during
//     The very build Cargo is performing.
//
// Exit codes:
//   0  success (or skipped on non-Linux)
//   1  misconfiguration / unknown target / staging failure
//   N  forwarded from cargo when the build fails

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SUCCESS = 0;
const FAILURE = 1;
const EXECUTABLE_MODE = 0o755;
const CLI_ARGUMENT_OFFSET = 2;

const REPO_ROOT = path.join(import.meta.dirname, "..");
const SRC_TAURI_DIR = path.join(REPO_ROOT, "src-tauri");
const BINARIES_DIR = path.join(SRC_TAURI_DIR, "binaries");
const CARGO_BIN_NAME = "slovo-input-helper";
// Tauri externalBin suffix uses the rust target triple verbatim (no vendor/os
// Remapping). These are the Linux triples we explicitly support. Reject unknown
// Triples loudly rather than silently emitting a mis-named sidecar.
const SUPPORTED_LINUX_TRIPLES = new Set([
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
  "x86_64-unknown-linux-musl",
  "aarch64-unknown-linux-musl",
]);

/** @param {string} msg */
function info(msg) {
  // Progress/diagnostic output goes to stderr so it is not lost when stdout is
  // Piped (e.g. captured by Tauri) and so stdout stays reserved for any
  // Machine-readable result a future caller might want.
  process.stderr.write(`[build-helper] ${msg}\n`);
}
/**
 * @param {string} msg
 * @param {number} code
 * @returns {never}
 */
function fatal(msg, code = FAILURE) {
  process.stderr.write(`[build-helper] ERROR: ${msg}\n`);
  // Flush stdout/stderr before exiting so piped consumers never lose the
  // Final diagnostic.
  process.exit(code);
}

/**
 * @param {string} option
 * @param {string | undefined} value
 * @returns {string}
 */
function requireOptionValue(option, value) {
  if (value === undefined || value === "") {
    fatal(`${option} requires a value`);
  }
  return value;
}

/**
 * Parse argv. Mode (--debug/--release) is required and explicit so callers
 * cannot accidentally inherit an ambient PROFILE/CARGO_* env value that picks
 * the wrong artifact. Target is optional and resolved from the environment.
 * --platform overrides the OS skip check (for tests only).
 */
/** @param {readonly string[]} argv */
function parseArgs(argv) {
  /** @type {{debug: boolean | undefined, platformOverride: string | undefined, target: string | undefined}} */
  const opts = { debug: undefined, platformOverride: undefined, target: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--debug") {
      opts.debug = true;
    } else if (argument === "--release") {
      opts.debug = false;
    } else if (argument === "--target") {
      index += 1;
      opts.target = requireOptionValue("--target", argv.at(index));
    } else if (argument.startsWith("--target=")) {
      opts.target = argument.slice("--target=".length);
    } else if (argument === "--platform") {
      index += 1;
      opts.platformOverride = requireOptionValue("--platform", argv.at(index));
    } else if (argument.startsWith("--platform=")) {
      opts.platformOverride = argument.slice("--platform=".length);
    } else if (argument === "-h" || argument === "--help") {
      process.stdout.write(
        `${[
          "Usage: node scripts/build-helper.js [--debug|--release] [--target <triple>] [--platform <os>]",
          "",
          "  --debug            Build helper in debug profile.",
          "  --release          Build helper in release profile.",
          "  --target <triple>  Rust target triple (default: resolved from env/host).",
          "  --platform <os>    Override OS skip check (testing only).",
          "",
        ].join("\n")}\n`,
      );
      process.exit(SUCCESS);
    } else {
      fatal(`Unknown argument: ${argument}`);
    }
  }
  if (opts.debug === undefined) {
    fatal("Missing mode: pass exactly one of --debug or --release.");
  }
  return opts;
}

/** True if the (effective) host is Linux. */
/** @param {string | undefined} platformOverride */
function isLinuxHost(platformOverride) {
  const os = process.platform;
  if (platformOverride !== undefined && platformOverride !== "") {
    return platformOverride === "linux";
  }
  return os === "linux";
}

function hostTripleFromRustc() {
  const out = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
  if (out.error !== undefined || out.status !== SUCCESS) {
    fatal(
      `Could not determine target triple and rustc -vV failed: ${out.error?.message ?? out.stderr}`,
    );
  }
  const match = /host:\s*(?<triple>\S+)/u.exec(out.stdout);
  const triple = match?.groups?.triple;
  if (triple === undefined) {
    fatal(`Could not parse host triple from rustc -vV output:\n${out.stdout}`);
  }
  return triple;
}

/**
 * Resolve the rust target triple. Priority:
 *   1. Explicit --target on the CLI.
 *   2. CARGO_BUILD_TARGET (cargo-native env).
 *   3. TAURI_ENV_TARGET_TRIPLE (set by Tauri during bundle builds).
 *   4. `rustc -vV` host triple.
 */
/** @param {string | undefined} cliTarget */
function resolveTargetTriple(cliTarget) {
  if (cliTarget !== undefined && cliTarget !== "") {
    return cliTarget;
  }
  const cargoEnv = process.env.CARGO_BUILD_TARGET?.trim();
  if (cargoEnv !== undefined && cargoEnv !== "") {
    return cargoEnv;
  }
  const tauriEnv = process.env.TAURI_ENV_TARGET_TRIPLE?.trim();
  if (tauriEnv !== undefined && tauriEnv !== "") {
    return tauriEnv;
  }
  return hostTripleFromRustc();
}

/**
 * Validate the resolved triple. Refuse unknown triples loudly rather than emit
 * a sidecar with a name that won't match any Tauri lookup.
 */
/** @param {string} triple */
function assertSupportedLinuxTriple(triple) {
  if (SUPPORTED_LINUX_TRIPLES.has(triple)) {
    return;
  }
  const isLinuxish = triple.includes("-linux-") || triple.endsWith("-linux");
  if (isLinuxish) {
    fatal(
      `Target triple '${triple}' looks like Linux but is not in the explicitly supported list ` +
        `(${[...SUPPORTED_LINUX_TRIPLES].join(", ")}). Add it to SUPPORTED_LINUX_TRIPLES if intended.`,
    );
  }
  fatal(
    `Target triple '${triple}' is not a supported Linux target. slovo-input-helper is Linux-only.`,
  );
}

/** @param {Readonly<{debug: boolean | undefined, target: string}>} options */
function cargoBuild({ debug, target }) {
  // Always pass --target explicitly so the target/ layout is predictable and
  // TAURI_ENV_TARGET_TRIPLE cannot silently change where the artifact lands.
  // Cargo has no --debug flag; debug is the default and release is opt-in via
  // --release.
  const args = [
    "build",
    "-p",
    "slovo-input-helper",
    "--manifest-path",
    path.join(SRC_TAURI_DIR, "Cargo.toml"),
  ];
  if (debug !== true) {
    args.push("--release");
  }
  args.push("--target", target);
  info(`cargo ${args.join(" ")}  (cwd: ${SRC_TAURI_DIR})`);
  // Run cargo from src-tauri. spawnSync with arg vector — no shell interpolation.
  const result = spawnSync("cargo", args, {
    cwd: SRC_TAURI_DIR,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) {
    fatal(`Failed to spawn cargo: ${result.error.message}`);
  }
  if (result.status !== SUCCESS) {
    fatal(`cargo build failed (exit ${result.status})`, result.status);
  }
}

/** @param {Readonly<{debug: boolean | undefined, target: string}>} options */
function locateArtifact({ debug, target }) {
  let profileDir = "release";
  if (debug === true) {
    profileDir = "debug";
  }
  const exe = path.join(SRC_TAURI_DIR, "target", target, profileDir, CARGO_BIN_NAME);
  if (!fs.existsSync(exe)) {
    fatal(`Expected cargo output not found: ${exe}`);
  }
  return exe;
}

/**
 * @param {string} srcExe
 * @param {string} triple
 */
function stageSidecar(srcExe, triple) {
  // Create the destination dir safely. recursive mkdir is idempotent and does
  // Not throw if the dir already exists; we verify it is a directory after.
  fs.mkdirSync(BINARIES_DIR, { mode: EXECUTABLE_MODE, recursive: true });
  const dirStat = fs.statSync(BINARIES_DIR);
  if (!dirStat.isDirectory()) {
    fatal(`${BINARIES_DIR} exists and is not a directory`);
  }
  const dest = path.join(BINARIES_DIR, `${CARGO_BIN_NAME}-${triple}`);
  fs.copyFileSync(srcExe, dest);
  fs.chmodSync(dest, EXECUTABLE_MODE);
  const st = fs.statSync(dest);
  info(`staged sidecar: ${dest} (${st.size} bytes, mode 0o755)`);
  return dest;
}

function main() {
  const opts = parseArgs(process.argv.slice(CLI_ARGUMENT_OFFSET));
  if (!isLinuxHost(opts.platformOverride)) {
    let os = opts.platformOverride;
    if (os === undefined || os === "") {
      os = process.platform;
    }
    info(`Not Linux (platform='${os}'); skipping slovo-input-helper sidecar build.`);
    return;
  }
  const triple = resolveTargetTriple(opts.target);
  assertSupportedLinuxTriple(triple);
  info(`target triple: ${triple}`);
  let mode = "release";
  if (opts.debug === true) {
    mode = "debug";
  }
  info(`mode: ${mode}`);
  cargoBuild({ debug: opts.debug, target: triple });
  const exe = locateArtifact({ debug: opts.debug, target: triple });
  stageSidecar(exe, triple);
}

main();
