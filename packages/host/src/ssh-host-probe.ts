import { defaultHostPort } from '@pi-meme/contracts/host-runtime'
import { SshError } from './ssh-tunnels'

const probeErrors: Record<string, string> = {
  'host-probe-python': '远端缺少 Python 3，无法只读检查已有 Host，请先安装 Python 3',
  'host-probe-response': '远端 Host 探测没有返回有效结果，请检查 SSH 登录环境',
  'host-probe-runtime': '远端 Host 运行目录或运行信息无效，请检查文件权限和内容',
  'host-probe-http': '远端候选端口未返回有效 Host 状态，请检查端口占用和服务状态',
  'host-probe-identity': '远端 Host 与固定数据目录身份不匹配，请检查原 Host',
  'host-probe-credentials': '远端 Host 凭据无效，请检查凭据文件权限和访问令牌',
  'host-probe-lock': '无法检查远端 Host 数据锁，请检查目录权限和文件类型',
  'host-probe-running': '远端 Host 可能仍在运行，但无法从候选端口发现，请检查监听端口或稍后重试',
}

export function parseSshHostProbe(output: string): { port: number; hostId: string; token: string } | null {
  let value: unknown
  try {
    if (Buffer.byteLength(output) > 64 * 1024) throw new Error('远端 Host 探测响应超过大小限制')
    value = JSON.parse(output) as unknown
  } catch {
    throw new SshError('host-probe-response', probeErrors['host-probe-response'])
  }
  if (value && typeof value === 'object' && 'status' in value) {
    if (value.status === 'absent' && Object.keys(value).length === 1) return null
    if (value.status === 'error' && 'code' in value && typeof value.code === 'string') {
      const code = Object.hasOwn(probeErrors, value.code) ? value.code : 'host-probe-response'
      throw new SshError(code, probeErrors[code])
    }
    if (
      value.status === 'found' &&
      'port' in value &&
      typeof value.port === 'number' &&
      Number.isInteger(value.port) &&
      value.port > 0 &&
      value.port <= 65535 &&
      'hostId' in value &&
      typeof value.hostId === 'string' &&
      value.hostId.length > 0 &&
      value.hostId.length <= 4096 &&
      'token' in value &&
      typeof value.token === 'string' &&
      value.token.trim().length > 0 &&
      value.token.length <= 4096
    )
      return { port: value.port, hostId: value.hostId, token: value.token }
  }
  throw new SshError('host-probe-response', probeErrors['host-probe-response'])
}

// 通过 python3 -I - 的标准输入执行；只读取文件和 loopback 状态，不执行登录或修改远端。
export const sshHostProbeScript = String.raw`
import errno
import http.client
import json
import os
import stat
import time

DEFAULT_PORT = ${defaultHostPort}
LIMIT = 65536

class ProbeError(Exception):
    def __init__(self, code):
        self.code = code

def fail(code):
    raise ProbeError(code)

def text(value):
    return isinstance(value, str) and 0 < len(value) <= 4096

def integer(value, minimum, maximum):
    return type(value) is int and minimum <= value <= maximum

def read_file(file, code, limit, mode=None):
    try:
        before = os.lstat(file)
        if not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid():
            fail(code)
        flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
        with os.fdopen(os.open(file, flags), 'rb') as stream:
            info = os.fstat(stream.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                    or (before.st_dev, before.st_ino) != (info.st_dev, info.st_ino)
                    or (mode is not None and stat.S_IMODE(info.st_mode) != mode)
                    or info.st_size > limit):
                fail(code)
            body = stream.read(limit)
            if len(body) >= limit:
                fail(code)
            return body.decode('utf-8')
    except ProbeError:
        raise
    except Exception:
        fail(code)

def read_runtime(home):
    directory = os.path.join(home, '.local/state/pi-meme/ssh-host')
    try:
        info = os.lstat(directory)
    except FileNotFoundError:
        return None
    except Exception:
        fail('host-probe-runtime')
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
            or stat.S_IMODE(info.st_mode) != 0o700):
        fail('host-probe-runtime')
    file = os.path.join(directory, 'runtime.json')
    try:
        os.lstat(file)
    except FileNotFoundError:
        return None
    except Exception:
        fail('host-probe-runtime')
    try:
        value = json.loads(read_file(file, 'host-probe-runtime', 4096, 0o600))
        if (not isinstance(value, dict) or type(value.get('protocolVersion')) is not int
                or value.get('protocolVersion') != 1
                or not integer(value.get('port'), 1, 65535)
                or not integer(value.get('pid'), 1, 2 ** 53 - 1)
                or not text(value.get('hostId')) or not text(value.get('instanceId'))
                or 'token' in value):
            fail('host-probe-runtime')
        return value
    except ProbeError:
        raise
    except Exception:
        fail('host-probe-runtime')

def status_at(port):
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=2)
    try:
        # http.client 不使用环境代理，也不会跟随重定向。
        connection.connect()
        transport = connection.sock
        deadline = time.monotonic() + 2
        connection.request('GET', '/api/status', headers={'Connection': 'close'})
        response = connection.getresponse()
        if response.status != 200:
            fail('host-probe-http')
        chunks = []
        size = 0
        while not response.isclosed():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                fail('host-probe-http')
            transport.settimeout(remaining)
            chunk = response.read1(LIMIT - size)
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
            if size >= LIMIT:
                fail('host-probe-http')
        value = json.loads(b''.join(chunks).decode('utf-8'))
        if value is None:
            fail('host-probe-http')
        return value
    except ConnectionRefusedError:
        return None
    except OSError as cause:
        if cause.errno == errno.ECONNREFUSED:
            return None
        fail('host-probe-http')
    except ProbeError:
        raise
    except Exception:
        fail('host-probe-http')
    finally:
        connection.close()

def verify(value, descriptor, root):
    try:
        if (not isinstance(value, dict) or value.get('product') != 'pi-meme'
                or type(value.get('runtimeProtocolVersion')) is not int
                or value.get('runtimeProtocolVersion') != 1
                or not text(value.get('hostId')) or not text(value.get('instanceId'))
                or value.get('owner') not in ('server', 'desktop')
                or not isinstance(value.get('dataRoot'), str)
                or not os.path.isabs(value['dataRoot'])
                or value['dataRoot'] != os.path.realpath(root)):
            fail('host-probe-identity')
        if descriptor is not None and (value['hostId'] != descriptor['hostId']
                or value['instanceId'] != descriptor['instanceId']):
            fail('host-probe-identity')
        if read_file(os.path.join(root, 'host-id'), 'host-probe-identity', 4096).strip() != value['hostId']:
            fail('host-probe-identity')
    except ProbeError:
        raise
    except Exception:
        fail('host-probe-identity')

def credentials(root):
    try:
        value = json.loads(read_file(os.path.join(root, 'credentials/auth.json'),
                                     'host-probe-credentials', 1024 * 1024, 0o600))
        token = value.get('host:token') if isinstance(value, dict) else None
        if not text(token) or not token.strip():
            fail('host-probe-credentials')
        return token
    except ProbeError:
        raise
    except Exception:
        fail('host-probe-credentials')

def check_lock(root):
    try:
        info = os.lstat(os.path.join(root, 'host.lock'))
    except FileNotFoundError:
        return
    except Exception:
        fail('host-probe-lock')
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        fail('host-probe-lock')
    if time.time() - info.st_mtime <= 30:
        fail('host-probe-running')

def probe():
    home = os.path.expanduser('~')
    root = os.path.join(home, '.pi-meme')
    descriptor = read_runtime(home)
    ports = list(dict.fromkeys(([descriptor['port']] if descriptor else []) + [DEFAULT_PORT]))
    for port in ports:
        value = status_at(port)
        if value is None:
            continue
        verify(value, descriptor if descriptor and port == descriptor['port'] else None, root)
        token = credentials(root)
        return {'status': 'found', 'port': port, 'hostId': value['hostId'], 'token': token}
    check_lock(root)
    return {'status': 'absent'}

try:
    result = probe()
except ProbeError as cause:
    result = {'status': 'error', 'code': cause.code}
except Exception:
    result = {'status': 'error', 'code': 'host-probe-response'}
print(json.dumps(result, separators=(',', ':')))
`
