"""把服务器 .env 归档下载到内存，并以 Windows DPAPI 加密保存。"""

from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
import os
from pathlib import Path
import shlex
from typing import Any

try:
    from ops.server_inventory import connect_verified, run_remote, validate_backup_dir
except ModuleNotFoundError:
    from server_inventory import connect_verified, run_remote, validate_backup_dir


CRYPTPROTECT_UI_FORBIDDEN = 0x1
APPROVED_OUTPUT_PATH = Path(r"C:\Users\Lenovo\.codex-secrets\server-backups\20260810-before-v2.dpapi")


class _DATA_BLOB(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_byte))]


def _blob(data: bytes) -> tuple[_DATA_BLOB, Any]:
    # create_string_buffer 让 DPAPI 在调用期间获得稳定的内存地址。
    buffer = ctypes.create_string_buffer(data)
    blob = _DATA_BLOB(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_byte)))
    return blob, buffer


def _dpapi(data: bytes, *, decrypt: bool) -> bytes:
    if not data:
        raise ValueError("待保护数据为空")
    source, source_buffer = _blob(data)
    result = _DATA_BLOB()
    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32
    if decrypt:
        ok = crypt32.CryptUnprotectData(
            ctypes.byref(source), None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(result)
        )
    else:
        ok = crypt32.CryptProtectData(
            ctypes.byref(source), "AI customer service server backup", None, None, None,
            CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(result)
        )
    # 保留引用直到 Windows API 返回，防止源缓冲区被提前回收。
    _ = source_buffer
    if not ok:
        raise ctypes.WinError()
    try:
        return ctypes.string_at(result.pbData, result.cbData)
    finally:
        kernel32.LocalFree(result.pbData)


def protect_bytes(data: bytes) -> bytes:
    """用当前 Windows 账号的 DPAPI 加密字节。"""
    return _dpapi(data, decrypt=False)


def unprotect_bytes(data: bytes) -> bytes:
    """用当前 Windows 账号的 DPAPI 解密字节。"""
    return _dpapi(data, decrypt=True)


def backup_secret_files(client: Any, remote_dir: str, output_path: str | os.PathLike[str]) -> dict:
    """服务器内归档旧 .env，SFTP 读取到内存后仅落 DPAPI 密文。"""
    remote_dir = validate_backup_dir(remote_dir)
    target = Path(output_path)
    if target != APPROVED_OUTPUT_PATH:
        raise ValueError("本地密文路径不是任务批准的精确路径")
    if target.exists():
        raise FileExistsError("本地 DPAPI 备份已存在，拒绝覆盖")
    archive = f"{remote_dir}/env-files.tar.gz"
    script = f"""set -eu
umask 077
archive={shlex.quote(archive)}
test ! -e "$archive"
files=''
for item in /root/apps/linglongzi-agent-chat-ui/.env /root/apps/linglongzi-new-langgraph-templete-python/.env; do
  if test -f "$item"; then files="$files $item"; fi
done
test -n "$files"
tar -czf "$archive" $files
chmod 600 "$archive"
"""
    run_remote(client, "bash -c " + shlex.quote(script))
    sftp = client.open_sftp()
    try:
        with sftp.open(archive, "rb") as remote_file:
            plaintext = remote_file.read()
    finally:
        sftp.close()
    encrypted = protect_bytes(plaintext)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("xb") as handle:
        handle.write(encrypted)
    return {"remote_archive": archive, "encrypted_size": len(encrypted)}


def _main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--remote-dir", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--fingerprint", required=True)
    args = parser.parse_args()
    client = connect_verified(args.fingerprint)
    try:
        result = backup_secret_files(client, args.remote_dir, args.output)
    finally:
        client.close()
    # 只输出路径和密文尺寸，不输出任何秘密内容。
    print(f"DPAPI backup created: {result['encrypted_size']} encrypted bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
