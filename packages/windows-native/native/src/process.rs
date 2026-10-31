use serde::Deserialize;
use serde_json::json;
use std::collections::BTreeMap;
use std::ffi::c_void;
use std::io::{self, BufRead, Write};
use std::mem::{size_of, zeroed};
use std::ptr::{null, null_mut};
use std::sync::{Arc, Mutex};
use std::thread;
use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::Storage::FileSystem::*;
use windows_sys::Win32::System::Console::*;
use windows_sys::Win32::System::JobObjects::*;
use windows_sys::Win32::System::Pipes::*;
use windows_sys::Win32::System::Threading::*;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Launch {
    pub executable: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub env: BTreeMap<String, String>,
    pub sandbox: Option<crate::sandbox::Policy>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Control {
    Input { data: Vec<u8> },
    End,
    Stop,
    Kill,
}

struct Handle(HANDLE);
impl Handle {
    fn raw(&self) -> HANDLE {
        self.0
    }
}
unsafe impl Send for Handle {}
unsafe impl Sync for Handle {}
impl Drop for Handle {
    fn drop(&mut self) {
        if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
            unsafe { CloseHandle(self.0) };
        }
    }
}

fn check(value: i32) -> io::Result<()> {
    if value == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn wide(value: &str) -> io::Result<Vec<u16>> {
    if value.contains('\0') {
        return Err(io::Error::other("启动参数不能包含空字符"));
    }
    Ok(value.encode_utf16().chain(Some(0)).collect())
}

// 按 Windows CRT 的规则引用每个独立参数，不将参数交给 cmd 解释。
pub(crate) fn quote(value: &str) -> String {
    let mut result = String::from("\"");
    let mut slashes = 0;
    for character in value.chars() {
        if character == '\\' {
            slashes += 1;
            continue;
        }
        if character == '"' {
            result.extend(std::iter::repeat_n('\\', slashes * 2 + 1));
        } else {
            result.extend(std::iter::repeat_n('\\', slashes));
        }
        slashes = 0;
        result.push(character);
    }
    result.extend(std::iter::repeat_n('\\', slashes * 2));
    result.push('"');
    result
}

fn pipe(
    descriptor: windows_sys::Win32::Security::PSECURITY_DESCRIPTOR,
) -> io::Result<(Handle, Handle)> {
    let mut read = null_mut();
    let mut write = null_mut();
    let security = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor,
        bInheritHandle: 1,
    };
    unsafe {
        check(CreatePipe(&mut read, &mut write, &security, 0))?;
    }
    Ok((Handle(read), Handle(write)))
}

pub(crate) type Output = Arc<Mutex<io::Stdout>>;
pub(crate) fn emit(output: &Output, value: serde_json::Value) -> io::Result<()> {
    let mut writer = output
        .lock()
        .map_err(|_| io::Error::other("原生进程输出已关闭"))?;
    serde_json::to_writer(&mut *writer, &value)?;
    writer.write_all(b"\n")?;
    writer.flush()
}

fn drain(
    handle: Handle,
    stream: &'static str,
    output: Output,
) -> thread::JoinHandle<io::Result<()>> {
    thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        loop {
            let mut received = 0;
            let result = unsafe {
                ReadFile(
                    handle.raw(),
                    buffer.as_mut_ptr(),
                    buffer.len() as u32,
                    &mut received,
                    null_mut(),
                )
            };
            if result == 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() == Some(ERROR_BROKEN_PIPE as i32) {
                    return Ok(());
                }
                return Err(error);
            }
            if received == 0 {
                return Ok(());
            }
            emit(
                &output,
                json!({"type":"data", "stream":stream, "data":&buffer[..received as usize]}),
            )?;
        }
    })
}

struct Attributes {
    memory: Vec<usize>,
}
impl Attributes {
    fn new(count: u32) -> io::Result<Self> {
        let mut bytes = 0;
        unsafe {
            InitializeProcThreadAttributeList(null_mut(), count, 0, &mut bytes);
        }
        let mut result = Self {
            memory: vec![0; bytes.div_ceil(size_of::<usize>())],
        };
        unsafe {
            check(InitializeProcThreadAttributeList(
                result.pointer(),
                count,
                0,
                &mut bytes,
            ))?;
        }
        Ok(result)
    }
    fn pointer(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.memory.as_mut_ptr().cast()
    }
}
impl Drop for Attributes {
    fn drop(&mut self) {
        unsafe { DeleteProcThreadAttributeList(self.pointer()) };
    }
}

pub fn run() -> io::Result<()> {
    let input = io::stdin();
    let mut lines = input.lock().lines();
    let first = lines
        .next()
        .ok_or_else(|| io::Error::other("缺少原生进程启动参数"))??;
    if first.len() > 1024 * 1024 {
        return Err(io::Error::other("原生进程启动参数超过限制"));
    }
    let launch: Launch = serde_json::from_str(&first)?;
    if launch.sandbox.is_some() {
        drop(lines);
        return crate::sandbox::run(launch);
    }
    let application = wide(&launch.executable)?;
    let mut command = wide(
        &std::iter::once(launch.executable.as_str())
            .chain(launch.args.iter().map(String::as_str))
            .map(quote)
            .collect::<Vec<_>>()
            .join(" "),
    )?;
    let directory = wide(&launch.cwd)?;
    let mut environment = Vec::<u16>::new();
    let mut entries = launch.env.into_iter().collect::<Vec<_>>();
    entries.sort_by_key(|(key, _)| key.to_uppercase());
    for (key, value) in entries {
        if key.contains('=') {
            return Err(io::Error::other("环境变量名称无效"));
        }
        environment.extend(wide(&format!("{key}={value}"))?);
    }
    environment.push(0);
    if environment.len() == 1 {
        environment.push(0);
    }
    let job = Arc::new(Handle(unsafe { CreateJobObjectW(null(), null()) }));
    if job.0.is_null() {
        return Err(io::Error::last_os_error());
    }
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    unsafe {
        check(SetInformationJobObject(
            job.0,
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ))?;
    }
    let descriptor = null_mut();
    let (child_input, parent_input) = pipe(descriptor)?;
    let (parent_output, child_output) = pipe(descriptor)?;
    let (parent_error, child_error) = pipe(descriptor)?;
    for handle in [&parent_input, &parent_output, &parent_error] {
        unsafe {
            check(SetHandleInformation(handle.0, HANDLE_FLAG_INHERIT, 0))?;
        }
    }
    let mut handles = [child_input.0, child_output.0, child_error.0];
    let mut jobs = [job.0];
    let mut attributes = Attributes::new(2)?;
    unsafe {
        check(UpdateProcThreadAttribute(
            attributes.pointer(),
            0,
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
            handles.as_mut_ptr().cast(),
            size_of_val(&handles),
            null_mut(),
            null(),
        ))?;
        check(UpdateProcThreadAttribute(
            attributes.pointer(),
            0,
            PROC_THREAD_ATTRIBUTE_JOB_LIST as usize,
            jobs.as_mut_ptr().cast(),
            size_of_val(&jobs),
            null_mut(),
            null(),
        ))?;
    }
    let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
    startup.StartupInfo.hStdInput = child_input.0;
    startup.StartupInfo.hStdOutput = child_output.0;
    startup.StartupInfo.hStdError = child_error.0;
    startup.lpAttributeList = attributes.pointer();
    let mut process: PROCESS_INFORMATION = unsafe { zeroed() };
    unsafe {
        check(CreateProcessW(
            application.as_ptr(),
            command.as_mut_ptr(),
            null(),
            null(),
            1,
            CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT | CREATE_NEW_CONSOLE,
            environment.as_ptr().cast::<c_void>(),
            directory.as_ptr(),
            &startup.StartupInfo,
            &mut process,
        ))?;
    }
    let process_handle = Handle(process.hProcess);
    let _thread_handle = Handle(process.hThread);
    drop(child_input);
    drop(child_output);
    drop(child_error);
    let output = Arc::new(Mutex::new(io::stdout()));
    emit(
        &output,
        json!({"type":"spawned", "pid":process.dwProcessId}),
    )?;
    let stdout = drain(parent_output, "stdout", output.clone());
    let stderr = drain(parent_error, "stderr", output.clone());
    let control_job = job.clone();
    let child_pid = process.dwProcessId;
    // stdin 断开表示上层已退出，必须立即清理整个 Job。
    drop(lines);
    let (write_input, input_chunks) = std::sync::mpsc::sync_channel::<Option<Vec<u8>>>(128);
    let input_output = output.clone();
    thread::spawn(move || {
        for chunk in input_chunks {
            let Some(data) = chunk else {
                return;
            };
            let mut offset = 0;
            while offset < data.len() {
                let mut written = 0;
                if unsafe {
                    WriteFile(
                        parent_input.raw(),
                        data[offset..].as_ptr(),
                        (data.len() - offset) as u32,
                        &mut written,
                        null_mut(),
                    )
                } == 0
                    || written == 0
                {
                    let _ = emit(&input_output, json!({"type":"input-error"}));
                    return;
                }
                offset += written as usize;
            }
            if emit(&input_output, json!({"type":"input-ack"})).is_err() {
                return;
            }
        }
    });
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
                    if write_input.try_send(Some(data)).is_err() {
                        break;
                    }
                }
                Ok(Control::End) => {
                    let _ = write_input.try_send(None);
                }
                Ok(Control::Stop) => {
                    if unsafe { AttachConsole(child_pid) } != 0 {
                        unsafe {
                            SetConsoleCtrlHandler(Some(ignore_control), 1);
                            GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, 0);
                        }
                        thread::sleep(std::time::Duration::from_secs(3));
                        unsafe {
                            FreeConsole();
                        }
                    }
                    unsafe { TerminateJobObject(control_job.0, 1) };
                }
                Ok(Control::Kill) => {
                    unsafe { TerminateJobObject(control_job.0, 1) };
                }
                _ => break,
            }
        }
        unsafe { TerminateJobObject(control_job.0, 1) };
    });
    unsafe {
        WaitForSingleObject(process_handle.0, INFINITE);
    }
    let mut code = 1;
    unsafe {
        check(GetExitCodeProcess(process_handle.0, &mut code))?;
        check(TerminateJobObject(job.0, code))?;
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { zeroed() };
        unsafe {
            check(QueryInformationJobObject(
                job.0,
                JobObjectBasicAccountingInformation,
                (&mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                null_mut(),
            ))?;
        }
        if accounting.ActiveProcesses == 0 {
            break;
        }
        if std::time::Instant::now() >= deadline {
            return Err(io::Error::other("Windows 进程树未能退出"));
        }
        thread::sleep(std::time::Duration::from_millis(10));
    }
    for reader in [stdout, stderr] {
        reader
            .join()
            .map_err(|_| io::Error::other("原生进程输出读取失败"))??;
    }
    emit(&output, json!({"type":"exit", "exitCode":code}))
}

unsafe extern "system" fn ignore_control(_: u32) -> i32 {
    1
}

#[cfg(test)]
mod tests {
    use super::quote;
    #[test]
    fn windows_arguments() {
        assert_eq!(quote(""), "\"\"");
        assert_eq!(quote("中文 a&b"), "\"中文 a&b\"");
        assert_eq!(quote("C:\\a b\\"), "\"C:\\a b\\\\\"");
        assert_eq!(quote("a\"b"), "\"a\\\"b\"");
    }
}
