import type { IncomingMessage, ServerResponse } from 'http';
import { readdir, stat, unlink, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import * as XLSX from 'xlsx';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';
import { getOpenClawConfigDir } from '../../utils/paths';

const DATABASE_EXTENSIONS = ['.db', '.sqlite', '.sqlite3'];
const MAX_ROWS_PER_QUERY = 1000;

function getDatabaseDir(): string {
  const customDir = process.env.DATABASE_FILE_DIR;
  if (customDir) return customDir;
  return join(getOpenClawConfigDir(), 'workspace', 'database_file');
}

interface ParsedFormData {
  fields: Record<string, string>;
  files: Array<{
    name: string;
    data: Buffer;
    mimeType: string;
  }>;
}

async function parseMultipartFormData(req: IncomingMessage): Promise<ParsedFormData> {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) {
      reject(new Error('No boundary found in Content-Type'));
      return;
    }
    const boundary = boundaryMatch[1];
    const chunks: Buffer[] = [];
    
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => {
      try {
        const buffer = Buffer.concat(chunks);
        const boundaryBuffer = Buffer.from(`--${boundary}`);
        const fields: Record<string, string> = {};
        const files: ParsedFormData['files'] = [];
        
        let start = 0;
        while (start < buffer.length) {
          const boundaryIndex = buffer.indexOf(boundaryBuffer, start);
          if (boundaryIndex === -1) break;
          
          const nextBoundaryIndex = buffer.indexOf(boundaryBuffer, boundaryIndex + boundaryBuffer.length);
          if (nextBoundaryIndex === -1) break;
          
          const part = buffer.subarray(boundaryIndex + boundaryBuffer.length, nextBoundaryIndex);
          const headerEndIndex = part.indexOf(Buffer.from('\r\n\r\n'));
          if (headerEndIndex === -1) {
            start = nextBoundaryIndex;
            continue;
          }
          
          const headers = part.subarray(0, headerEndIndex).toString('utf8');
          const body = part.subarray(headerEndIndex + 4, part.length - 2);
          
          const nameMatch = headers.match(/name="([^"]+)"/);
          const filenameMatch = headers.match(/filename="([^"]+)"/);
          const contentTypeMatch = headers.match(/Content-Type:\s*([^\r\n]+)/i);
          
          if (nameMatch) {
            const name = nameMatch[1];
            if (filenameMatch) {
              files.push({
                name: filenameMatch[1],
                data: body,
                mimeType: contentTypeMatch?.[1] || 'application/octet-stream',
              });
            } else {
              fields[name] = body.toString('utf8');
            }
          }
          
          start = nextBoundaryIndex;
        }
        
        resolve({ fields, files });
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

async function convertExcelToSqlite(
  excelPath: string,
  dbPath: string,
  tableName?: string
): Promise<{ success: boolean; error?: string; tables?: string[] }> {
  let sqlite: typeof import('node:sqlite');
  try {
    sqlite = await import('node:sqlite');
  } catch (importError) {
    return {
      success: false,
      error: `node:sqlite 模块不可用: ${importError instanceof Error ? importError.message : String(importError)}。请确保使用 Node.js 22+ 版本。`
    };
  }

  try {
    console.log('[Excel-Convert] Reading Excel file:', excelPath);
    const workbook = XLSX.readFile(excelPath);
    console.log('[Excel-Convert] Excel read success, sheets:', workbook.SheetNames.length);
    console.log('[Excel-Convert] Creating database:', dbPath);
    const db = new sqlite.DatabaseSync(dbPath);
    const createdTables: string[] = [];
    const usedTableNames = new Set<string>();

    for (const sheetName of workbook.SheetNames) {
      const worksheet = workbook.Sheets[sheetName];
      const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: null }) as unknown[][];

      if (!jsonData || jsonData.length === 0) {
        continue;
      }

      const headerRow = (jsonData[0] || []) as unknown[];
      const width = Math.max(
        headerRow.length,
        ...jsonData.slice(1).map((row) => (Array.isArray(row) ? row.length : 0)),
      );
      if (width <= 0) {
        continue;
      }

      const usedColumns = new Map<string, number>();
      const safeColumns = Array.from({ length: width }, (_, i) => {
        const raw = headerRow[i];
        let colName = (raw === null || raw === undefined || String(raw).trim() === '')
          ? `col_${i + 1}`
          : String(raw).trim();
        colName = colName.replace(/[^a-zA-Z0-9_一-龥]/g, '_');
        if (!colName) {
          colName = `col_${i + 1}`;
        }
        const seen = usedColumns.get(colName) ?? 0;
        usedColumns.set(colName, seen + 1);
        return seen === 0 ? colName : `${colName}_${seen}`;
      });

      let baseTable = tableName || sheetName.replace(/[^a-zA-Z0-9_]/g, '_');
      if (!baseTable || /^\d/.test(baseTable)) {
        baseTable = `table_${sheetName.replace(/[^a-zA-Z0-9_]/g, '_')}`;
      }
      let currentTable = baseTable;
      let tableSuffix = 1;
      while (usedTableNames.has(currentTable)) {
        currentTable = `${baseTable}_${tableSuffix++}`;
      }
      usedTableNames.add(currentTable);

      const columnDefs = safeColumns.map(col => `"${col}" TEXT`).join(', ');
      db.prepare(`CREATE TABLE IF NOT EXISTS "${currentTable}" (${columnDefs})`).run();

      const insertStmt = db.prepare(`INSERT INTO "${currentTable}" VALUES (${safeColumns.map(() => '?').join(', ')})`);
      for (let i = 1; i < jsonData.length; i++) {
        const row = (jsonData[i] || []) as unknown[];
        if (row.some(cell => cell !== null && cell !== undefined && String(cell).trim() !== '')) {
          const values = safeColumns.map((_, idx) => {
            const val = row[idx];
            return val === null || val === undefined ? null : String(val);
          });
          insertStmt.run(...values);
        }
      }

      createdTables.push(currentTable);
    }

    db.close();
    console.log('[Excel-Convert] Success! Created', createdTables.length, 'tables:', createdTables);
    console.log('[Excel-Convert] Database file:', dbPath);
    return { success: true, tables: createdTables };
  } catch (error) {
    console.error('[Excel-Convert] Conversion failed:', error);
    return {
      success: false,
      error: `Excel conversion failed: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

interface DatabaseFileInfo {
  name: string;
  path: string;
  size: number;
  modifiedAt: string;
}

async function listDatabaseFiles(dir: string): Promise<DatabaseFileInfo[]> {
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
    return [];
  }

  const files = await readdir(dir);
  const dbFiles: DatabaseFileInfo[] = [];

  for (const file of files) {
    const ext = extname(file).toLowerCase();
    if (!DATABASE_EXTENSIONS.includes(ext)) continue;

    const filePath = join(dir, file);
    const stats = await stat(filePath);

    if (stats.isFile()) {
      dbFiles.push({
        name: file,
        path: filePath,
        size: stats.size,
        modifiedAt: stats.mtime.toISOString(),
      });
    }
  }

  return dbFiles.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

async function getDatabaseTables(dbPath: string): Promise<{ tables: Array<{ name: string; rowCount: number; columns: string[] }>; error?: string }> {
  let sqlite: typeof import('node:sqlite');
  try {
    sqlite = await import('node:sqlite');
  } catch (importError) {
    return {
      tables: [],
      error: `node:sqlite 模块不可用: ${importError instanceof Error ? importError.message : String(importError)}。请确保使用 Node.js 22+ 版本。`
    };
  }

  let db: import('node:sqlite').DatabaseSync;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  } catch (openError) {
    return {
      tables: [],
      error: `无法打开数据库文件: ${openError instanceof Error ? openError.message : String(openError)}`
    };
  }

  try {
    const tables: Array<{ name: string; rowCount: number; columns: string[] }> = [];

    let tableRows: Array<{ name: string }>;
    try {
      tableRows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
    } catch (queryError) {
      return {
        tables: [],
        error: `查询表列表失败: ${queryError instanceof Error ? queryError.message : String(queryError)}`
      };
    }

    for (const { name } of tableRows) {
      try {
        const countResult = db.prepare(`SELECT COUNT(*) as count FROM "${name}"`).get() as { count: number } | undefined;
        
        const columnsResult = db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string }>;
        const columns = columnsResult.map((col) => col.name);

        tables.push({
          name,
          rowCount: countResult?.count ?? 0,
          columns,
        });
      } catch (tableError) {
        console.error(`Error processing table ${name}:`, tableError);
        tables.push({
          name,
          rowCount: 0,
          columns: [],
        });
      }
    }

    return { tables };
  } finally {
    db.close();
  }
}

async function queryTableData(
  dbPath: string,
  tableName: string,
  offset: number = 0,
  limit: number = MAX_ROWS_PER_QUERY
): Promise<{ columns: string[]; rows: Record<string, unknown>[]; totalRows: number; hasMore: boolean; error?: string }> {
  let sqlite: typeof import('node:sqlite');
  try {
    sqlite = await import('node:sqlite');
  } catch (importError) {
    return {
      columns: [],
      rows: [],
      totalRows: 0,
      hasMore: false,
      error: `node:sqlite 模块不可用: ${importError instanceof Error ? importError.message : String(importError)}`
    };
  }

  let db: import('node:sqlite').DatabaseSync;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  } catch (openError) {
    return {
      columns: [],
      rows: [],
      totalRows: 0,
      hasMore: false,
      error: `无法打开数据库文件: ${openError instanceof Error ? openError.message : String(openError)}`
    };
  }

  try {
    const countResult = db.prepare(`SELECT COUNT(*) as count FROM "${tableName}"`).get() as { count: number } | undefined;
    const totalRows = countResult?.count ?? 0;

    const columnsResult = db.prepare(`PRAGMA table_info("${tableName}")`).all() as Array<{ name: string }>;
    const columns = columnsResult.map((col) => col.name);

    const safeLimit = Math.min(Math.max(1, limit), MAX_ROWS_PER_QUERY);
    const safeOffset = Math.max(0, offset);

    const rows = db.prepare(`SELECT * FROM "${tableName}" LIMIT ? OFFSET ?`).all(safeLimit, safeOffset) as Record<string, unknown>[];

    return {
      columns,
      rows,
      totalRows,
      hasMore: safeOffset + rows.length < totalRows,
    };
  } finally {
    db.close();
  }
}

export async function handleDatabaseRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  _ctx: HostApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/databases/list' && req.method === 'GET') {
    try {
      const dbDir = getDatabaseDir();
      const databases = await listDatabaseFiles(dbDir);
      sendJson(res, 200, { databases });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/databases/detail' && req.method === 'GET') {
    try {
      const dbPath = url.searchParams.get('path');
      if (!dbPath) {
        sendJson(res, 400, { success: false, error: 'Missing path parameter' });
        return true;
      }

      if (!existsSync(dbPath)) {
        sendJson(res, 404, { success: false, error: 'Database file not found' });
        return true;
      }

      const stats = await stat(dbPath);
      const result = await getDatabaseTables(dbPath);

      sendJson(res, 200, {
        path: dbPath,
        size: stats.size,
        tables: result.tables,
        error: result.error,
      });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/databases/query' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{
        path: string;
        tableName: string;
        offset?: number;
        limit?: number;
      }>(req);

      if (!body.path || !body.tableName) {
        sendJson(res, 400, { success: false, error: 'Missing path or tableName parameter' });
        return true;
      }

      if (!existsSync(body.path)) {
        sendJson(res, 404, { success: false, error: 'Database file not found' });
        return true;
      }

      const result = await queryTableData(
        body.path,
        body.tableName,
        body.offset ?? 0,
        body.limit ?? MAX_ROWS_PER_QUERY
      );

      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/databases/delete' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ path: string }>(req);
      if (!body.path) {
        sendJson(res, 400, { success: false, error: 'Missing path parameter' });
        return true;
      }

      if (!existsSync(body.path)) {
        sendJson(res, 404, { success: false, error: 'Database file not found' });
        return true;
      }

      await unlink(body.path);
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/databases/upload' && req.method === 'POST') {
    try {
      const dbDir = getDatabaseDir();
      await mkdir(dbDir, { recursive: true });
      
      const formData = await parseMultipartFormData(req);
      const file = formData.files[0];
      
      if (!file) {
        sendJson(res, 400, { success: false, error: 'No file uploaded' });
        return true;
      }
      
      const ext = extname(file.name).toLowerCase();
      if (!DATABASE_EXTENSIONS.includes(ext)) {
        sendJson(res, 400, { success: false, error: 'Invalid file type. Only .db, .sqlite, .sqlite3 files are allowed.' });
        return true;
      }
      
      const targetPath = join(dbDir, file.name);
      await writeFile(targetPath, file.data);
      
      const stats = await stat(targetPath);
      sendJson(res, 200, {
        success: true,
        dbPath: targetPath,
        name: file.name,
        size: stats.size,
      });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/databases/convert-excel' && req.method === 'POST') {
    try {
      const dbDir = getDatabaseDir();
      console.log('[Excel-API] Database directory:', dbDir);
      await mkdir(dbDir, { recursive: true });

      console.log('[Excel-API] Parsing form data...');
      const formData = await parseMultipartFormData(req);
      console.log('[Excel-API] Form data parsed, files count:', formData.files.length);

      const file = formData.files[0];

      if (!file) {
        console.error('[Excel-API] No file uploaded');
        sendJson(res, 400, { success: false, error: 'No file uploaded' });
        return true;
      }

      console.log('[Excel-API] File received:', file.name, 'size:', file.data.length, 'bytes');

      const ext = extname(file.name).toLowerCase();
      if (ext !== '.xlsx' && ext !== '.xls') {
        console.error('[Excel-API] Invalid file type:', ext);
        sendJson(res, 400, { success: false, error: 'Invalid file type. Only .xlsx, .xls files are allowed.' });
        return true;
      }

      const tempExcelPath = join(tmpdir(), `excel_${randomUUID()}${ext}`);
      console.log('[Excel-API] Saving temp file to:', tempExcelPath);
      await writeFile(tempExcelPath, file.data);
      console.log('[Excel-API] Temp file saved successfully');

      const baseName = basename(file.name, ext);
      const dbPath = join(dbDir, `${baseName}.db`);
      console.log('[Excel-API] Target DB path:', dbPath);

      console.log('[Excel-API] Starting conversion...');
      const result = await convertExcelToSqlite(tempExcelPath, dbPath);
      console.log('[Excel-API] Conversion result:', result);
      
      try {
        await rm(tempExcelPath, { force: true });
      } catch {
        // ignore cleanup errors
      }
      
      if (result.success) {
        const stats = await stat(dbPath);
        sendJson(res, 200, {
          success: true,
          dbPath,
          name: `${baseName}.db`,
          size: stats.size,
          tables: result.tables,
        });
      } else {
        sendJson(res, 500, { success: false, error: result.error || 'Conversion failed' });
      }
    } catch (error) {
      console.error('[Excel-API] Error in convert-excel endpoint:', error);
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  return false;
}
