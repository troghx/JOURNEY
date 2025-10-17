import { neon, neonConfig } from '@neondatabase/serverless';

neonConfig.fetchConnectionCache = true;

// --- Resolve DB URL from common env names ---
const DATABASE_URL =
  process.env.NEON_DATABASE_URL ||
  process.env.NETLIFY_DATABASE_URL_UNPOOLED || // Neon integration (direct)
  process.env.NETLIFY_DATABASE_URL ||          // Neon integration (pooler)
  process.env.DATABASE_URL;                    // fallback

function redact(url = '') {
  try {
    const u = new URL(url);
    // keep protocol + host + db; hide user/pass
    return `${u.protocol}//***:***@${u.hostname}${u.port ? ':' + u.port : ''}${u.pathname}${u.search}`;
  } catch {
    return 'invalid-url';
  }
}

let sql;
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set. Define NEON_DATABASE_URL or NETLIFY_DATABASE_URL(_UNPOOLED).');
} else {
  sql = neon(DATABASE_URL);
}

let tableReady = false;
async function ensureTable() {
  if (tableReady) return;
  await sql`
    CREATE TABLE IF NOT EXISTS employees (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      position TEXT,
      department TEXT,
      checked_in BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  tableReady = true;
}

const headers = {
  'Content-Type': 'application/json',
};

function mapRow(r) {
  return {
    id: r.id,
    name: r.name ?? '',
    position: r.position ?? '',
    department: r.department ?? '',
    checkedIn: !!r.checked_in,
  };
}

export async function handler(event) {
  try {
    const method = event.httpMethod;
    const qs = event.queryStringParameters || {};

    if (method === 'OPTIONS') {
      return { statusCode: 200, headers };
    }

    // Health/debug endpoints (no DB required for health)
    if (qs.health === '1') {
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }
    if (qs.debug === '1') {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          method,
          dbUrlResolved: redact(DATABASE_URL),
          hasSqlClient: Boolean(sql),
          envKeysPresent: Object.keys(process.env).filter(k => /DATABASE_URL/i.test(k)).sort(),
        }),
      };
    }

    if (!sql) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          error: 'DATABASE_URL no configurada en el entorno',
          hint: 'Define NEON_DATABASE_URL o NETLIFY_DATABASE_URL(_UNPOOLED) en Netlify y re-deploy.',
          envKeysPresent: Object.keys(process.env).filter(k => /DATABASE_URL/i.test(k)).sort(),
        }),
      };
    }

    await ensureTable();

    if (method === 'GET') {
      const rows = await sql`SELECT id, name, position, department, checked_in FROM employees ORDER BY name ASC`;
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ employees: rows.map(mapRow) }),
      };
    }

    if (method === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const incoming = Array.isArray(body.employees) ? body.employees : [];
      if (!incoming.length) {
        const rows = await sql`SELECT id, name, position, department, checked_in FROM employees ORDER BY name ASC`;
        return { statusCode: 200, headers, body: JSON.stringify({ employees: rows.map(mapRow), inserted: 0, skipped: 0 }) };
      }

      const clean = [];
      const seen = new Set();
      for (const e of incoming) {
        const id = String(e.id ?? '').trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        clean.push({
          id,
          name: String(e.name ?? '').trim(),
          position: String(e.position ?? '').trim(),
          department: String(e.department ?? '').trim(),
          checkedIn: !!e.checkedIn,
        });
      }

      const values = clean.map(e => sql`(${e.id}, ${e.name}, ${e.position}, ${e.department}, ${e.checkedIn})`);
      const insertedRows = await sql`
        INSERT INTO employees (id, name, position, department, checked_in)
        VALUES ${sql(values)}
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      `;
      const inserted = insertedRows.length;
      const skipped = clean.length - inserted;

      const rows = await sql`SELECT id, name, position, department, checked_in FROM employees ORDER BY name ASC`;
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ employees: rows.map(mapRow), inserted, skipped }),
      };
    }

    if (method === 'PATCH') {
      const body = JSON.parse(event.body || '{}');
      const id = String(body.id ?? '').trim();
      const checkedIn = body.checkedIn;

      if (!id || typeof checkedIn !== 'boolean') {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Campos requeridos: id (string) y checkedIn (boolean).' }) };
      }

      const updated = await sql`
        UPDATE employees
        SET checked_in = ${checkedIn}, updated_at = now()
        WHERE id = ${id}
        RETURNING id, name, position, department, checked_in
      `;

      if (!updated.length) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Empleado no encontrado' }) };
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ employee: mapRow(updated[0]) }),
      };
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Método no permitido' }) };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Error interno del servidor',
        detail: String(err?.message || err),
      }),
    };
  }
}
