import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Database,
  Upload,
  Table,
  Trash2,
  Eye,
  RefreshCw,
  FolderOpen,
  X,
  ChevronRight,
  FileText,
  HardDrive,
  ArrowLeft,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { hostApiFetch } from '@/lib/host-api';
import { invokeIpc } from '@/lib/api-client';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

interface DatabaseFile {
  name: string;
  path: string;
  size: number;
  modifiedAt: string;
}

interface TableInfo {
  name: string;
  rowCount: number;
  columns: string[];
}

interface DatabaseDetail {
  path: string;
  size: number;
  tables: TableInfo[];
  error?: string;
}

interface TableData {
  columns: string[];
  rows: Record<string, unknown>[];
  totalRows: number;
  hasMore: boolean;
  error?: string;
}

export function DataBase() {
  const { t } = useTranslation('database');
  const [databases, setDatabases] = useState<DatabaseFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDb, setSelectedDb] = useState<DatabaseDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [selectedTable, setSelectedTable] = useState<TableInfo | null>(null);
  const [tableData, setTableData] = useState<TableData | null>(null);
  const [tableDataLoading, setTableDataLoading] = useState(false);
  const [currentOffset, setCurrentOffset] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [converting, setConverting] = useState(false);

  const PAGE_SIZE = 100;

  const loadDatabases = useCallback(async () => {
    setLoading(true);
    try {
      const result = await hostApiFetch<{ databases: DatabaseFile[] }>('/api/databases/list');
      setDatabases(result.databases || []);
    } catch (error) {
      console.error('Failed to load databases:', error);
      toast.error(t('toast.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    loadDatabases();
  }, [loadDatabases]);

  const handleViewDatabase = async (dbPath: string) => {
    setSelectedTable(null);
    setTableData(null);
    setDetailLoading(true);
    try {
      const result = await hostApiFetch<DatabaseDetail>(`/api/databases/detail?path=${encodeURIComponent(dbPath)}`);
      setSelectedDb(result);
    } catch (error) {
      console.error('Failed to load database detail:', error);
      toast.error(t('toast.detailFailed'));
    } finally {
      setDetailLoading(false);
    }
  };

  const handleViewTable = async (table: TableInfo) => {
    if (!selectedDb) return;
    setSelectedTable(table);
    setCurrentOffset(0);
    setTableDataLoading(true);
    try {
      const result = await hostApiFetch<TableData>('/api/databases/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: selectedDb.path,
          tableName: table.name,
          offset: 0,
          limit: PAGE_SIZE,
        }),
      });
      setTableData(result);
    } catch (error) {
      console.error('Failed to load table data:', error);
      toast.error(t('toast.queryFailed'));
    } finally {
      setTableDataLoading(false);
    }
  };

  const handleLoadMore = async () => {
    if (!selectedDb || !selectedTable || !tableData) return;
    const nextOffset = currentOffset + PAGE_SIZE;
    setTableDataLoading(true);
    try {
      const result = await hostApiFetch<TableData>('/api/databases/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: selectedDb.path,
          tableName: selectedTable.name,
          offset: nextOffset,
          limit: PAGE_SIZE,
        }),
      });
      setTableData({
        ...result,
        rows: [...(tableData.rows ?? []), ...(result.rows ?? [])],
      });
      setCurrentOffset(nextOffset);
    } catch (error) {
      console.error('Failed to load more table data:', error);
      toast.error(t('toast.queryFailed'));
    } finally {
      setTableDataLoading(false);
    }
  };

  const handleBackToTables = () => {
    setSelectedTable(null);
    setTableData(null);
    setCurrentOffset(0);
  };

  const handleDeleteDatabase = async (dbPath: string) => {
    try {
      await hostApiFetch('/api/databases/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: dbPath }),
      });
      toast.success(t('toast.deleteSuccess'));
      loadDatabases();
      if (selectedDb?.path === dbPath) {
        setSelectedDb(null);
        setSelectedTable(null);
        setTableData(null);
      }
    } catch (error) {
      console.error('Failed to delete database:', error);
      toast.error(t('toast.deleteFailed'));
    }
  };

  const handleOpenFolder = async (dbPath: string) => {
    try {
      await invokeIpc('shell:showItemInFolder', dbPath);
    } catch (error) {
      console.error('Failed to open folder:', error);
      toast.error(t('toast.openFolderFailed'));
    }
  };

  const handleFileUpload = async (files: FileList) => {
    const file = files[0];
    if (!file) return;

    const isDb = file.name.endsWith('.db') || file.name.endsWith('.sqlite') || file.name.endsWith('.sqlite3');
    const isExcel = file.name.endsWith('.xlsx') || file.name.endsWith('.xls');

    if (!isDb && !isExcel) {
      toast.error(t('toast.invalidFileType'));
      return;
    }

    if (isDb) {
      setUploading(true);
      try {
        const formData = new FormData();
        formData.append('file', file);

        const token = await invokeIpc<string>('hostapi:token');
        const response = await fetch('http://127.0.0.1:13210/api/databases/upload', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
          },
          body: formData,
        });

        if (!response.ok) {
          let message = `Upload failed: ${response.statusText}`;
          try {
            const payload = await response.json() as { error?: string };
            if (payload?.error) message = payload.error;
          } catch {
            // ignore parse failure
          }
          throw new Error(message);
        }

        toast.success(t('toast.uploadSuccess'));
        loadDatabases();
      } catch (error) {
        console.error('Failed to upload database:', error);
        toast.error(t('toast.uploadFailed'));
      } finally {
        setUploading(false);
      }
    } else {
      setConverting(true);
      try {
        const formData = new FormData();
        formData.append('file', file);

        const token = await invokeIpc<string>('hostapi:token');
        const response = await fetch('http://127.0.0.1:13210/api/databases/convert-excel', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
          },
          body: formData,
        });

        if (!response.ok) {
          let message = `Upload failed: ${response.statusText}`;
          try {
            const payload = await response.json() as { error?: string };
            if (payload?.error) message = payload.error;
          } catch {
            // ignore parse failure
          }
          throw new Error(message);
        }

        const result = await response.json() as { dbPath: string };
        toast.success(t('toast.convertSuccess', { name: result.dbPath }));
        loadDatabases();
      } catch (error) {
        console.error('Failed to convert Excel:', error);
        toast.error(t('toast.convertFailed'));
      } finally {
        setConverting(false);
      }
    }
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  const formatDate = (dateStr: string): string => {
    try {
      return new Date(dateStr).toLocaleString();
    } catch {
      return dateStr;
    }
  };

  const formatCellValue = (value: unknown): string => {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  };

  return (
    <div data-testid="database-page" className="flex flex-col -m-6 dark:bg-background h-[calc(100vh-2.5rem)] overflow-hidden">
      <div className="w-full max-w-7xl mx-auto flex flex-col h-full p-10 pt-16">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-start justify-between mb-12 shrink-0 gap-4">
          <div>
            <h1 className="text-5xl md:text-6xl font-sans text-foreground mb-3 font-normal tracking-tight">
              {t('title')}
            </h1>
            <p className="text-[17px] text-foreground/70 font-medium">
              {t('subtitle')}
            </p>
          </div>
          <div className="flex items-center gap-3 md:mt-2">
            <Button
              variant="outline"
              className="rounded-xl border-black/10 dark:border-white/10"
              onClick={loadDatabases}
              disabled={loading}
            >
              <RefreshCw className={cn("h-4 w-4 mr-2", loading && "animate-spin")} />
              {t('actions.refresh')}
            </Button>
          </div>
        </div>

        {/* Upload Section - Compact */}
        <div className="mb-6 shrink-0">
          <input
            type="file"
            id="file-upload"
            className="hidden"
            accept=".db,.sqlite,.sqlite3,.xlsx,.xls"
            onChange={(e) => {
              if (e.target.files) {
                handleFileUpload(e.target.files);
              }
            }}
          />
          <label
            htmlFor="file-upload"
            className={cn(
              "inline-flex items-center gap-2 px-4 py-2 rounded-lg cursor-pointer transition-colors",
              "bg-primary/10 hover:bg-primary/20 text-primary",
              uploading && "opacity-50 cursor-wait"
            )}
          >
            {uploading || converting ? (
              <>
                <LoadingSpinner className="h-4 w-4" />
                <span className="text-sm font-medium">
                  {uploading ? t('upload.uploading') : t('upload.converting')}
                </span>
              </>
            ) : (
              <>
                <Upload className="h-4 w-4" />
                <span className="text-sm font-medium">{t('upload.title')}</span>
              </>
            )}
          </label>
          <p className="text-xs text-muted-foreground mt-1.5 ml-1">
            {t('upload.supportedTypes')}
          </p>
        </div>

        {/* Content Area */}
        <div className="flex-1 overflow-hidden flex gap-6 min-h-0">
          {/* Database List */}
          <div className="w-80 shrink-0 overflow-y-auto pr-2 -mr-2">
            <h2 className="text-xl font-medium text-foreground mb-4 flex items-center gap-2">
              <Database className="h-5 w-5" />
              {t('list.title')}
              <Badge variant="secondary" className="ml-2 font-sans">
                {databases.length}
              </Badge>
            </h2>

            {loading ? (
              <div className="flex items-center justify-center py-20">
                <LoadingSpinner className="h-8 w-8 text-primary" />
              </div>
            ) : databases.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-muted-foreground bg-black/5 dark:bg-white/5 rounded-3xl border border-transparent border-dashed">
                <Database className="h-12 w-12 mb-4 opacity-50" />
                <p className="text-sm">{t('list.empty')}</p>
              </div>
            ) : (
              <div className="space-y-3">
                {databases.map((db) => (
                  <Card
                    key={db.path}
                    className={cn(
                      "border-black/5 dark:border-white/5 bg-white dark:bg-card cursor-pointer transition-all",
                      "hover:border-primary/30 hover:shadow-sm",
                      selectedDb?.path === db.path && "border-primary/50 bg-primary/5"
                    )}
                    onClick={() => handleViewDatabase(db.path)}
                  >
                    <CardContent className="p-4">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                            <HardDrive className="h-5 w-5 text-primary" />
                          </div>
                          <div className="min-w-0">
                            <p className="font-medium text-foreground truncate">{db.name}</p>
                            <p className="text-xs text-muted-foreground flex items-center gap-2">
                              <span>{formatFileSize(db.size)}</span>
                              <span>•</span>
                              <span>{formatDate(db.modifiedAt)}</span>
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleOpenFolder(db.path);
                            }}
                            title={t('actions.openFolder')}
                          >
                            <FolderOpen className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-destructive hover:text-destructive"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteDatabase(db.path);
                            }}
                            title={t('actions.delete')}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                          <ChevronRight className="h-4 w-4 text-muted-foreground" />
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </div>

          {/* Right Panel - Tables or Table Data */}
          <div className="flex-1 overflow-hidden flex flex-col min-w-0">
            {selectedDb && !selectedTable && (
              <>
                <div className="flex items-center justify-between mb-4 shrink-0">
                  <h2 className="text-xl font-medium text-foreground flex items-center gap-2">
                    <Eye className="h-5 w-5" />
                    {t('detail.title')}
                  </h2>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => setSelectedDb(null)}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>

                {detailLoading ? (
                  <div className="flex items-center justify-center py-20">
                    <LoadingSpinner className="h-8 w-8 text-primary" />
                  </div>
                ) : (
                  <div className="overflow-y-auto flex-1">
                    <Card className="border-black/5 dark:border-white/5 mb-4">
                      <CardContent className="p-4">
                        <div className="flex items-center gap-3">
                          <FileText className="h-5 w-5 text-muted-foreground" />
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-foreground truncate">
                              {selectedDb.path.split('/').pop() || selectedDb.path.split('\\').pop()}
                            </p>
                            <p className="text-xs text-muted-foreground">{formatFileSize(selectedDb.size)}</p>
                          </div>
                        </div>
                      </CardContent>
                    </Card>

                    {selectedDb.error && (
                      <Card className="border-destructive/50 bg-destructive/5 mb-4">
                        <CardContent className="p-4">
                          <p className="text-sm text-destructive">{selectedDb.error}</p>
                        </CardContent>
                      </Card>
                    )}

                    <div>
                      <h3 className="text-lg font-medium text-foreground mb-3 flex items-center gap-2">
                        <Table className="h-5 w-5" />
                        {t('detail.tables')}
                        <Badge variant="secondary" className="font-sans">
                          {selectedDb.tables.length}
                        </Badge>
                      </h3>

                      <div className="space-y-2">
                        {selectedDb.tables.map((table) => (
                          <Card
                            key={table.name}
                            className="border-black/5 dark:border-white/5 cursor-pointer hover:border-primary/30 transition-all"
                            onClick={() => handleViewTable(table)}
                          >
                            <CardContent className="p-4">
                              <div className="flex items-center justify-between">
                                <div>
                                  <p className="text-sm font-medium text-foreground">{table.name}</p>
                                  <p className="text-xs text-muted-foreground mt-1">
                                    {table.rowCount} {t('detail.rows')} • {table.columns.length} {t('detail.columns')}
                                  </p>
                                </div>
                                <div className="flex items-center gap-1">
                                  {table.columns.slice(0, 3).map((col) => (
                                    <Badge
                                      key={col}
                                      variant="secondary"
                                      className="font-sans text-[10px] px-1.5 py-0"
                                    >
                                      {col}
                                    </Badge>
                                  ))}
                                  {table.columns.length > 3 && (
                                    <Badge
                                      variant="secondary"
                                      className="font-sans text-[10px] px-1.5 py-0"
                                    >
                                      +{table.columns.length - 3}
                                    </Badge>
                                  )}
                                </div>
                              </div>
                            </CardContent>
                          </Card>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}

            {selectedDb && selectedTable && (
              <>
                <div className="flex items-center justify-between mb-4 shrink-0">
                  <div className="flex items-center gap-3">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={handleBackToTables}
                    >
                      <ArrowLeft className="h-4 w-4" />
                    </Button>
                    <h2 className="text-xl font-medium text-foreground flex items-center gap-2">
                      <Table className="h-5 w-5" />
                      {selectedTable.name}
                      <Badge variant="secondary" className="font-sans">
                        {tableData?.totalRows ?? selectedTable.rowCount} {t('detail.rows')}
                      </Badge>
                    </h2>
                  </div>
                </div>

                {tableDataLoading && !tableData && (
                  <div className="flex items-center justify-center py-20">
                    <LoadingSpinner className="h-8 w-8 text-primary" />
                  </div>
                )}

                {tableData?.error && (
                  <Card className="border-destructive/50 bg-destructive/5">
                    <CardContent className="p-4">
                      <p className="text-sm text-destructive">{tableData.error}</p>
                    </CardContent>
                  </Card>
                )}

                {tableData && tableData.columns && !tableDataLoading && (
                  <div className="flex-1 overflow-hidden flex flex-col">
                    <div className="overflow-x-auto flex-1 border border-black/5 dark:border-white/5 rounded-xl">
                      <table className="w-full text-sm">
                        <thead className="bg-muted sticky top-0">
                          <tr>
                            {tableData.columns.map((col) => (
                              <th
                                key={col}
                                className="px-4 py-3 text-left font-medium text-foreground whitespace-nowrap"
                              >
                                {col}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-black/5 dark:divide-white/5">
                          {(!tableData.rows || tableData.rows.length === 0) && (
                            <tr>
                              <td
                                colSpan={tableData.columns.length || 1}
                                className="px-4 py-8 text-center text-muted-foreground"
                              >
                                {t('detail.noData')}
                              </td>
                            </tr>
                          )}
                          {tableData.rows && tableData.rows.length > 0 && tableData.rows.map((row, idx) => (
                            <tr key={idx} className="hover:bg-black/[0.02] dark:hover:bg-white/[0.02]">
                              {tableData.columns.map((col) => (
                                <td
                                  key={col}
                                  className="px-4 py-2 text-muted-foreground whitespace-nowrap max-w-[200px] truncate"
                                  title={formatCellValue(row?.[col])}
                                >
                                  {formatCellValue(row?.[col])}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {tableData.hasMore && (
                      <div className="mt-4 flex justify-center">
                        <Button
                          variant="outline"
                          onClick={handleLoadMore}
                          disabled={tableDataLoading}
                          className="rounded-xl"
                        >
                          {tableDataLoading ? (
                            <>
                              <LoadingSpinner className="h-4 w-4 mr-2" />
                              {t('common:status.loading')}
                            </>
                          ) : (
                            <>
                              <ChevronRight className="h-4 w-4 mr-2" />
                              {t('common:actions.loadMore')} ({tableData.totalRows - (tableData.rows?.length ?? 0)} {t('detail.remaining')})
                            </>
                          )}
                        </Button>
                      </div>
                    )}

                    {tableData.rows && tableData.rows.length > 0 && !tableData.hasMore && (
                      <p className="mt-4 text-center text-sm text-muted-foreground">
                        {t('detail.allDataLoaded')}
                      </p>
                    )}
                  </div>
                )}
              </>
            )}

            {!selectedDb && (
              <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
                <Eye className="h-16 w-16 mb-4 opacity-30" />
                <p className="text-lg">{t('detail.selectDatabase')}</p>
                <p className="text-sm mt-2">{t('detail.selectDatabaseHint')}</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
