#[cfg(target_os = "linux")]
#[path = "../shortcut/chord.rs"]
mod chord;
#[cfg(target_os = "linux")]
#[path = "../shortcut/helper/mod.rs"]
mod helper;
#[cfg(target_os = "linux")]
#[path = "../shortcut/matcher.rs"]
mod matcher;
#[cfg(target_os = "linux")]
#[path = "../shortcut/protocol.rs"]
mod protocol;

#[cfg(target_os = "linux")]
fn main() {
    if let Err(error) = helper::run() {
        eprintln!("[slovo-input-helper] {error}");
        std::process::exit(1);
    }
}

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("slovo-input-helper is supported only on Linux");
    std::process::exit(1);
}
