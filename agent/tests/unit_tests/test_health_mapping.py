from agent.repository import PsycopgDatabase


class Cursor:
    def __init__(self):
        self.rows = iter([{"ready": 1}, {"version": "virtual-release"}])

    def __enter__(self): return self
    def __exit__(self, *args): return False
    def execute(self, query): return None
    def fetchone(self): return next(self.rows)


class Connection:
    def __enter__(self): return self
    def __exit__(self, *args): return False
    def cursor(self): return Cursor()


class Pool:
    def connection(self): return Connection()


def test_health_reads_mapping_rows_from_runtime_dict_cursor():
    database = PsycopgDatabase("unused")
    database._pool = Pool()

    assert database.health() == {
        "database": "ready",
        "knowledge": "ready",
        "knowledge_version": "virtual-release",
    }
