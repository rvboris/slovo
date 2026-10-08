#!/bin/sh
set -eu
mkdir -p coverage/rust
cargo llvm-cov --manifest-path src-tauri/Cargo.toml --workspace --all-targets --no-report
cargo llvm-cov report --manifest-path src-tauri/Cargo.toml --workspace --lcov --output-path coverage/rust/lcov.info
cargo llvm-cov report --manifest-path src-tauri/Cargo.toml --workspace --html --output-dir coverage/rust
cargo llvm-cov report --manifest-path src-tauri/Cargo.toml --workspace --json --summary-only --output-path coverage/rust/summary.json
cargo llvm-cov report --manifest-path src-tauri/Cargo.toml --workspace --text --fail-under-lines 62.9
