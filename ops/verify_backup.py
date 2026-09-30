"""校验备份，并在一次性数据库中完成真实恢复演练。"""

from __future__ import annotations

import argparse
import json
import shlex
from typing import Any

try:
    from ops.server_inventory import connect_verified, run_remote, validate_backup_dir
except ModuleNotFoundError:
    from server_inventory import connect_verified, run_remote, validate_backup_dir


def verify_backup(client: Any, backup_dir: str) -> dict:
    """验证 bundle、哈希和 3,876 条商品数据，结束时删除检查库。"""
    backup_dir = validate_backup_dir(backup_dir)
    quoted = shlex.quote(backup_dir)
    script = f"""set -eu
backup_dir={quoted}
test ! -e /var/lib/postgresql/linglongzivectordb_restore_check.task2
if sudo -u postgres psql -d postgres -Atqc "select 1 from pg_database where datname='linglongzivectordb_restore_check'" | grep -qx 1; then
  echo '恢复检查库已存在，拒绝覆盖' >&2
  exit 31
fi
git -C /root/apps/linglongzi-agent-chat-ui bundle verify "$backup_dir/frontend.bundle" >/dev/null 2>&1
git -C /root/apps/linglongzi-new-langgraph-templete-python bundle verify "$backup_dir/agent.bundle" >/dev/null 2>&1
for required in pm2-processes.txt systemd-services.txt listeners.txt; do test -s "$backup_dir/$required"; done
sudo -u postgres createdb linglongzivectordb_restore_check
cleanup() {{ sudo -u postgres dropdb --if-exists linglongzivectordb_restore_check >/dev/null; }}
trap cleanup EXIT HUP INT TERM
sudo -u postgres pg_restore --exit-on-error --dbname=linglongzivectordb_restore_check < "$backup_dir/linglongzivectordb.dump"
count=$(sudo -u postgres psql -d linglongzivectordb_restore_check -Atqc 'select count(*) from public.youzan_products')
test "$count" = 3876
sha256sum "$backup_dir/frontend.bundle" "$backup_dir/agent.bundle" "$backup_dir/linglongzivectordb.dump" | awk '{{name=$2; sub(".*/", "", name); print name "\\t" $1}}'
printf 'products\\t%s\\n' "$count"
"""
    output = run_remote(client, "bash -c " + shlex.quote(script))
    values: dict[str, str] = {}
    for line in output.splitlines():
        if "\t" in line:
            key, value = line.split("\t", 1)
            values[key] = value
    required = {"frontend.bundle", "agent.bundle", "linglongzivectordb.dump", "products"}
    if not required.issubset(values):
        raise ValueError("备份校验输出不完整")
    count = int(values["products"])
    if count != 3876:
        raise ValueError("恢复商品数量与审核基线不一致")
    return {
        "product_count": count,
        "sha256": {name: values[name] for name in sorted(required - {"products"})},
        "restore_check_database_removed": True,
    }


def _main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--remote-dir", required=True)
    parser.add_argument("--fingerprint", required=True)
    args = parser.parse_args()
    client = connect_verified(args.fingerprint)
    try:
        result = verify_backup(client, args.remote_dir)
    finally:
        client.close()
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
