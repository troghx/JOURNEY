import { neon } from '@neondatabase/serverless';

const connectionString = process.env.NEON_CONNECTION_STRING;
if (!connectionString) {
  console.warn('NEON_CONNECTION_STRING no está configurado. Las funciones no podrán conectarse a la base de datos.');
}

const sql = connectionString ? neon(connectionString) : null;
let ensurePromise = null;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS'
};

const mapRow = (row = {}) => ({
  id: row.id,
  name: row.name,
  position: row.position,
  department: row.department,
  checkedIn: row.checked_in
});

async function ensureTable() {
  if (!sql) throw new Error('No hay conexión a Neon.');
  if (!ensurePromise) {
    ensurePromise = sql`
      CREATE TABLE IF NOT EXISTS employees (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        position TEXT DEFAULT '',
        department TEXT DEFAULT '',
        checked_in BOOLEAN NOT NULL DEFAULT FALSE
      )
    `;
  }
  return ensurePromise;
}

function jsonResponse(statusCode, body = {}) {
  return {
    statusCode,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  };
}

export async function handler(event) {
  const { httpMethod } = event;

  if (httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: corsHeaders,
      body: ''
    };
  }

  try {
    await ensureTable();
  } catch (error) {
    console.error('Error asegurando la tabla:', error);
    return jsonResponse(500, { message: 'Error inicializando la base de datos.' });
  }

  try {
    if (httpMethod === 'GET') {
      const rows = await sql`SELECT id, name, position, department, checked_in FROM employees ORDER BY name`;
      return jsonResponse(200, { employees: rows.map(mapRow) });
    }

    if (httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const list = Array.isArray(body.employees) ? body.employees : [];
      const sanitized = list
        .map((emp = {}) => ({
          id: emp.id !== undefined && emp.id !== null ? String(emp.id).trim() : '',
          name: emp.name ? String(emp.name).trim() : '',
          position: emp.position ? String(emp.position).trim() : '',
          department: emp.department ? String(emp.department).trim() : '',
          checkedIn: Boolean(emp.checkedIn)
        }))
        .filter(emp => emp.id && emp.name);

      if (!sanitized.length) {
        const rows = await sql`SELECT id, name, position, department, checked_in FROM employees ORDER BY name`;
        return jsonResponse(200, { employees: rows.map(mapRow), inserted: 0, skipped: list.length });
      }

      const ids = sanitized.map(emp => emp.id);
      const existingRows = await sql`
        SELECT id FROM employees WHERE id = ANY (${sql.array(ids, 'text')})
      `;
      const existingIds = new Set(existingRows.map(row => row.id));
      const fresh = sanitized.filter(emp => !existingIds.has(emp.id));

      if (fresh.length) {
        const values = fresh.map(emp => [emp.id, emp.name, emp.position, emp.department, emp.checkedIn]);
        await sql`
          INSERT INTO employees (id, name, position, department, checked_in)
          VALUES ${sql(values)}
          ON CONFLICT (id) DO NOTHING
        `;
      }

      const rows = await sql`SELECT id, name, position, department, checked_in FROM employees ORDER BY name`;
      return jsonResponse(200, {
        employees: rows.map(mapRow),
        inserted: fresh.length,
        skipped: sanitized.length - fresh.length
      });
    }

    if (httpMethod === 'PATCH') {
      const body = JSON.parse(event.body || '{}');
      const id = body && body.id !== undefined && body.id !== null ? String(body.id).trim() : '';
      const checkedIn = typeof body.checkedIn === 'boolean' ? body.checkedIn : null;

      if (!id || checkedIn === null) {
        return jsonResponse(400, { message: 'Solicitud inválida. Se requiere ID y estado checkedIn.' });
      }

      const result = await sql`
        UPDATE employees
        SET checked_in = ${checkedIn}
        WHERE id = ${id}
        RETURNING id, name, position, department, checked_in
      `;

      if (!result.length) {
        return jsonResponse(404, { message: 'Empleado no encontrado.' });
      }

      return jsonResponse(200, { employee: mapRow(result[0]) });
    }

    return jsonResponse(405, { message: 'Método no permitido.' });
  } catch (error) {
    console.error('Error en la función employees:', error);
    return jsonResponse(500, { message: 'Error interno del servidor.' });
  }
}