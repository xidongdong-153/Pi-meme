use serde_json::json;
use windows::Win32::Graphics::DirectWrite::*;
use windows::core::{Interface, PCWSTR};

pub fn list() -> windows::core::Result<()> {
    unsafe {
        let factory: IDWriteFactory = DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED)?;
        let mut collection = None;
        factory.GetSystemFontCollection(&mut collection, true)?;
        let collection = collection.unwrap();
        let mut families = Vec::new();
        for index in 0..collection.GetFontFamilyCount() {
            let family = collection.GetFontFamily(index)?;
            let names = family.GetFamilyNames()?;
            let mut selected = 0;
            for locale in ["zh-cn", "en-us"] {
                let locale: Vec<u16> = locale.encode_utf16().chain(Some(0)).collect();
                let mut found = false.into();
                let mut index = 0;
                names.FindLocaleName(PCWSTR(locale.as_ptr()), &mut index, &mut found)?;
                if found.as_bool() {
                    selected = index;
                    break;
                }
            }
            let mut name = vec![0u16; names.GetStringLength(selected)? as usize + 1];
            names.GetString(selected, &mut name)?;
            let name = String::from_utf16_lossy(&name[..name.len() - 1]);
            let mut faces = Vec::new();
            for member in 0..family.GetFontCount() {
                let font = family.GetFont(member)?;
                if font.GetSimulations() != DWRITE_FONT_SIMULATIONS_NONE {
                    continue;
                }
                let face: IDWriteFontFace1 = font.CreateFontFace()?.cast()?;
                faces.push(json!({"weight": font.GetWeight().0, "italic": font.GetStyle() != DWRITE_FONT_STYLE_NORMAL, "monospace": face.IsMonospacedFont().as_bool()}));
            }
            if !faces.is_empty() {
                families.push(json!({"family":name, "faces":faces}));
            }
        }
        println!("{}", json!(families));
    }
    Ok(())
}
