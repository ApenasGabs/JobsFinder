import fs from "fs";
import path from "path";

export type LogCategory =
  | "CLASSIFIER"
  | "WHATSAPP"
  | "CRAWLER"
  | "SCHEDULER"
  | "STORAGE"
  | "USER_ACTION"
  | "SYSTEM";

export type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG";

export interface ActivityLog {
  id: string;
  timestamp: string;
  category: LogCategory;
  level: LogLevel;
  event: string;
  message: string;
  details?: Record<string, any>;
}

export interface LogFilter {
  category?: LogCategory | "ALL";
  level?: LogLevel | "ALL";
  search?: string;
  limit?: number;
  since?: string;
}

export class LoggerService {
  private static readonly MAX_RING_BUFFER = 1000;
  private static readonly RETENTION_DAYS = 14;
  private static ringBuffer: ActivityLog[] = [];
  private static logsDir: string = path.resolve(process.cwd(), "data", "logs");
  private static isInitialized = false;

  private static ensureInitialized() {
    if (this.isInitialized) return;
    try {
      if (!fs.existsSync(this.logsDir)) {
        fs.mkdirSync(this.logsDir, { recursive: true });
      }
      this.loadRecentLogsIntoBuffer();
      this.cleanOldLogFiles();
      this.isInitialized = true;
    } catch (err) {
      console.error(
        "[LoggerService] Erro ao inicializar diretório de logs:",
        err,
      );
    }
  }

  private static getTodayLogFilename(): string {
    const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
    return path.join(this.logsDir, `activity-${today}.jsonl`);
  }

  private static appendToFile(log: ActivityLog) {
    try {
      const filePath = this.getTodayLogFilename();
      const line = JSON.stringify(log) + "\n";
      fs.appendFileSync(filePath, line, "utf-8");
    } catch (err) {
      console.error("[LoggerService] Falha ao persistir log em disco:", err);
    }
  }

  private static loadRecentLogsIntoBuffer() {
    try {
      const filePath = this.getTodayLogFilename();
      if (!fs.existsSync(filePath)) return;

      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.trim().split("\n");
      const recent = lines
        .filter((l) => l.trim().length > 0)
        .slice(-this.MAX_RING_BUFFER)
        .map((l) => {
          try {
            return JSON.parse(l) as ActivityLog;
          } catch {
            return null;
          }
        })
        .filter((l): l is ActivityLog => l !== null);

      this.ringBuffer = recent;
    } catch (err) {
      console.error(
        "[LoggerService] Erro ao carregar logs recentes para buffer:",
        err,
      );
    }
  }

  private static cleanOldLogFiles() {
    try {
      if (!fs.existsSync(this.logsDir)) return;
      const files = fs.readdirSync(this.logsDir);
      const now = Date.now();
      const maxAgeMs = this.RETENTION_DAYS * 24 * 60 * 60 * 1000;

      for (const file of files) {
        if (!file.startsWith("activity-") || !file.endsWith(".jsonl")) continue;
        const filePath = path.join(this.logsDir, file);
        const stats = fs.statSync(filePath);
        if (now - stats.mtimeMs > maxAgeMs) {
          fs.unlinkSync(filePath);
          console.log(
            `[LoggerService] Arquivo de log antigo removido: ${file}`,
          );
        }
      }
    } catch (err) {
      console.error("[LoggerService] Erro na rotação de logs antigos:", err);
    }
  }

  public static log(
    category: LogCategory,
    level: LogLevel,
    event: string,
    message: string,
    details?: Record<string, any>,
  ): ActivityLog {
    this.ensureInitialized();

    const entry: ActivityLog = {
      id: `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
      timestamp: new Date().toISOString(),
      category,
      level,
      event,
      message,
      details: details ? this.sanitizeDetails(details) : undefined,
    };

    // 1. Manter no Ring Buffer em RAM
    this.ringBuffer.push(entry);
    if (this.ringBuffer.length > this.MAX_RING_BUFFER) {
      this.ringBuffer.shift();
    }

    // 2. Persistir no JSONL diário
    this.appendToFile(entry);

    // 3. Imprimir no console caso seja WARN ou ERROR para visibilidade padrão do Docker
    if (level === "ERROR") {
      console.error(`[${category}][${event}] ❌ ${message}`, details || "");
    } else if (level === "WARN") {
      console.warn(`[${category}][${event}] ⚠️ ${message}`, details || "");
    }

    return entry;
  }

  public static info(
    category: LogCategory,
    event: string,
    message: string,
    details?: Record<string, any>,
  ): ActivityLog {
    return this.log(category, "INFO", event, message, details);
  }

  public static warn(
    category: LogCategory,
    event: string,
    message: string,
    details?: Record<string, any>,
  ): ActivityLog {
    return this.log(category, "WARN", event, message, details);
  }

  public static error(
    category: LogCategory,
    event: string,
    message: string,
    details?: Record<string, any>,
  ): ActivityLog {
    return this.log(category, "ERROR", event, message, details);
  }

  public static debug(
    category: LogCategory,
    event: string,
    message: string,
    details?: Record<string, any>,
  ): ActivityLog {
    return this.log(category, "DEBUG", event, message, details);
  }

  public static getLogs(filter: LogFilter = {}): ActivityLog[] {
    this.ensureInitialized();
    const { category, level, search, limit = 100, since } = filter;

    let result = [...this.ringBuffer];

    // Se a busca for de algo antes do buffer atual, poderíamos carregar do arquivo,
    // mas o ring buffer com 1.000 itens cobre a esmagadora maioria das necessidades interativas.
    if (since) {
      const sinceDate = new Date(since).getTime();
      result = result.filter(
        (l) => new Date(l.timestamp).getTime() >= sinceDate,
      );
    }

    if (category && category !== "ALL") {
      result = result.filter((l) => l.category === category);
    }

    if (level && level !== "ALL") {
      result = result.filter((l) => l.level === level);
    }

    if (search && search.trim()) {
      const term = search.toLowerCase();
      result = result.filter(
        (l) =>
          l.message.toLowerCase().includes(term) ||
          l.event.toLowerCase().includes(term) ||
          (l.details && JSON.stringify(l.details).toLowerCase().includes(term)),
      );
    }

    // Ordenar decrescente (mais recentes primeiro)
    result.reverse();

    if (limit && limit > 0) {
      result = result.slice(0, limit);
    }

    return result;
  }

  public static getStats() {
    this.ensureInitialized();
    const total = this.ringBuffer.length;
    let errors = 0;
    let warnings = 0;
    const byCategory: Record<string, number> = {};

    for (const log of this.ringBuffer) {
      if (log.level === "ERROR") errors++;
      if (log.level === "WARN") warnings++;
      byCategory[log.category] = (byCategory[log.category] || 0) + 1;
    }

    return {
      total,
      errors,
      warnings,
      byCategory,
      logsDirectory: this.logsDir,
      retentionDays: this.RETENTION_DAYS,
    };
  }

  public static exportLogs(): ActivityLog[] {
    this.ensureInitialized();
    return [...this.ringBuffer].reverse();
  }

  public static clearLogs() {
    this.ringBuffer = [];
    try {
      const todayFile = this.getTodayLogFilename();
      if (fs.existsSync(todayFile)) {
        fs.writeFileSync(todayFile, "", "utf-8");
      }
    } catch (err) {
      console.error("[LoggerService] Erro ao limpar logs:", err);
    }
  }

  /**
   * Sanitiza detalhes para evitar gravar credenciais ou IPs sensíveis em arquivos de log
   */
  private static sanitizeDetails(
    details: Record<string, any>,
  ): Record<string, any> {
    try {
      const clean = { ...details };
      // Ocultar campos conhecidos de tokens ou credenciais
      const sensitiveKeys = [
        "password",
        "token",
        "secret",
        "auth",
        "creds",
        "authorization",
      ];
      for (const key of Object.keys(clean)) {
        if (sensitiveKeys.some((s) => key.toLowerCase().includes(s))) {
          clean[key] = "***REDACTED***";
        }
      }
      return clean;
    } catch {
      return details;
    }
  }
}
