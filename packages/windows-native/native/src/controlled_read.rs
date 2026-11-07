use serde::{Deserialize, Serialize};
use std::ffi::c_void;
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use windows_sys::Win32::Foundation::{
    HANDLE, OBJ_CASE_INSENSITIVE, RtlNtStatusToDosError, UNICODE_STRING,
};
use windows_sys::Win32::Globalization::CompareStringOrdinal;
use windows_sys::Win32::Storage::FileSystem::*;

const MAXIMUM: u64 = 64 * 1024 * 1024;

#[derive(Clone, Copy, PartialEq, Eq)]
struct NativeId {
    volume: u64,
    file: [u8; 16],
}
impl From<&FILE_ID_INFO> for NativeId {
    fn from(info: &FILE_ID_INFO) -> Self {
        Self {
            volume: info.VolumeSerialNumber,
            file: info.FileId.Identifier,
        }
    }
}
struct PinnedPath {
    canonical: String,
    ancestry: Vec<NativeId>,
    // A missing selector has existing ancestors but no object that can grant an exception.
    final_id: Option<NativeId>,
}

// Minimal ntdll ABI for handle-relative ancestor pins. Layout/signature follow the
// locked windows-sys 0.61.2 Wdk/Foundation and Wdk/Storage/FileSystem declarations.
// Keep this local instead of enabling unrelated WDK features in the package.
#[repr(C)]
struct NativeObjectAttributes {
    length: u32,
    root_directory: HANDLE,
    object_name: *const UNICODE_STRING,
    attributes: u32,
    security_descriptor: *const c_void,
    security_quality_of_service: *const c_void,
}
#[repr(C)]
union NativeIoStatus {
    status: i32,
    pointer: *mut c_void,
}
#[repr(C)]
struct NativeIoStatusBlock {
    status: NativeIoStatus,
    information: usize,
}
#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtCreateFile(
        file_handle: *mut HANDLE,
        desired_access: u32,
        object_attributes: *const NativeObjectAttributes,
        io_status: *mut NativeIoStatusBlock,
        allocation_size: *const i64,
        file_attributes: u32,
        share_access: u32,
        create_disposition: u32,
        create_options: u32,
        ea_buffer: *const c_void,
        ea_length: u32,
    ) -> i32;
}

/// Open one validated component under the actual held parent, not a second absolute lookup.
fn pin_child(parent: &File, component: &str) -> io::Result<File> {
    let mut name = component.encode_utf16().collect::<Vec<_>>();
    let length = u16::try_from(name.len() * 2).map_err(|_| unsupported("路径组件过长"))?;
    let name_info = UNICODE_STRING {
        Length: length,
        MaximumLength: length,
        Buffer: name.as_mut_ptr(),
    };
    let attributes = NativeObjectAttributes {
        length: std::mem::size_of::<NativeObjectAttributes>() as u32,
        root_directory: parent.as_raw_handle(),
        object_name: &name_info,
        attributes: OBJ_CASE_INSENSITIVE,
        security_descriptor: std::ptr::null(),
        security_quality_of_service: std::ptr::null(),
    };
    let mut handle: HANDLE = std::ptr::null_mut();
    let mut status_block: NativeIoStatusBlock = unsafe { std::mem::zeroed() };
    let status = unsafe {
        NtCreateFile(
            &mut handle,
            FILE_READ_ATTRIBUTES | 0x00100000, // SYNCHRONIZE
            &attributes,
            &mut status_block,
            std::ptr::null(),
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE, // No FILE_SHARE_DELETE.
            1,                                  // FILE_OPEN: never create a selector or ancestor.
            0x00200000 | 0x00000020, // FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT
            std::ptr::null(),
            0,
        )
    };
    if status < 0 {
        return Err(io::Error::from_raw_os_error(
            unsafe { RtlNtStatusToDosError(status) } as i32,
        ));
    }
    if handle.is_null() || handle == -1isize as HANDLE {
        return Err(unsupported("相对目录打开没有返回有效句柄"));
    }
    Ok(unsafe { File::from_raw_handle(handle) })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Identity {
    dev: String,
    ino: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    canonical_path: String,
    expected: Option<Identity>,
    protected_roots: Vec<String>,
    readable_roots: Vec<String>,
    max_bytes: u64,
    #[serde(default)]
    directory: bool,
    max_entries: Option<usize>,
}

#[derive(Serialize)]
struct DirectoryEntry {
    name: String,
    kind: &'static str,
    size: u64,
}

fn denied(message: &str) -> io::Error {
    io::Error::other(format!("controlled-read-denied: {message}"))
}
fn unsupported(message: &str) -> io::Error {
    io::Error::other(format!("controlled-read-unsupported: {message}"))
}
fn equal(a: &str, b: &str) -> bool {
    let left = a.encode_utf16().collect::<Vec<_>>();
    let right = b.encode_utf16().collect::<Vec<_>>();
    unsafe {
        CompareStringOrdinal(
            left.as_ptr(),
            left.len() as i32,
            right.as_ptr(),
            right.len() as i32,
            1,
        ) == 2
    }
}
fn within(root: &str, target: &str) -> bool {
    let root = root.trim_end_matches('\\');
    if equal(root, target.trim_end_matches('\\')) {
        return true;
    }
    // Split on separators before comparing, so UTF-8 byte lengths and Windows case folding cannot disagree.
    let roots = root.split('\\').collect::<Vec<_>>();
    let parts = target.split('\\').collect::<Vec<_>>();
    parts.len() > roots.len() && roots.iter().zip(&parts).all(|(a, b)| equal(a, b))
}

/// Only ordinary absolute paths on fixed local drive letters. Device, UNC, ADS and DOS aliases fail closed.
fn path_parts(value: &str) -> io::Result<Vec<String>> {
    let value = value.replace('/', "\\");
    let bytes = value.as_bytes();
    if bytes.len() < 3 || !bytes[0].is_ascii_alphabetic() || bytes[1] != b':' || bytes[2] != b'\\' {
        return Err(unsupported(
            "仅支持本地盘符绝对路径；UNC/device namespace 不支持",
        ));
    }
    if value.encode_utf16().count() > 32000 {
        return Err(unsupported("路径过长"));
    }
    let mut result = vec![value[..3].to_string()];
    if value.len() > 3 {
        for component in value[3..].split('\\') {
            let device = component
                .split('.')
                .next()
                .unwrap_or("")
                .to_ascii_uppercase();
            if (result.len() == 1
                && [
                    "$MFT", "$MFTMIRR", "$LOGFILE", "$VOLUME", "$ATTRDEF", "$BITMAP", "$BOOT",
                    "$BADCLUS", "$SECURE", "$UPCASE", "$EXTEND",
                ]
                .contains(&device.as_str()))
                || component.is_empty()
                || component == "."
                || component == ".."
                || component.ends_with('.')
                || component.ends_with(' ')
                || component
                    .chars()
                    .any(|c| c.is_control() || "<>:\"|?*".contains(c))
                || ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"].contains(&device.as_str())
                || (device.chars().count() == 4
                    && (device.starts_with("COM") || device.starts_with("LPT"))
                    && matches!(device.chars().last(), Some('0'..='9' | '¹' | '²' | '³')))
            {
                return Err(unsupported(
                    "路径含命名空间、ADS、设备名或不支持的规范化组件",
                ));
            }
            result.push(component.to_string());
        }
    }
    let drive = result[0].encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    if unsafe { GetDriveTypeW(drive.as_ptr()) } != DRIVE_FIXED {
        return Err(unsupported("仅支持固定本地卷；网络盘、可移动卷不支持"));
    }
    Ok(result)
}

fn information(file: &File) -> io::Result<BY_HANDLE_FILE_INFORMATION> {
    let mut info = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(info)
}
fn file_id(file: &File) -> io::Result<FILE_ID_INFO> {
    let mut info: FILE_ID_INFO = unsafe { std::mem::zeroed() };
    if unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileIdInfo,
            (&mut info as *mut FILE_ID_INFO).cast(),
            std::mem::size_of::<FILE_ID_INFO>() as u32,
        )
    } == 0
    {
        return Err(unsupported("卷不提供稳定 FileID；拒绝该次读取"));
    }
    Ok(info)
}
/// A conservative compatibility check, not a metadata lock. Native IDs, never these
/// flags or ordinal-ignore-case strings, establish readable-root membership.
fn require_case_insensitive_directory(file: &File) -> io::Result<()> {
    if information(file)?.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
        return Ok(());
    }
    let mut info: FILE_CASE_SENSITIVE_INFO = unsafe { std::mem::zeroed() };
    if unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileCaseSensitiveInfo,
            (&mut info as *mut FILE_CASE_SENSITIVE_INFO).cast(),
            std::mem::size_of::<FILE_CASE_SENSITIVE_INFO>() as u32,
        )
    } == 0
    {
        return Err(unsupported(&format!(
            "无法确定目录大小写策略；拒绝 ignoreCase 路径比较：{}",
            io::Error::last_os_error()
        )));
    }
    // Reject case-sensitive and any future/unknown nonzero policy flags alike.
    if info.Flags != 0 {
        return Err(unsupported(
            "路径含大小写敏感目录或未知目录策略；不支持 ignoreCase 保护/读取例外比较",
        ));
    }
    Ok(())
}
fn require_case_insensitive_pins(pins: &[File]) -> io::Result<()> {
    for file in pins {
        require_case_insensitive_directory(file)?;
    }
    Ok(())
}
fn final_name(file: &File) -> io::Result<String> {
    let mut buffer = vec![0u16; 32768];
    let count = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            0,
        )
    };
    if count == 0 {
        return Err(io::Error::last_os_error());
    }
    if count as usize >= buffer.len() {
        return Err(unsupported("最终句柄路径过长"));
    }
    let value = String::from_utf16(&buffer[..count as usize])
        .map_err(|_| unsupported("非 Unicode 路径"))?;
    let value = value
        .strip_prefix("\\\\?\\")
        .ok_or_else(|| unsupported("最终 namespace 不支持"))?;
    path_parts(value)?;
    Ok(value.to_string())
}

/// Hold every existing ancestor without FILE_SHARE_DELETE, recording its full native ID.
/// Each component after the drive is opened relative to its held parent, so case flips
/// cannot assemble an ancestry from different absolute-lookup lineages. Reparse points
/// are rejected; this does not promise protection against every volume/ancestor ABA.
fn pin_path(value: &str, allow_missing: bool, pins: &mut Vec<File>) -> io::Result<PinnedPath> {
    let parts = path_parts(value)?;
    let mut canonical = String::new();
    let mut ancestry = Vec::new();
    for (index, part) in parts.iter().enumerate() {
        let opened = if index == 0 {
            OpenOptions::new()
                .access_mode(FILE_READ_ATTRIBUTES)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
                .open(part)
        } else {
            pin_child(
                pins.last()
                    .ok_or_else(|| unsupported("缺少持有的父目录句柄"))?,
                part,
            )
        };
        let file = match opened {
            Ok(file) => file,
            Err(error) if allow_missing && error.kind() == io::ErrorKind::NotFound && index > 0 => {
                for tail in &parts[index..] {
                    if !canonical.ends_with('\\') {
                        canonical.push('\\');
                    }
                    canonical.push_str(tail);
                }
                return Ok(PinnedPath {
                    canonical,
                    ancestry,
                    final_id: None,
                });
            }
            Err(error) => return Err(error),
        };
        let info = information(&file)?;
        if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(unsupported(
                "路径含 reparse point；请使用实际本地 canonical 路径",
            ));
        }
        if index + 1 < parts.len() && info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
            return Err(denied("祖先不是目录"));
        }
        // Includes existing ancestors of missing protected/readable roots, not just the target.
        require_case_insensitive_directory(&file)?;
        canonical = final_name(&file)?;
        ancestry.push(NativeId::from(&file_id(&file)?));
        pins.push(file);
    }
    let final_id = ancestry.last().copied();
    Ok(PinnedPath {
        canonical,
        ancestry,
        final_id,
    })
}
fn size(info: &BY_HANDLE_FILE_INFORMATION) -> u64 {
    ((info.nFileSizeHigh as u64) << 32) | info.nFileSizeLow as u64
}
fn inode(info: &BY_HANDLE_FILE_INFORMATION) -> u64 {
    ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64
}
fn strictly_below(child: &PinnedPath, root: &PinnedPath) -> bool {
    match (child.final_id, root.final_id) {
        (Some(child_id), Some(root_id)) => {
            child_id != root_id && child.ancestry[..child.ancestry.len() - 1].contains(&root_id)
        }
        _ => false,
    }
}
fn allowed(
    target: &str,
    ancestry: &[NativeId],
    protected: &[PinnedPath],
    readable: &[PinnedPath],
) -> bool {
    protected.iter().all(|root| {
        let native_deny = root.final_id.is_some_and(|id| ancestry.contains(&id));
        // Keep lexical protection conservative, including nonexistent protected roots.
        if !native_deny && !within(&root.canonical, target) {
            return true;
        }
        readable.iter().any(|entry| {
            strictly_below(entry, root) && entry.final_id.is_some_and(|id| ancestry.contains(&id))
        })
    })
}

/// Enumerate the held directory handle itself. Entry records contain metadata, never followed paths.
fn directory_entries(
    file: &File,
    request: &Request,
    actual: &str,
    target: &PinnedPath,
    protected: &[PinnedPath],
    readable: &[PinnedPath],
) -> io::Result<Vec<DirectoryEntry>> {
    let limit = request.max_entries.unwrap_or(10000);
    if limit > 10000 {
        return Err(denied("maxEntries 超过 10000"));
    }
    let mut entries = Vec::new();
    let mut scanned = 0usize;
    let mut output_bytes = 2usize;
    let mut first = true;
    // Native records require 8-byte alignment; no unaligned typed references into a byte Vec.
    let mut buffer = vec![0u64; 8192];
    let capacity = buffer.len() * std::mem::size_of::<u64>();
    let header = std::mem::offset_of!(FILE_ID_BOTH_DIR_INFO, FileName);
    loop {
        buffer.fill(0);
        let class = if first {
            FileIdBothDirectoryRestartInfo
        } else {
            FileIdBothDirectoryInfo
        };
        first = false;
        if unsafe {
            GetFileInformationByHandleEx(
                file.as_raw_handle(),
                class,
                buffer.as_mut_ptr().cast(),
                capacity as u32,
            )
        } == 0
        {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(18) {
                break;
            } // ERROR_NO_MORE_FILES
            return Err(error);
        }
        let mut offset = 0usize;
        loop {
            if offset % 8 != 0
                || offset
                    .checked_add(std::mem::size_of::<FILE_ID_BOTH_DIR_INFO>())
                    .is_none_or(|end| end > capacity)
            {
                return Err(unsupported("目录记录边界无效"));
            }
            let record = unsafe {
                &*buffer
                    .as_ptr()
                    .cast::<u8>()
                    .add(offset)
                    .cast::<FILE_ID_BOTH_DIR_INFO>()
            };
            let length = record.FileNameLength as usize;
            let name_start = offset + header;
            if length == 0
                || length % 2 != 0
                || name_start
                    .checked_add(length)
                    .is_none_or(|end| end > capacity)
            {
                return Err(unsupported("目录名称边界无效"));
            }
            let raw = unsafe {
                std::slice::from_raw_parts(
                    buffer.as_ptr().cast::<u8>().add(name_start).cast::<u16>(),
                    length / 2,
                )
            };
            let dot = raw == [46u16] || raw == [46u16, 46u16];
            if !dot {
                scanned += 1;
                if scanned > limit {
                    return Err(denied("目录条目超过 maxEntries"));
                }
            }
            // No lossy replacement characters for unrepresentable Windows names either.
            if let Ok(name) = String::from_utf16(raw) {
                if !dot {
                    if record.FileAttributes
                        & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DEVICE)
                        == 0
                    {
                        if name.is_empty() || name.chars().any(|c| matches!(c, '\\' | '/' | '\0')) {
                            return Err(unsupported("目录条目名称无效"));
                        }
                        let child = format!("{}\\{}", actual.trim_end_matches('\\'), name);
                        // Entries have no pinned full native ID. Only the held parent's
                        // proven ancestry may grant an exception; never reopen the name
                        // or synthesize a full ID from this record's 64-bit FileId.
                        if allowed(&child, &target.ancestry, protected, readable) {
                            let directory = record.FileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0;
                            let size = if directory {
                                0
                            } else {
                                u64::try_from(record.EndOfFile)
                                    .map_err(|_| unsupported("目录条目大小无效"))?
                            };
                            if size > 9007199254740991 {
                                return Err(unsupported("目录条目大小不能无损表示"));
                            }
                            let entry = DirectoryEntry {
                                name,
                                kind: if directory { "directory" } else { "file" },
                                size,
                            };
                            output_bytes += serde_json::to_vec(&entry)
                                .map_err(|_| denied("目录序列化失败"))?
                                .len()
                                + usize::from(!entries.is_empty());
                            if output_bytes > 2 * 1024 * 1024 {
                                return Err(denied("目录输出超过 2 MiB"));
                            }
                            entries.push(entry);
                        }
                    }
                }
            }
            let next = record.NextEntryOffset as usize;
            if next == 0 {
                break;
            }
            if next < header + length
                || next % 8 != 0
                || offset.checked_add(next).is_none_or(|end| end >= capacity)
            {
                return Err(unsupported("目录记录偏移无效"));
            }
            offset += next;
        }
    }
    Ok(entries)
}

/// A regular-user operation; it never initializes PSEC, executes commands or changes an ACL.
pub fn run() -> io::Result<()> {
    let mut input = Vec::new();
    io::stdin().take(1024 * 1024 + 1).read_to_end(&mut input)?;
    if input.len() > 1024 * 1024 {
        return Err(denied("请求过大"));
    }
    let request: Request = serde_json::from_slice(&input).map_err(|_| denied("请求格式无效"))?;
    if request.max_bytes > MAXIMUM {
        return Err(denied("大小上限超过 64 MiB"));
    }
    let mut pins = Vec::new();
    let protected = request
        .protected_roots
        .iter()
        .map(|p| pin_path(p, true, &mut pins))
        .collect::<io::Result<Vec<_>>>()?;
    let readable = request
        .readable_roots
        .iter()
        .map(|p| pin_path(p, true, &mut pins))
        .collect::<io::Result<Vec<_>>>()?;
    require_case_insensitive_pins(&pins)?;
    for root in &readable {
        let invalid_lexical_scope = !protected
            .iter()
            .any(|p| within(&p.canonical, &root.canonical))
            || protected
                .iter()
                .any(|p| within(&root.canonical, &p.canonical));
        let unproven_existing_scope =
            root.final_id.is_some() && !protected.iter().any(|p| strictly_below(root, p));
        let covers_protected_object = protected.iter().any(|p| {
            root.final_id.is_some() && (root.final_id == p.final_id || strictly_below(p, root))
        });
        if invalid_lexical_scope || unproven_existing_scope || covers_protected_object {
            return Err(denied(
                "读取例外必须是私有根下的实际对象且不能覆盖其他私有根；缺失例外不能授予读取",
            ));
        }
    }
    let target = pin_path(&request.canonical_path, false, &mut pins)?;
    require_case_insensitive_pins(&pins)?;
    if !allowed(&target.canonical, &target.ancestry, &protected, &readable) {
        return Err(denied("最终路径位于私有根"));
    }
    let mut options = OpenOptions::new();
    if request.directory {
        options
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
    } else {
        // No write or delete sharing: concurrent writer/unlink/rename is a refusal, not a fallback.
        options
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let mut file = options.open(&target.canonical)?;
    if unsafe { GetFileType(file.as_raw_handle()) } != FILE_TYPE_DISK {
        return Err(unsupported("仅支持普通磁盘文件"));
    }
    let before = information(&file)?;
    let id = file_id(&file)?;
    // The absolute second open is not trusted to resolve to the same case variant.
    // Bind it to the exact full native object reached by the relative, held chain.
    if target.final_id != Some(NativeId::from(&id)) {
        return Err(denied("实际读取句柄与持有的目标完整对象身份不一致"));
    }
    let actual = final_name(&file)?;
    require_case_insensitive_directory(&file)?;
    require_case_insensitive_pins(&pins)?;
    if !equal(&actual, &target.canonical)
        || !allowed(&actual, &target.ancestry, &protected, &readable)
    {
        return Err(denied("实际句柄路径改变或落入私有根"));
    }
    if before.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || (!request.directory
            && (before.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0
                || before.nNumberOfLinks != 1))
        || (request.directory && before.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0)
    {
        return Err(denied("目标类型、reparse 或文件链接数不符合受控读取要求"));
    }
    if let Some(expected) = &request.expected {
        // Node 24.14.0's bundled libuv (src/win/fs.c, fs__stat_assign_statbuf)
        // exposes VolumeSerialNumber.LowPart as st_dev. That cannot identify a wider
        // FILE_ID_INFO volume without truncation. Require the entire native serial to
        // equal the classic DWORD widened to u64; otherwise expected is unsupported.
        if id.VolumeSerialNumber != u64::from(before.dwVolumeSerialNumber)
            || inode(&before) == 0
            || id.FileId.Identifier[8..].iter().any(|value| *value != 0)
            || id.FileId.Identifier[..8] != inode(&before).to_le_bytes()
        {
            return Err(unsupported(
                "该卷完整 VolumeSerialNumber/FileID 不能与 Node dev/ino 无损比较",
            ));
        }
        if expected.dev.parse::<u64>().ok() != Some(before.dwVolumeSerialNumber as u64)
            || expected.ino.parse::<u64>().ok() != Some(inode(&before))
        {
            return Err(denied("授权文件身份已经变化"));
        }
    }
    if request.directory {
        let entries = directory_entries(&file, &request, &actual, &target, &protected, &readable)?;
        let after = information(&file)?;
        let after_id = file_id(&file)?;
        if before.ftLastWriteTime.dwHighDateTime != after.ftLastWriteTime.dwHighDateTime
            || before.ftLastWriteTime.dwLowDateTime != after.ftLastWriteTime.dwLowDateTime
            || id.VolumeSerialNumber != after_id.VolumeSerialNumber
            || id.FileId.Identifier != after_id.FileId.Identifier
            || !equal(&actual, &final_name(&file)?)
        {
            return Err(denied("目录在枚举期间改变"));
        }
        // A flag query is not a metadata lock or an ancestor-ABA proof. Recheck every
        // held policy/exception/target directory before publishing buffered data.
        require_case_insensitive_directory(&file)?;
        require_case_insensitive_pins(&pins)?;
        let output = serde_json::to_vec(&entries).map_err(|_| denied("目录序列化失败"))?;
        if output.len() > 2 * 1024 * 1024 {
            return Err(denied("目录输出超过 2 MiB"));
        }
        io::stdout().lock().write_all(&output)?;
        return Ok(());
    }
    if size(&before) > request.max_bytes {
        return Err(denied("文件超过读取上限"));
    }
    let mut data = Vec::new();
    (&mut file)
        .take(request.max_bytes + 1)
        .read_to_end(&mut data)?;
    let after = information(&file)?;
    let after_id = file_id(&file)?;
    if data.len() as u64 > request.max_bytes {
        return Err(denied("文件超过读取上限"));
    }
    if after.nNumberOfLinks != 1
        || before.dwVolumeSerialNumber != after.dwVolumeSerialNumber
        || inode(&before) != inode(&after)
        || size(&before) != size(&after)
        || before.ftLastWriteTime.dwHighDateTime != after.ftLastWriteTime.dwHighDateTime
        || before.ftLastWriteTime.dwLowDateTime != after.ftLastWriteTime.dwLowDateTime
        || id.VolumeSerialNumber != after_id.VolumeSerialNumber
        || id.FileId.Identifier != after_id.FileId.Identifier
        || !equal(&actual, &final_name(&file)?)
    {
        return Err(denied("文件或句柄身份在读取期间改变"));
    }
    require_case_insensitive_pins(&pins)?;
    // Only emit after all checks. Handles remain pinned until output is complete.
    io::stdout().lock().write_all(&data)?;
    Ok(())
}
