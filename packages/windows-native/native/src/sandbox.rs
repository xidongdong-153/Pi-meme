use crate::process::{Control, Launch, Output, emit, quote};
use mxc_sdk::v1::configs::{ProcessContainerConfig, ProcessContainerFilesystem};
use mxc_sdk::v1::policy::{
    NetworkAction, NetworkEgressPolicy, NetworkIngressPolicy, NetworkPolicy,
};
use mxc_sdk::v1::{self, ContainerRequest, Containment, FilesystemPolicy, UiPolicy};
use serde::Deserialize;
use serde_json::json;
use std::collections::HashSet;
use std::io::{self, BufRead, Read, Write};
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::Duration;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::Storage::FileSystem::*;
use windows_sys::Win32::System::JobObjects::*;
use windows_sys::Win32::System::Threading::GetCurrentProcess;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Policy {
    pub read: Vec<String>,
    pub write: Vec<String>,
    pub deny: Vec<String>,
    pub allow_network: bool,
    pub allow_children: bool,
}

fn within(root: &str, path: &str) -> bool {
    let root = root.trim_end_matches('\\').to_lowercase();
    let path = path.to_lowercase();
    path == root || path.starts_with(&format!("{root}\\"))
}

struct LinkNames(HANDLE);
impl Drop for LinkNames {
    fn drop(&mut self) {
        unsafe {
            FindClose(self.0);
        }
    }
}

fn pin_writable_directories(
    policy: &Policy,
    directory: &Path,
    pinned: &mut HashSet<PathBuf>,
    locks: &mut Vec<std::fs::File>,
) -> io::Result<()> {
    for parent in directory.ancestors() {
        if !policy
            .write
            .iter()
            .any(|root| within(root, &parent.to_string_lossy()))
        {
            break;
        }
        if pinned.insert(parent.to_path_buf()) {
            locks.push(
                std::fs::OpenOptions::new()
                    .access_mode(FILE_LIST_DIRECTORY)
                    .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
                    .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
                    .open(parent)?,
            );
        }
    }
    Ok(())
}

// 已安装依赖整体只读；其他共享硬链接逐个保护，不阻止整个工作区启动。
fn readonly_shared_paths(policy: &Policy) -> io::Result<(Vec<String>, Vec<std::fs::File>)> {
    let mut readonly = Vec::new();
    let mut locks = Vec::new();
    let mut pinned_directories = HashSet::new();
    let mut pending = policy
        .write
        .iter()
        .map(std::path::PathBuf::from)
        .collect::<Vec<_>>();
    while let Some(path) = pending.pop() {
        let text = path.to_string_lossy();
        if policy.deny.iter().any(|root| within(root, &text)) {
            continue;
        }
        let metadata = std::fs::symlink_metadata(&path)?;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            continue;
        }
        if metadata.is_dir() {
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            let in_node_modules = path
                .parent()
                .and_then(Path::file_name)
                .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("node_modules"));
            if policy.deny.is_empty()
                && in_node_modules
                && (name.eq_ignore_ascii_case(".pnpm") || !name.starts_with('.'))
            {
                // 固定祖先目录，防止通过改名移走整个只读子树。
                pin_writable_directories(policy, &path, &mut pinned_directories, &mut locks)?;
                readonly.push(text.into_owned());
                continue;
            }
            for entry in std::fs::read_dir(&path)? {
                pending.push(entry?.path());
            }
            continue;
        }
        let file = std::fs::OpenOptions::new()
            .access_mode(FILE_READ_ATTRIBUTES)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(&path)?;
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
            return Err(io::Error::last_os_error());
        }
        if info.nNumberOfLinks <= 1 {
            continue;
        }
        let name = text.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
        let mut buffer = vec![0u16; 32768];
        let mut length = buffer.len() as u32;
        let find =
            unsafe { FindFirstFileNameW(name.as_ptr(), 0, &mut length, buffer.as_mut_ptr()) };
        if find == windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        let find = LinkNames(find);
        let volume = path
            .ancestors()
            .last()
            .ok_or_else(|| io::Error::other("硬链接卷路径无效"))?;
        let mut shared = false;
        loop {
            let count = buffer
                .iter()
                .position(|value| *value == 0)
                .ok_or_else(|| io::Error::other("硬链接文件名无效"))?;
            let relative = String::from_utf16(&buffer[..count]).map_err(io::Error::other)?;
            let alias = volume
                .join(relative.trim_start_matches('\\'))
                .to_string_lossy()
                .into_owned();
            if policy.deny.iter().any(|root| within(root, &alias)) {
                return Err(io::Error::other(format!(
                    "写入目录存在受保护路径的硬链接：{text}；请移除此链接后重试"
                )));
            }
            if !policy.write.iter().any(|root| within(root, &alias)) {
                shared = true;
            }
            length = buffer.len() as u32;
            if unsafe { FindNextFileNameW(find.0, &mut length, buffer.as_mut_ptr()) } == 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error()
                    == Some(windows_sys::Win32::Foundation::ERROR_HANDLE_EOF as i32)
                {
                    break;
                }
                return Err(error);
            }
        }
        if shared {
            // PSEC 路径规则在父目录改名后会失效；句柄按文件对象禁止写入和删除。
            let handle =
                unsafe { ReOpenFile(file.as_raw_handle(), FILE_READ_DATA, FILE_SHARE_READ, 0) };
            if handle == windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
                return Err(io::Error::other(format!(
                    "无法锁定共享硬链接文件：{text}；请等待其他进程关闭该文件后重试：{}",
                    io::Error::last_os_error()
                )));
            }
            locks.push(unsafe { std::fs::File::from_raw_handle(handle) });
            // 固定可写范围内的祖先目录，避免改名后绕过只读规则修改文件属性。
            pin_writable_directories(
                policy,
                path.parent()
                    .ok_or_else(|| io::Error::other("共享文件缺少父目录"))?,
                &mut pinned_directories,
                &mut locks,
            )?;
            readonly.push(text.into_owned());
        }
    }
    Ok((readonly, locks))
}

fn require_native(request: &ContainerRequest) -> io::Result<serde_json::Value> {
    let result = v1::probe(Some(request)).map_err(io::Error::other)?;
    if result.tier != Some("base-container")
        || result.needs_dacl_augmentation != Some(false)
        || !result.probes.base_container_supports_enumerate_paths
        || !result.probes.base_container_supports_deny_paths
    {
        return Err(io::Error::other(format!(
            "Windows PSEC 沙箱不可用，请安装 Windows 11 24H2（26100.9278）、25H2（26200.9278）或更新的系统更新后重启应用：{}",
            result.error.unwrap_or_else(|| result.warnings.join("；"))
        )));
    }
    Ok(serde_json::to_value(result)?)
}

pub fn probe() -> io::Result<()> {
    let mut request = ContainerRequest::new("cmd.exe /c exit 0");
    request.containment = Containment::ProcessContainer(ProcessContainerConfig::default());
    let result = require_native(&request)?;
    serde_json::to_writer(io::stdout(), &result)?;
    Ok(())
}

// 此 Job 在启动不可信代码前约束原生程序及其后代；原生程序与插件各占一个名额。
fn own_process_tree(allow_children: bool) -> io::Result<HANDLE> {
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return Err(io::Error::last_os_error());
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if !allow_children {
            limits.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
            limits.BasicLimitInformation.ActiveProcessLimit = 2;
        }
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of_val(&limits) as u32,
        ) == 0
            || AssignProcessToJobObject(job, GetCurrentProcess()) == 0
        {
            let error = io::Error::last_os_error();
            CloseHandle(job);
            return Err(error);
        }
        // Job 包含当前进程，句柄由操作系统在进程退出时关闭。
        Ok(job)
    }
}

fn wait_for_children(job: HANDLE) -> io::Result<()> {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe {
            QueryInformationJobObject(
                job,
                JobObjectBasicAccountingInformation,
                (&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                std::mem::size_of_val(&info) as u32,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        if info.ActiveProcesses == 1 {
            return Ok(());
        }
        if std::time::Instant::now() >= deadline {
            return Err(io::Error::other("PSEC 后代进程尚未完全退出"));
        }
        thread::sleep(Duration::from_millis(10));
    }
}

fn drain(
    mut input: Box<dyn Read + Send>,
    stream: &'static str,
    output: Output,
) -> thread::JoinHandle<io::Result<()>> {
    thread::spawn(move || {
        let mut bytes = [0; 8192];
        loop {
            let count = match input.read(&mut bytes) {
                Ok(0) => return Ok(()),
                Ok(count) => count,
                Err(error) if error.kind() == io::ErrorKind::BrokenPipe => return Ok(()),
                Err(error) => return Err(error),
            };
            emit(
                &output,
                json!({"type":"data", "stream":stream, "data":&bytes[..count]}),
            )?;
        }
    })
}

pub fn run(mut launch: Launch) -> io::Result<()> {
    let policy = launch
        .sandbox
        .take()
        .ok_or_else(|| io::Error::other("缺少 PSEC 策略"))?;
    let runtime = std::env::current_exe()?;
    if policy
        .write
        .iter()
        .any(|root| within(root, &runtime.to_string_lossy()))
    {
        return Err(io::Error::other(
            "Windows 受限写入目录不能包含应用原生运行时，请选择独立项目目录",
        ));
    }
    if policy
        .deny
        .iter()
        .any(|protected| policy.write.iter().any(|root| within(root, protected)))
    {
        return Err(io::Error::other(
            "Windows 受限写入目录不能包含受保护数据目录",
        ));
    }
    let (shared_paths, _shared_locks) = readonly_shared_paths(&policy)?;
    let mut request = ContainerRequest::new(
        std::iter::once(launch.executable.as_str())
            .chain(launch.args.iter().map(String::as_str))
            .map(quote)
            .collect::<Vec<_>>()
            .join(" "),
    );
    let mut metadata = ProcessContainerFilesystem::default();
    for target in policy.read.iter().chain(&policy.write).chain(&policy.deny) {
        let path = Path::new(target);
        if !path.is_absolute() || target.starts_with("\\\\") || target.contains('\0') {
            return Err(io::Error::other("PSEC 只接受本机绝对路径"));
        }
        metadata.enumerate_paths.extend(
            path.ancestors()
                .skip(1)
                .map(|parent| parent.to_string_lossy().into_owned()),
        );
    }
    // 不重复给读写根设置 enumerate-only，否则会覆盖该根的内容访问规则。
    let roots: HashSet<String> = policy
        .read
        .iter()
        .chain(&policy.write)
        .map(|root| root.to_lowercase())
        .collect();
    let denied: HashSet<String> = policy.deny.iter().map(|root| root.to_lowercase()).collect();
    metadata.enumerate_paths.retain(|parent| {
        if denied.contains(&parent.to_lowercase()) {
            return false;
        }
        for path in Path::new(parent).ancestors() {
            let path = path.to_string_lossy().to_lowercase();
            if denied.contains(&path) {
                return true;
            }
            if roots.contains(&path) {
                return false;
            }
        }
        true
    });
    metadata.enumerate_paths.sort();
    metadata.enumerate_paths.dedup();
    let mut config = ProcessContainerConfig::default();
    config.filesystem = Some(metadata);
    request.containment = Containment::ProcessContainer(config);
    let readonly_paths = policy
        .read
        .into_iter()
        .filter(|root| {
            !policy
                .write
                .iter()
                .any(|write| root.eq_ignore_ascii_case(write))
        })
        .chain(shared_paths)
        .collect();
    request.filesystem = Some(FilesystemPolicy {
        readonly_paths,
        readwrite_paths: policy.write,
        denied_paths: policy.deny,
        clear_policy_on_exit: Some(true),
    });
    request.working_directory = Some(launch.cwd);
    request.ui = Some(UiPolicy {
        disable: false,
        ..Default::default()
    });
    request.network = Some(NetworkPolicy {
        egress: Some(NetworkEgressPolicy {
            default: Some(if policy.allow_network {
                NetworkAction::Allow
            } else {
                NetworkAction::Deny
            }),
            ..Default::default()
        }),
        ingress: Some(NetworkIngressPolicy {
            default: Some(NetworkAction::Deny),
            host_loopback: Some(NetworkAction::Deny),
        }),
        runtime_config: None,
    });
    request.environment = Some(launch.env.into_iter().collect());
    request.inherit_default_environment = Some(false);
    require_native(&request)?;
    let job = own_process_tree(policy.allow_children)?;
    let mut process = v1::spawn(request, Default::default()).map_err(io::Error::other)?;
    let output = Arc::new(Mutex::new(io::stdout()));
    let mut stdin = process
        .take_stdin()
        .ok_or_else(|| io::Error::other("缺少 PSEC 标准输入"))?;
    let stdout = drain(
        process
            .take_stdout()
            .ok_or_else(|| io::Error::other("缺少 PSEC 标准输出"))?,
        "stdout",
        output.clone(),
    );
    let stderr = drain(
        process
            .take_stderr()
            .ok_or_else(|| io::Error::other("缺少 PSEC 错误输出"))?,
        "stderr",
        output.clone(),
    );
    emit(&output, json!({"type":"spawned", "pid":process.id()}))?;
    let (input, chunks) = mpsc::sync_channel::<Option<Vec<u8>>>(128);
    let input_output = output.clone();
    thread::spawn(move || {
        for chunk in chunks {
            let Some(bytes) = chunk else {
                return;
            };
            if stdin.write_all(&bytes).and_then(|_| stdin.flush()).is_err() {
                let _ = emit(&input_output, json!({"type":"input-error"}));
                return;
            }
            if emit(&input_output, json!({"type":"input-ack"})).is_err() {
                return;
            }
        }
    });
    let (stop, stopping) = mpsc::channel();
    thread::spawn(move || {
        for line in io::stdin().lock().lines() {
            let Ok(line) = line else {
                break;
            };
            if line.len() > 1024 * 1024 {
                break;
            }
            match serde_json::from_str::<Control>(&line) {
                Ok(Control::Input { data }) if data.len() <= 65536 => {
                    if input.try_send(Some(data)).is_err() {
                        break;
                    }
                }
                Ok(Control::End) => {
                    let _ = input.try_send(None);
                }
                _ => break,
            }
        }
        let _ = stop.send(());
    });
    loop {
        if process.try_wait()?.is_some() {
            break;
        }
        if stopping.recv_timeout(Duration::from_millis(10)) != Err(mpsc::RecvTimeoutError::Timeout)
        {
            process.kill()?;
            break;
        }
    }
    let code = match process.wait()? {
        v1::WaitResult::Exited(code) => code,
        v1::WaitResult::TimedOut => return Err(io::Error::other("PSEC 进程等待超时")),
    };
    wait_for_children(job)?;
    for reader in [stdout, stderr] {
        reader
            .join()
            .map_err(|_| io::Error::other("PSEC 输出读取失败"))??;
    }
    emit(&output, json!({"type":"exit", "exitCode":code}))
}
