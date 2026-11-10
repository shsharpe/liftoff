// Looks for the usual MySQL/MariaDB environment variables. The platform's own
// variable names aren't documented anywhere I could find, so this accepts the
// common conventions and reports which names it saw (names only, never values).

const NAME_PATTERN = /^(DATABASE_URL|MYSQL_URL|MARIADB_URL|DB_[A-Z_]+|MYSQL_[A-Z_]+|MARIADB_[A-Z_]+)$/;

export function databaseEnvNames() {
  return Object.keys(process.env).filter((k) => NAME_PATTERN.test(k)).sort();
}

function pick(env, ...keys) {
  for (const k of keys) {
    if (env[k] !== undefined && env[k] !== '') return env[k];
  }
  return undefined;
}

function resolveConfig(env) {
  const url = pick(env, 'DATABASE_URL', 'MYSQL_URL', 'MARIADB_URL');
  if (url) {
    try {
      const u = new URL(url);
      if (/^(mysql|mariadb)s?:$/.test(u.protocol)) {
        return {
          host: u.hostname,
          port: Number(u.port) || 3306,
          user: decodeURIComponent(u.username),
          password: decodeURIComponent(u.password),
          database: u.pathname.replace(/^\//, ''),
        };
      }
    } catch {
      /* fall through to the discrete variables */
    }
  }
  const user = pick(env, 'DB_USER', 'DB_USERNAME', 'MYSQL_USER', 'MARIADB_USER');
  const database = pick(env, 'DB_NAME', 'DB_DATABASE', 'MYSQL_DATABASE', 'MYSQL_DB', 'MARIADB_DATABASE');
  if (!user || !database) return null;
  return {
    host: pick(env, 'DB_HOST', 'MYSQL_HOST', 'MARIADB_HOST') || '127.0.0.1',
    port: Number(pick(env, 'DB_PORT', 'MYSQL_PORT', 'MARIADB_PORT')) || 3306,
    user,
    password: pick(env, 'DB_PASSWORD', 'DB_PASS', 'MYSQL_PASSWORD', 'MARIADB_PASSWORD') || '',
    database,
  };
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export async function probeDatabase() {
  const envNames = databaseEnvNames();
  const config = resolveConfig(process.env);
  if (!config) return { linked: false, envNames };

  let connection;
  try {
    const mysql = await import('mysql2/promise');
    connection = await mysql.createConnection({ ...config, connectTimeout: 3000 });

    const [rows] = await connection.query('SELECT VERSION() AS version');
    const timings = [];
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      await connection.query('SELECT 1');
      timings.push(performance.now() - t);
    }
    return {
      linked: true,
      connected: true,
      envNames,
      server: rows[0].version,
      medianMs: Math.round(median(timings) * 10) / 10,
    };
  } catch (err) {
    // Only the error code. The message can contain the host or user name.
    return { linked: true, connected: false, envNames, error: (err && (err.code || err.name)) || 'ERROR' };
  } finally {
    if (connection) connection.destroy();
  }
}
