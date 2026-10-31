use std::collections::BTreeSet;
use std::io;
use std::ptr::{null, null_mut};
use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::System::Registry::*;

struct Key(HKEY);
impl Drop for Key {
    fn drop(&mut self) {
        unsafe { RegCloseKey(self.0) };
    }
}
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}
fn open(root: HKEY, path: &str, view: u32) -> Option<Key> {
    let mut key = null_mut();
    if unsafe { RegOpenKeyExW(root, wide(path).as_ptr(), 0, KEY_READ | view, &mut key) }
        == ERROR_SUCCESS
    {
        Some(Key(key))
    } else {
        None
    }
}
fn value(key: &Key, name: &str) -> Option<String> {
    let mut data = vec![0u16; 32768];
    let mut bytes = (data.len() * 2) as u32;
    let mut kind = 0;
    if unsafe {
        RegQueryValueExW(
            key.0,
            wide(name).as_ptr(),
            null(),
            &mut kind,
            data.as_mut_ptr().cast(),
            &mut bytes,
        )
    } != ERROR_SUCCESS
        || kind != REG_SZ
    {
        return None;
    }
    Some(String::from_utf16_lossy(
        &data[..(bytes as usize / 2).saturating_sub(1)],
    ))
}
pub fn list() -> io::Result<()> {
    let mut roots = BTreeSet::new();
    for root in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
        for view in [KEY_WOW64_64KEY, KEY_WOW64_32KEY] {
            for executable in [
                "Code.exe",
                "Cursor.exe",
                "Windsurf.exe",
                "zed.exe",
                "sublime_text.exe",
                "idea64.exe",
                "webstorm64.exe",
                "pycharm64.exe",
                "goland64.exe",
                "phpstorm64.exe",
                "rubymine64.exe",
                "clion64.exe",
                "rider64.exe",
                "rustrover64.exe",
            ] {
                if let Some(key) = open(
                    root,
                    &format!(
                        "Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\{executable}"
                    ),
                    view,
                ) && let Some(path) = value(&key, "")
                {
                    roots.insert(path);
                }
            }
            let Some(key) = open(
                root,
                "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
                view,
            ) else {
                continue;
            };
            for index in 0..4096 {
                let mut name = [0u16; 512];
                let mut count = name.len() as u32;
                let result = unsafe {
                    RegEnumKeyExW(
                        key.0,
                        index,
                        name.as_mut_ptr(),
                        &mut count,
                        null(),
                        null_mut(),
                        null_mut(),
                        null_mut(),
                    )
                };
                if result == ERROR_NO_MORE_ITEMS {
                    break;
                }
                if result != ERROR_SUCCESS {
                    continue;
                }
                let Some(entry) = open(
                    key.0,
                    &String::from_utf16_lossy(&name[..count as usize]),
                    view,
                ) else {
                    continue;
                };
                let Some(display) = value(&entry, "DisplayName") else {
                    continue;
                };
                let display = display.to_lowercase();
                if ![
                    "visual studio code",
                    "cursor",
                    "windsurf",
                    "zed",
                    "sublime text",
                    "intellij",
                    "webstorm",
                    "pycharm",
                    "goland",
                    "phpstorm",
                    "rubymine",
                    "clion",
                    "rider",
                    "rustrover",
                ]
                .iter()
                .any(|name| display.contains(name))
                {
                    continue;
                }
                for field in ["InstallLocation", "DisplayIcon"] {
                    if let Some(path) = value(&entry, field) {
                        roots.insert(path);
                    }
                }
            }
        }
    }
    println!("{}", serde_json::json!(roots));
    Ok(())
}
