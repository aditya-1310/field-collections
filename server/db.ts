import { config } from 'dotenv';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

config({ quiet: true });

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Sql {
  query<T = Record<string, unknown>>(
    statement: string,
    params?: unknown[],
  ): Promise<QueryResult<T>>;
}

export interface Database extends Sql {
  transaction<T>(work: (tx: Sql) => Promise<T>): Promise<T>;
  migrate(): Promise<void>;
  close(): Promise<void>;
}

const schema = new URL('./schema.sql', import.meta.url);
pg.types.setTypeParser(1082, (value) => value);

export function createDb(
  options: {
    memory?: boolean;
    connectionString?: string;
    dataDir?: string;
  } = {},
): Database {
  if (options.connectionString && !options.memory) {
    const url = new URL(options.connectionString);
    if (url.searchParams.get('sslmode') === 'require')
      url.searchParams.set('sslmode', 'verify-full');
    const pool = new pg.Pool({
      connectionString: url.toString(),
      max: 5,
      connectionTimeoutMillis: 12000,
    });
    pool.on('error', (error) =>
      console.error('Idle database connection closed', {
        code: (error as { code?: string }).code,
      }),
    );
    const pgSql = (client: pg.Pool | pg.PoolClient): Sql => ({
      async query<T>(statement: string, params?: unknown[]) {
        const result = await client.query(statement, params);
        return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
      },
    });
    return {
      ...pgSql(pool),
      async transaction<T>(work: (tx: Sql) => Promise<T>) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await work(pgSql(client));
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },
      async migrate() {
        const statement = await readFile(schema, 'utf8');
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query('SELECT pg_advisory_xact_lock(71924013)');
          await client.query(statement);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  }

  const dataDir = options.memory ? 'memory://' : (options.dataDir ?? '.data/postgres');
  if (!options.memory) mkdirSync(dataDir, { recursive: true });
  const engine = new PGlite(dataDir);
  return {
    async query<T>(statement: string, params?: unknown[]) {
      const result = await engine.query<T>(statement, params);
      return {
        rows: result.rows,
        rowCount: result.affectedRows ?? result.rows.length,
      };
    },
    async transaction<T>(work: (tx: Sql) => Promise<T>) {
      return engine.transaction(async (tx) =>
        work({
          async query<R>(statement: string, params?: unknown[]) {
            const result = await tx.query<R>(statement, params);
            return {
              rows: result.rows,
              rowCount: result.affectedRows ?? result.rows.length,
            };
          },
        }),
      );
    },
    async migrate() {
      await engine.exec(await readFile(schema, 'utf8'));
    },
    close: () => engine.close(),
  };
}

let defaultDb: Database | undefined;
export function getDb() {
  if (defaultDb) return defaultDb;
  const memory =
    process.env.NODE_ENV === 'test' ||
    process.env.DATABASE_PATH === 'memory://';
  const connectionString = process.env.DATABASE_URL || undefined;
  if (process.env.NODE_ENV === 'production' && (!connectionString || memory)) {
    throw new Error('A hosted DATABASE_URL is required in production.');
  }
  defaultDb = createDb({
    memory,
    connectionString,
    dataDir: process.env.DATABASE_PATH,
  });
  return defaultDb;
}

export const query: Sql['query'] = (statement, params) =>
  getDb().query(statement, params);
export const transaction: Database['transaction'] = (work) =>
  getDb().transaction(work);
export const migrate = () => getDb().migrate();
export async function seed() {
  const { seedDatabase } = await import('./seed');
  await seedDatabase(getDb());
}
export async function closeDb() {
  await defaultDb?.close();
  defaultDb = undefined;
}
