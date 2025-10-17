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

const DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;

function formatDateKey(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function resolveDateFromQuery(rawDate) {
  if (!rawDate) {
    const today = new Date();
    return { date: today, key: formatDateKey(today) };
  }

  const match = rawDate.match(DATE_REGEX);
  if (!match) return null;

  const [, yearStr, monthStr, dayStr] = match;
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
    return null;
  }

  return { date, key: formatDateKey(date) };
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
  
  await sql`
    CREATE TABLE IF NOT EXISTS employee_attendance (
      employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      attendance_date DATE NOT NULL,
      checked_in BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (employee_id, attendance_date)
    )
  `;
}

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
};

function mapRow(r) {
  return {
    id: r.id,
    name: r.name ?? '',
    position: r.position ?? '',
    department: r.department ?? '',
    checkedIn: !!r.checked_in,
    attendanceRecorded: !!(r.attendance_recorded ?? false),
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
      const resolved = resolveDateFromQuery((qs.date || '').trim());
      if (!resolved) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'El parámetro de fecha es inválido. Usa el formato YYYY-MM-DD.' }),
        };
      }

      const rows = await sql`
        SELECT
          e.id,
          e.name,
          e.position,
          e.department,
          COALESCE(a.checked_in, FALSE) AS checked_in,
          (a.employee_id IS NOT NULL) AS attendance_recorded
        FROM employees e
        LEFT JOIN employee_attendance a
          ON a.employee_id = e.id AND a.attendance_date = ${resolved.key}
        ORDER BY e.name ASC
      `;

      const hasAttendanceRecords = rows.some(row => row.attendance_recorded);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          employees: rows.map(mapRow),
          hasAttendanceRecords,
          date: resolved.key,
        }),
      };
    }

    if (method === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const incoming = Array.isArray(body.employees) ? body.employees : [];
      if (!incoming.length) {
        const rows = await sql`SELECT id, name, position, department, checked_in, FALSE AS attendance_recorded FROM employees ORDER BY name ASC`;
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

      const rows = await sql`SELECT id, name, position, department, checked_in, FALSE AS attendance_recorded FROM employees ORDER BY name ASC`;
      return { statusCode: 200, headers, body: JSON.stringify({ employees: rows.map(mapRow), inserted, skipped }) };
    }

    if (method === 'DELETE') {
      let dateParam = String((qs.date || '').trim());
      if (!dateParam && event.body) {
        try {
          const parsed = JSON.parse(event.body || '{}');
          if (parsed && parsed.date) {
            dateParam = String(parsed.date).trim();
          }
        } catch (error) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'El cuerpo de la solicitud no contiene JSON válido.' }),
          };
        }
      }
      if (!dateParam) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'El campo date es requerido para limpiar asistencias.' }),
        };
      }

      const resolvedDate = resolveDateFromQuery(dateParam);
      if (!resolvedDate) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'El campo date es inválido. Usa el formato YYYY-MM-DD.' }),
        };
      }

      const deletedRows = await sql`
        DELETE FROM employee_attendance
        WHERE attendance_date = ${resolvedDate.key}
        RETURNING employee_id
      `;

      if (deletedRows.length) {
        const ids = deletedRows.map(row => row.employee_id);
        await sql`
          UPDATE employees
          SET checked_in = FALSE, updated_at = now()
          WHERE id = ANY(${ids})
        `;
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ cleared: deletedRows.length, date: resolvedDate.key }),
      };
    }

    if (method === 'PATCH') {
      const body = JSON.parse(event.body || '{}');
      const id = String(body.id ?? '').trim();
      const checkedIn = body.checkedIn;
      const dateParam = String(body.date ?? '').trim();

      if (!id || typeof checkedIn !== 'boolean' || !dateParam) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Campos requeridos: id (string), checkedIn (boolean) y date (YYYY-MM-DD).' }),
        };
      }
      const resolvedDate = resolveDateFromQuery(dateParam);
      if (!resolvedDate) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'El campo date es inválido. Usa el formato YYYY-MM-DD.' }),
        };
      }

      const existing = await sql`SELECT id FROM employees WHERE id = ${id}`;
      if (!existing.length) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Empleado no encontrado' }) };
      }

      await sql`
        INSERT INTO employee_attendance (employee_id, attendance_date, checked_in, updated_at)
        VALUES (${id}, ${resolvedDate.key}, ${checkedIn}, now())
        ON CONFLICT (employee_id, attendance_date)
        DO UPDATE SET checked_in = EXCLUDED.checked_in, updated_at = now()
      `;

      await sql`
        UPDATE employees
        SET checked_in = ${checkedIn}, updated_at = now()
        WHERE id = ${id}
      `;

      const rows = await sql`
        SELECT
          e.id,
          e.name,
          e.position,
          e.department,
          COALESCE(a.checked_in, FALSE) AS checked_in,
          TRUE AS attendance_recorded
        FROM employees e
        LEFT JOIN employee_attendance a
          ON a.employee_id = e.id AND a.attendance_date = ${resolvedDate.key}
        WHERE e.id = ${id}
      `;

      if (!rows.length) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Empleado no encontrado' }) };
      }

      return { statusCode: 200, headers, body: JSON.stringify({ employee: mapRow(rows[0]) }) };
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
