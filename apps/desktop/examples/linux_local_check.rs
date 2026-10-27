//! Explicit owned-fixture diagnostic, not a production launch mode.
use std::{
    path::PathBuf,
    sync::{Arc, atomic::AtomicBool},
};

fn main() {
    assert!(
        std::env::var_os("PILOT_HOME").is_some(),
        "supply an explicit owned fixture profile"
    );
    let executable = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .expect("supply the executable inside an owned disposable Linux package");
    match pilot_desktop::bundled_runtime::start(executable, Arc::new(AtomicBool::new(false))) {
        Ok(_) => println!("owned fixture Local ready"),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
