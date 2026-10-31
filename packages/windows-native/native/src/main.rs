mod editors;
mod fonts;
mod process;
mod sandbox;

fn main() {
    unsafe {
        windows_sys::Win32::System::Diagnostics::Debug::SetErrorMode(0x8003);
    }
    let result = match std::env::args().nth(1).as_deref() {
        Some("fonts") => fonts::list().map_err(|error| std::io::Error::other(error.to_string())),
        Some("editor-roots") => editors::list(),
        Some("sandbox-probe") => sandbox::probe(),
        None => process::run(),
        _ => Err(std::io::Error::other("Windows 原生程序操作无效")),
    };
    if let Err(error) = result {
        println!(
            "{}",
            serde_json::json!({"type":"error", "message":error.to_string()})
        );
        std::process::exit(1);
    }
}
