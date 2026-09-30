"""读取服务器基线，并把不含密钥的运行清单写入备份目录。"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import socket
from pathlib import Path, PurePosixPath
from typing import Any


BACKUP_ROOT = PurePosixPath("/root/backups/ai-customer-service")
BACKUP_DIR = BACKUP_ROOT / "20260810-before-v2"
FRONTEND_DIR = "/root/apps/linglongzi-agent-chat-ui"
AGENT_DIR = "/root/apps/linglongzi-new-langgraph-templete-python"
REQUIRED_PORTS = {22, 2024, 3000, 5432}
BASELINE_FILE = Path(__file__).resolve().parent / "baselines" / "server-before-v2.json"



def _validated_fingerprint_format(fingerprint: str) -> str:
    """确认指纹使用 OpenSSH SHA256 格式且确实是 32 字节摘要。"""
    if not isinstance(fingerprint, str) or not fingerprint.startswith("SHA256:"):
        raise ValueError("host key 指纹格式无效")
    payload = fingerprint.removeprefix("SHA256:")
    try:
        digest = base64.b64decode(payload + "=", validate=True)
    except (ValueError, TypeError):
        raise ValueError("host key 指纹格式无效") from None
    if len(digest) != 32:
        raise ValueError("host key 指纹格式无效")
    return fingerprint


def validate_approved_fingerprint(
    candidate: str,
    baseline_path: str | os.PathLike[str] = BASELINE_FILE,
) -> str:
    """只接受已写入基线文件的精确 host key 指纹。"""
    path = Path(baseline_path)
    if not path.is_file():
        raise RuntimeError("缺少批准的 host key 基线；请先完成首次 bootstrap 审核")
    data = json.loads(path.read_text(encoding="utf-8"))
    approved = _validated_fingerprint_format(data.get("hostKeySha256"))
    candidate = _validated_fingerprint_format(candidate)
    if not hmac.compare_digest(candidate, approved):
        raise ValueError("调用者提供的 host key 指纹与批准基线不一致")
    return approved


def initialize_host_key_baseline(
    approved_fingerprint: str,
    baseline_path: str | os.PathLike[str] = BASELINE_FILE,
) -> Path:
    """首次部署时独占记录人工批准指纹；已存在的基线绝不替换。"""
    approved = _validated_fingerprint_format(approved_fingerprint)
    path = Path(baseline_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8", newline="\n") as handle:
        json.dump({"hostKeySha256": approved}, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    return path

def _decode(stream: Any) -> str:
    """把 Paramiko 的字节输出统一变成文本。"""
    data = stream.read()
    return data.decode("utf-8", errors="replace") if isinstance(data, bytes) else str(data)


def run_remote(client: Any, command: str) -> str:
    """执行一条远程命令，非零退出时只报告安全的错误摘要。"""
    _stdin, stdout, stderr = client.exec_command(command)
    output = _decode(stdout)
    error = _decode(stderr)
    status = stdout.channel.recv_exit_status()
    if status != 0:
        # 远程错误可能夹带环境内容，因此限制长度并清理换行。
        safe_error = " ".join(error.splitlines())[:400]
        raise RuntimeError(f"远程命令失败（退出码 {status}）：{safe_error}")
    return output


def validate_backup_dir(remote_dir: str) -> str:
    """只允许本任务唯一的时间戳备份目录。"""
    path = PurePosixPath(remote_dir)
    if path != BACKUP_DIR or path.parent != BACKUP_ROOT:
        raise ValueError("备份目录不是本任务批准的精确目录")
    return str(path)


def validate_inventory(data: dict) -> dict:
    """确认旧服务仍与人工审核过的基线完全一致。"""
    if not REQUIRED_PORTS.issubset(set(data.get("listeners", []))):
        raise ValueError("旧服务端口与已审核基线不一致")
    if data.get("frontend") != {"head": "78dbb73", "dirty": False}:
        raise ValueError("前端仓库基线已变化")
    if data.get("agent") != {"head": "a182ca0", "dirty": False}:
        raise ValueError("Agent 仓库基线已变化")
    if data.get("database") != "linglongzivectordb":
        raise ValueError("数据库基线已变化")
    return data


def collect_inventory(client: Any) -> dict:
    """只读收集端口、旧仓库提交和旧数据库名称。"""
    listeners_text = run_remote(
        client,
        "ss -lntH | awk '{print $4}' | sed -n 's/.*:\\([0-9][0-9]*\\)$/\\1/p' | sort -nu",
    )
    listeners = [int(value) for value in listeners_text.split() if value.isdigit()]

    def repository(path: str) -> dict:
        # git status 只用于判断是否干净，不把文件内容带回本地。
        output = run_remote(
            client,
            f"git -C {path} rev-parse --short=7 HEAD; "
            f"if test -z \"$(git -C {path} status --porcelain)\"; then echo clean; else echo dirty; fi",
        ).splitlines()
        if len(output) != 2:
            raise ValueError(f"无法解析仓库清单：{path}")
        return {"head": output[0].strip(), "dirty": output[1].strip() != "clean"}

    database = run_remote(
        client,
        "sudo -u postgres psql -d postgres -Atqc \"select datname from pg_database where datname='linglongzivectordb'\"",
    ).strip()
    return validate_inventory(
        {
            "listeners": listeners,
            "frontend": repository(FRONTEND_DIR),
            "agent": repository(AGENT_DIR),
            "database": database,
        }
    )


def capture_artifacts(client: Any, remote_dir: str) -> dict[str, str]:
    """通过 SFTP 写入三份不含环境变量值的运行清单。"""
    remote_dir = validate_backup_dir(remote_dir)
    artifacts = {
        "pm2-processes.txt": run_remote(
            client, "PATH=/root/.nvm/versions/node/v24.18.0/bin:$PATH /root/.nvm/versions/node/v24.18.0/lib/node_modules/pm2/bin/pm2 ls --no-color"
        ),
        "systemd-services.txt": run_remote(
            client, "systemctl list-units --type=service --all --no-pager --no-legend"
        ),
        "listeners.txt": run_remote(client, "ss -lntpH"),
    }
    sftp = client.open_sftp()
    try:
        for name, content in artifacts.items():
            target = f"{remote_dir}/{name}"
            with sftp.open(target, "wx") as remote_file:
                remote_file.write(content.encode("utf-8"))
            sftp.chmod(target, 0o600)
    finally:
        sftp.close()
    return {name: hashlib.sha256(content.encode("utf-8")).hexdigest() for name, content in artifacts.items()}


def read_account_file(path: str | os.PathLike[str]) -> tuple[str, str, str]:
    """读取三行式 host、用户名、密码文件，不记录其内容。"""
    raw_lines = Path(path).read_text(encoding="utf-8-sig").splitlines()
    if len(raw_lines) != 3:
        raise ValueError("服务器账号文件必须恰好包含 host、用户名和密码三行")
    lines = []
    for raw_line in raw_lines:
        value = raw_line.split("：", 1)[-1] if "：" in raw_line else raw_line.split(":", 1)[-1]
        lines.append(value.strip())
    if any(not value for value in lines):
        raise ValueError("服务器账号文件包含空值")
    return lines[0], lines[1], lines[2]


def _proxy_socket(host: str, port: int = 22):
    """经固定 Clash SOCKS5 代理连接服务器。"""
    import socks

    sock = socks.socksocket(socket.AF_INET, socket.SOCK_STREAM)
    sock.set_proxy(socks.SOCKS5, "127.0.0.1", 7897)
    sock.settimeout(20)
    sock.connect((host, port))
    return sock


def host_key_sha256(key: Any) -> str:
    """使用 OpenSSH 的 SHA256:base64 形式计算主机指纹。"""
    digest = hashlib.sha256(key.asbytes()).digest()
    return "SHA256:" + base64.b64encode(digest).decode("ascii").rstrip("=")


def probe_host_key(host: str, port: int = 22) -> str:
    """首次只读取主机指纹；调用方必须再用该值建立受校验连接。"""
    import paramiko

    sock = _proxy_socket(host, port)
    transport = paramiko.Transport(sock)
    try:
        transport.start_client(timeout=20)
        return host_key_sha256(transport.get_remote_server_key())
    finally:
        transport.close()


class _PinnedSHA256Policy:
    """仅接受调用方明确给出的 SHA-256 主机指纹。"""

    def __init__(self, expected: str):
        self.expected = expected

    def missing_host_key(self, client: Any, hostname: str, key: Any) -> None:
        actual = host_key_sha256(key)
        if not hmac.compare_digest(actual, self.expected):
            raise RuntimeError("服务器 host key SHA-256 与已记录指纹不一致")
        # 仅加入当前内存会话，不修改用户 known_hosts。
        client.get_host_keys().add(hostname, key.get_name(), key)


def connect_verified(expected_fingerprint: str):
    """读取批准基线和任务账号，并以固定指纹建立 SSH 会话。"""
    approved_fingerprint = validate_approved_fingerprint(expected_fingerprint)

    import paramiko

    account_path = os.environ.get("AI_CS_SERVER_ACCOUNT_FILE")
    if not account_path:
        raise RuntimeError("缺少 AI_CS_SERVER_ACCOUNT_FILE")
    host, username, password = read_account_file(account_path)
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(_PinnedSHA256Policy(approved_fingerprint))
    client.connect(
        host,
        port=22,
        username=username,
        password=password,
        sock=_proxy_socket(host),
        allow_agent=False,
        look_for_keys=False,
        timeout=20,
        auth_timeout=20,
    )
    return client


def _main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("probe-host-key")
    capture = subparsers.add_parser("capture-artifacts")
    capture.add_argument("--remote-dir", required=True)
    capture.add_argument("--fingerprint", required=True)
    args = parser.parse_args()

    account_path = os.environ.get("AI_CS_SERVER_ACCOUNT_FILE")
    if not account_path:
        raise RuntimeError("缺少 AI_CS_SERVER_ACCOUNT_FILE")
    host, _username, _password = read_account_file(account_path)
    if args.command == "probe-host-key":
        print(probe_host_key(host))
        return 0

    client = connect_verified(args.fingerprint)
    try:
        inventory = collect_inventory(client)
        hashes = capture_artifacts(client, args.remote_dir)
    finally:
        client.close()
    print(json.dumps({"inventory": inventory, "artifact_sha256": hashes}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
