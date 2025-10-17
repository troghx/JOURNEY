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

function generateManualId() {
  return `manual-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function normalizeNameKey(name = '') {
  return String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function toNullableText(value) {
  const text = String(value ?? '').trim();
  return text === '' ? null : text;
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
      let body;
      try {
        body = event.body ? JSON.parse(event.body) : {};
      } catch (error) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'El cuerpo de la solicitud no contiene JSON válido.' }),
        };
      }

      const singleEmployeePayload = body && typeof body.employee === 'object' ? body.employee : null;
      if (singleEmployeePayload) {
        const name = String(singleEmployeePayload.name ?? '').trim();
        if (!name) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'El campo name es obligatorio para crear un empleado.' }),
          };
        }

        const normalizedName = normalizeNameKey(name);
        if (normalizedName) {
          const existingNameRows = await sql`SELECT name FROM employees`;
          const conflict = existingNameRows.some(row => normalizeNameKey(row.name) === normalizedName);
          if (conflict) {
            return {
              statusCode: 409,
              headers,
              body: JSON.stringify({ error: 'Ya existe un empleado con ese nombre.' }),
            };
          }
        }

        const manualId = generateManualId();
        const position = toNullableText(singleEmployeePayload.position);
        const department = toNullableText(singleEmployeePayload.department);

        const inserted = await sql`
          INSERT INTO employees (id, name, position, department, checked_in, updated_at)
          VALUES (${manualId}, ${name}, ${position}, ${department}, FALSE, now())
          RETURNING id, name, position, department, checked_in, FALSE AS attendance_recorded
        `;

        if (!inserted.length) {
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'No se pudo crear el empleado.' }),
          };
        }

        return {
          statusCode: 201,
          headers,
          body: JSON.stringify({ employee: mapRow(inserted[0]) }),
        };
      }

      const incoming = Array.isArray(body.employees) ? body.employees : [];
      if (!incoming.length) {
        const rows = await sql`SELECT id, name, position, department, checked_in, FALSE AS attendance_recorded FROM employees ORDER BY name ASC`;
        return { statusCode: 200, headers, body: JSON.stringify({ employees: rows.map(mapRow), inserted: 0, skipped: 0, updated: 0, matchedByName: 0, promoted: 0 }) };
      }

      const existingRows = await sql`SELECT id, name, position, department, checked_in FROM employees`;
      const existingById = new Map();
      const existingByName = new Map();
      existingRows.forEach(row => {
        existingById.set(row.id, row);
        const nameKey = normalizeNameKey(row.name);
        if (nameKey && !existingByName.has(nameKey)) {
          existingByName.set(nameKey, row);
        }
      });

      const seenIds = new Set();
      const seenNames = new Set();
      const inserts = [];
      const updatesById = [];
      const updatesByName = [];
      const promotions = [];
      let skipped = 0;

      for (const raw of incoming) {
        const id = String(raw?.id ?? '').trim();
        const name = String(raw?.name ?? '').trim();
        if (!name) {
          skipped += 1;
          continue;
        }

        const position = String(raw?.position ?? '').trim();
        const department = String(raw?.department ?? '').trim();
        const hasChecked = typeof raw?.checkedIn === 'boolean';
        const checkedIn = hasChecked ? Boolean(raw.checkedIn) : false;
        const nameKey = normalizeNameKey(name);

        if (id) {
          if (seenIds.has(id)) {
            skipped += 1;
            continue;
          }
          seenIds.add(id);
        }

        if (!id && nameKey) {
          if (seenNames.has(nameKey)) {
            skipped += 1;
            continue;
          }
          seenNames.add(nameKey);
        }

        const existingByIdRow = id ? existingById.get(id) : null;
        if (existingByIdRow) {
          updatesById.push({ id, name, position, department, checkedIn, hasChecked, existing: existingByIdRow });
          existingByName.set(nameKey, { ...existingByIdRow, name });
          continue;
        }

        const existingByNameRow = nameKey ? existingByName.get(nameKey) : null;
        if (existingByNameRow && existingByNameRow.id && existingByNameRow.id.startsWith('manual-') && id) {
          promotions.push({ oldId: existingByNameRow.id, newId: id, name, position, department, checkedIn, hasChecked, existing: existingByNameRow });
          existingById.set(id, { ...existingByNameRow, id });
          existingByName.set(nameKey, { ...existingByNameRow, id });
          continue;
        }

        if (existingByNameRow) {
          updatesByName.push({ id: existingByNameRow.id, name, position, department, checkedIn, hasChecked, existing: existingByNameRow });
          continue;
        }

        const finalId = id || generateManualId();
        inserts.push({ id: finalId, name, position, department, checkedIn });
      }

      let inserted = 0;
      let updated = 0;
      let matchedByName = 0;
      let promoted = 0;

      await sql.transaction(async (tx) => {
        for (const item of updatesById) {
          const finalName = item.name || item.existing.name || '';
          const finalPosition = item.position || item.existing.position || '';
          const finalDepartment = item.department || item.existing.department || '';
          const finalChecked = item.hasChecked ? item.checkedIn : Boolean(item.existing.checked_in);
          await tx`
            UPDATE employees
            SET name = ${finalName},
                position = ${toNullableText(finalPosition)},
                department = ${toNullableText(finalDepartment)},
                checked_in = ${finalChecked},
                updated_at = now()
            WHERE id = ${item.id}
          `;
          updated += 1;
        }

        for (const item of updatesByName) {
          const finalName = item.name || item.existing.name || '';
          const finalPosition = item.position || item.existing.position || '';
          const finalDepartment = item.department || item.existing.department || '';
          const finalChecked = item.hasChecked ? item.checkedIn : Boolean(item.existing.checked_in);
          await tx`
            UPDATE employees
            SET name = ${finalName},
                position = ${toNullableText(finalPosition)},
                department = ${toNullableText(finalDepartment)},
                checked_in = ${finalChecked},
                updated_at = now()
            WHERE id = ${item.id}
          `;
          matchedByName += 1;
        }

        for (const item of promotions) {
          const finalName = item.name || item.existing.name || '';
          const finalPosition = item.position || item.existing.position || '';
          const finalDepartment = item.department || item.existing.department || '';
          const finalChecked = item.hasChecked ? item.checkedIn : Boolean(item.existing.checked_in);

          await tx`
            INSERT INTO employees (id, name, position, department, checked_in, updated_at)
            VALUES (${item.newId}, ${finalName}, ${toNullableText(finalPosition)}, ${toNullableText(finalDepartment)}, ${finalChecked}, now())
            ON CONFLICT (id) DO UPDATE
            SET name = EXCLUDED.name,
                position = EXCLUDED.position,
                department = EXCLUDED.department,
                checked_in = EXCLUDED.checked_in,
                updated_at = now()
          `;

          await tx`
            UPDATE employee_attendance
            SET employee_id = ${item.newId}
            WHERE employee_id = ${item.oldId}
          `;

          await tx`DELETE FROM employees WHERE id = ${item.oldId}`;
          promoted += 1;
        }

        if (inserts.length) {
          const columns = ['id', 'name', 'position', 'department', 'checked_in'];
          const paramsPerRow = columns.length;
          const placeholders = inserts
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

          const queryParams = inserts.flatMap(e => [
            e.id,
            e.name,
            toNullableText(e.position),
            toNullableText(e.department),
            e.checkedIn,
          ]);

          const insertedRows = await tx(query, queryParams);
          inserted = insertedRows.length;
          skipped += inserts.length - insertedRows.length;
        }
      });

      const rows = await sql`SELECT id, name, position, department, checked_in, FALSE AS attendance_recorded FROM employees ORDER BY name ASC`;
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          employees: rows.map(mapRow),
          inserted,
          skipped,
          updated,
          matchedByName,
          promoted,
        }),
      };
    }

    if (method === 'DELETE') {
      let parsedBody = {};
      if (event.body) {
        try {
          parsedBody = JSON.parse(event.body || '{}');
        } catch (error) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'El cuerpo de la solicitud no contiene JSON válido.' }),
          };
        }
      }
      
      let employeeId = '';
      if (parsedBody && parsedBody.employeeId !== undefined && parsedBody.employeeId !== null) {
        employeeId = String(parsedBody.employeeId).trim();
      } else if (qs.employeeId) {
        employeeId = String(qs.employeeId).trim();
      }

      if (employeeId) {
        const rawDate = parsedBody && parsedBody.date ? String(parsedBody.date).trim() : String((qs.date || '').trim());
        const resolvedDate = rawDate ? resolveDateFromQuery(rawDate) : null;
        if (rawDate && !resolvedDate) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'El campo date es inválido. Usa el formato YYYY-MM-DD.' }),
          };
        }

        const deletedEmployees = await sql`
          DELETE FROM employees
          WHERE id = ${employeeId}
          RETURNING id
        `;

        if (!deletedEmployees.length) {
          return { statusCode: 404, headers, body: JSON.stringify({ error: 'Empleado no encontrado.' }) };
        }

        let rows;
        let hasAttendanceRecords = null;
        if (resolvedDate) {
          rows = await sql`
            SELECT
              e.id,
              e.name,
              e.position,
              e.department,
              COALESCE(a.checked_in, FALSE) AS checked_in,
              (a.employee_id IS NOT NULL) AS attendance_recorded
            FROM employees e
            LEFT JOIN employee_attendance a
              ON a.employee_id = e.id AND a.attendance_date = ${resolvedDate.key}
            ORDER BY e.name ASC
          `;
          hasAttendanceRecords = rows.some(row => row.attendance_recorded);
        } else {
          rows = await sql`SELECT id, name, position, department, checked_in, FALSE AS attendance_recorded FROM employees ORDER BY name ASC`;
        }

        const responseBody = {
          employees: rows.map(mapRow),
          removed: deletedEmployees.length,
        };

        if (resolvedDate) {
          responseBody.hasAttendanceRecords = hasAttendanceRecords;
          responseBody.date = resolvedDate.key;
        }

        return { statusCode: 200, headers, body: JSON.stringify(responseBody) };
      }

      let dateParam = String((qs.date || '').trim());
      if (!dateParam && parsedBody && parsedBody.date) {
        dateParam = String(parsedBody.date).trim();
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

      const rowsAfterDelete = await sql`SELECT id, name, position, department, checked_in, FALSE AS attendance_recorded FROM employees ORDER BY name ASC`;
      return { statusCode: 200, headers, body: JSON.stringify({ employees: rowsAfterDelete.map(mapRow), deleted: deletedRows.length }) };
    }

    if (method === 'PATCH') {
      let body;
      try {
        body = event.body ? JSON.parse(event.body) : {};
      } catch (error) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'El cuerpo de la solicitud no contiene JSON válido.' }),
        };
      }

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
