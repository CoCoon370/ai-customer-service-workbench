import os
import subprocess
import sys


def test_importing_agent_does_not_construct_external_clients() -> None:
    environment = os.environ.copy()
    environment.pop("OPENAI_API_KEY", None)
    environment.pop("OPENAI_ADMIN_KEY", None)
    environment.pop("DASHSCOPE_API_KEY", None)

    completed = subprocess.run(
        [sys.executable, "-c", "import agent"],
        check=False,
        capture_output=True,
        text=True,
        env=environment,
    )

    assert completed.returncode == 0, completed.stderr
