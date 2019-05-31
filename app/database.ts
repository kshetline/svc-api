import mysql, { FieldInfo, MysqlError, PoolConnection, QueryOptions } from 'mysql';

const thePool = mysql.createPool({
  host: (process.env.DB_REMOTE ? 'skyviewcafe.com' : '127.0.0.1'),
  user: 'skyview',
  password: process.env.DB_PWD,
  database: 'skyviewcafe'
});

thePool.on('connection', connection => {
  connection.query("SET NAMES 'utf8'");
});

export interface FullQueryResults {
  err: MysqlError | null;
  results: any;
  fields: FieldInfo[];
}

export class Connection {
  constructor(private connection: PoolConnection) { }

  query(sqlStringOrOptions: string | QueryOptions, values?: any): Promise<FullQueryResults> {
    return new Promise<FullQueryResults>(resolve => {
      const args = typeof sqlStringOrOptions === 'string' ?
        [sqlStringOrOptions, values] : [sqlStringOrOptions];

        (this.connection.query as any)(...args, (err: MysqlError, results: any, fields: FieldInfo[]) => resolve({err, results, fields}));
    });
  }

  queryResults(sqlStringOrOptions: string | QueryOptions, values?: any): Promise<any> {
    return new Promise<any>((resolve, reject) => {
      const args = typeof sqlStringOrOptions === 'string' ?
        [sqlStringOrOptions, values] : [sqlStringOrOptions];

      (this.connection.query as any)(...args, (err: MysqlError, results: any) => {
        if (err)
          reject(err);
        else
          resolve(results);
      });
    });
  }

  release(): void {
    this.connection.release();
  }
}

export const pool = {
  getConnection: () => new Promise<Connection>((resolve, reject) => {
    thePool.getConnection((err, connection) => {
      if (err) {
        if (err.code === 'PROTOCOL_CONNECTION_LOST')
          console.error('Database connection was closed.');
        else if (err.code === 'ER_CON_COUNT_ERROR')
          console.error('Database has too many connections.');
        else if (err.code === 'ECONNREFUSED')
          console.error('Database connection was refused.');
        else
          console.error('Database error: ' + err.code);

        reject(err);
      } else
        resolve(new Connection(connection));
    });
  }),

  query: (sqlStringOrOptions: string | QueryOptions, values?: any) => new Promise<FullQueryResults>(resolve => {
    const args = typeof sqlStringOrOptions === 'string' ?
      [sqlStringOrOptions, values] : [sqlStringOrOptions];

    (thePool.query as any)(...args, (err: MysqlError, results: any, fields: FieldInfo[]) => resolve({err, results, fields}));
  }),

  queryResults: (sqlStringOrOptions: string | QueryOptions, values?: any) => new Promise<any>((resolve, reject) => {
    const args = typeof sqlStringOrOptions === 'string' ?
      [sqlStringOrOptions, values] : [sqlStringOrOptions];

    (thePool.query as any)(...args, (err: MysqlError, results: any) => {
      if (err)
        reject(err);
      else
        resolve(results);
    });
  })
};

export function logWarning(message: string, notrace = true): void {
  console.warn(message, notrace);
}
