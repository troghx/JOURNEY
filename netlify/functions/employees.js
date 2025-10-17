import { neon, neonConfig } from '@neondatabase/serverless';
neonConfig.fetchConnectionCache = true;

// --- Helper: resolve DB URL on each request (no module-load crash) ---
function resolveDatabaseUrl() {
  const url =
    process.env.NEON_DATABASE_URL ||
    process.env.NETLIFY_DATABASE_URL_UNPOOLED ||
    process.env.NETLIFY_DATABASE_URL ||
    process.env.DATABASE_URL ||
    '';

  return String(url).trim();
}

function looksLikePostgres(url) {
  return /^postgres(ql)?:\/\//i.test(url);
}

function redact(url = '') {
  try {
    const u = new URL(url);
    return `${u.protocol}//***:***@${u.hostname}${u.port ? ':' + u.port : ''}${u.pathname}${u.search}`;
  } catch {
    return 'invalid-url';
  }
}

async function ensureTable(sql) {
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
}

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
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

    if (method === 'OPTIONS') return { statusCode: 200, headers };

    // Health & debug that do NOT require DB
    if (qs.health === '1') return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    if (qs.debug === '1') {
      const raw = resolveDatabaseUrl();
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          method,
          dbUrlResolved: redact(raw),
          validUrl: looksLikePostgres(raw),
          envKeysPresent: Object.keys(process.env).filter(k => /DATABASE_URL/i.test(k)).sort(),
        }),
      };
    }

    // Resolve DB at runtime
    const dbUrl = resolveDatabaseUrl();
    if (!looksLikePostgres(dbUrl)) {
      const errorBody = {
        error: 'DATABASE_URL inválida o ausente',
        received: dbUrl || null,
        hint:
          'En Netlify, define NEON_DATABASE_URL con la URL completa que inicia con postgresql:// (o usa NETLIFY_DATABASE_URL_UNPOOLED).',
      };
      console.error('[employees] Configuración de base de datos inválida:', errorBody);
      return { statusCode: 500, headers, body: JSON.stringify(errorBody) };
    }

    const sql = neon(dbUrl);
    await ensureTable(sql);

    if (method === 'GET') {
      const rows = await sql`SELECT id, name, position, department, checked_in FROM employees ORDER BY name ASC`;
      return { statusCode: 200, headers, body: JSON.stringify({ employees: rows.map(mapRow) }) };
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

      let inserted = 0;
      let skipped = 0;

      if (clean.length) {
        const columns = ['id', 'name', 'position', 'department', 'checked_in'];
        const paramsPerRow = columns.length;
        const placeholders = clean
          .map((_, rowIndex) => {
            const base = rowIndex * paramsPerRow;
            const rowPlaceholders = columns.map((__, colIndex) => `$${base + colIndex + 1}`);
            return `(${rowPlaceholders.join(', ')})`;
          })
          .join(', ');

        const query = `
          INSERT INTO employees (id, name, position, department, checked_in)
          VALUES ${placeholders}
          ON CONFLICT (id) DO NOTHING
          RETURNING id
        `;
    
        const queryParams = clean.flatMap(e => [
          e.id,
          e.name,
          e.position,
          e.department,
          e.checkedIn,
        ]);

        const insertedRows = await sql(query, queryParams);
        inserted = insertedRows.length;
        skipped = clean.length - inserted;
      }

      const rows = await sql`SELECT id, name, position, department, checked_in FROM employees ORDER BY name ASC`;
      return { statusCode: 200, headers, body: JSON.stringify({ employees: rows.map(mapRow), inserted, skipped }) };
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

      if (!updated.length) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Empleado no encontrado' }) };

      return { statusCode: 200, headers, body: JSON.stringify({ employee: mapRow(updated[0]) }) };
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Método no permitido' }) };
  } catch (err) {
    console.error('[employees] Error inesperado:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Error interno del servidor',
        detail: String(err?.message || err),
        code: err?.code ?? null,
      }),
    };
  }
}
