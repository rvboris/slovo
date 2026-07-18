fn main() {
    // The slovo-input-helper sidecar is built via `scripts/build-helper.js`,
    // which invokes `cargo build --bin slovo-input-helper ...` with
    // SLOVO_BUILDING_HELPER=1 set in the cargo environment.
    //
    // We must NOT run `tauri_build::build()` while compiling the helper:
    // tauri_build merges the platform config (tauri.linux.conf.json),
    // observes `bundle.externalBin` and validates that
    // `binaries/slovo-input-helper-<triple>` already exists. During a helper
    // build that file does not exist yet (it is the artifact we are producing),
    // which makes the build fail with
    //   "resource path binaries/slovo-input-helper-<triple> doesn't exist".
    //
    // This gate only suppresses the Tauri build script for the helper-only
    // cargo invocation. Normal app builds (`cargo build --bin homeborismygitslovo`
    // or `tauri build`/`tauri dev`) never set SLOVO_BUILDING_HELPER, so
    // tauri_build::build() runs normally for them.
    //
    // rerun-if-env-changed forces Cargo to re-execute this build script whenever
    // the variable's presence/absence changes between invocations, so a cached
    // helper build (script ran, env was set) cannot leak into a subsequent app
    // build (env unset) — Cargo will rerun and re-evaluate the gate.
    println!("cargo:rerun-if-env-changed=SLOVO_BUILDING_HELPER");
    if std::env::var_os("SLOVO_BUILDING_HELPER").is_some() {
        return;
    }
    tauri_build::build()
}
