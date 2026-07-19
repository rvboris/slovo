#[cfg(target_os = "linux")]
fn main() {
    if let Err(error) = slovo_input_helper::run() {
        eprintln!("[slovo-input-helper] {error}");
        std::process::exit(1);
    }
}

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("slovo-input-helper is supported only on Linux");
    std::process::exit(1);
}
