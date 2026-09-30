import { Pool, type PoolClient } from "pg";

export type QueryResult<T> = { rows: T[]; rowCount: number };

export interface Queryable {
  query<T>(sql: string, values?: readonly unknown[]): Promise<QueryResult<T>>;
}

export interface Database extends Queryable {
  transaction<T>(work: (client: Queryable) => Promise<T>): Promise<T>;
}

export class PgDatabase implements Database {
  constructor(private readonly pool: Pool) {}

  async query<T>(sql: string, values: readonly unknown[] = []): Promise<QueryResult<T>> {
    const result = await this.pool.query(sql, [...values]);
    return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
  }

  async transaction<T>(work: (client: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(new PgClientQueryable(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

class PgClientQueryable implements Queryable {
  constructor(private readonly client: PoolClient) {}

  async query<T>(sql: string, values: readonly unknown[] = []): Promise<QueryResult<T>> {
    const result = await this.client.query(sql, [...values]);
    return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
  }
}

let database: Database | undefined;

export function getDatabase(): Database {
  if (database) return database;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("database is not configured");
  database = new PgDatabase(new Pool({ connectionString, max: 10 }));
  return database;
}
