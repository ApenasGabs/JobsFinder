import { WhatsAppBot } from "../bot/whatsapp.js";
import {
  ScraperHealthInfo,
  ScraperRecentError,
  ScraperStatusType,
  SystemAlert,
  SystemHealthReport,
} from "../types.js";
import { LoggerService } from "./logger.js";
import { StorageService } from "./storage.js";

const DEFAULT_SOURCES = [
  { id: "GUPY", name: "Gupy" },
  { id: "INHIRE", name: "InHire" },
  { id: "ASHBY", name: "Ashby" },
  { id: "LEVER", name: "Lever" },
  { id: "GREENHOUSE", name: "Greenhouse" },
  { id: "WORKABLE", name: "Workable" },
  { id: "SOLIDES", name: "Sólides" },
  { id: "QUICKIN", name: "Quickin" },
  { id: "SMARTRECRUITERS", name: "SmartRecruiters" },
  { id: "REMOTEOK", name: "RemoteOK" },
  { id: "PROGRAMATHOR", name: "Programathor" },
  { id: "FREELAS_99", name: "99Freelas" },
  { id: "GEEKHUNTER", name: "GeekHunter" },
];

export class ScraperHealthService {
  private static scrapersMap: Map<string, ScraperHealthInfo> = new Map();
  private static isInitialized = false;

  public static initialize(): void {
    if (this.isInitialized) return;

    for (const src of DEFAULT_SOURCES) {
      this.scrapersMap.set(src.id, {
        id: src.id,
        name: src.name,
        status: "HEALTHY",
        lastRunAt: null,
        lastSuccessAt: null,
        lastJobsFound: 0,
        totalJobsCaptured: 0,
        consecutiveFailures: 0,
        consecutiveZeroRuns: 0,
        circuitBreakerOpen: false,
        circuitBreakerCooldownUntil: null,
        lastError: null,
        recentErrors: [],
      });
    }

    this.isInitialized = true;
  }

  private static getOrCreateScraper(
    id: string,
    name?: string,
  ): ScraperHealthInfo {
    this.initialize();
    const upperId = id.toUpperCase();
    let info = this.scrapersMap.get(upperId);
    if (!info) {
      info = {
        id: upperId,
        name: name || upperId,
        status: "HEALTHY",
        lastRunAt: null,
        lastSuccessAt: null,
        lastJobsFound: 0,
        totalJobsCaptured: 0,
        consecutiveFailures: 0,
        consecutiveZeroRuns: 0,
        circuitBreakerOpen: false,
        circuitBreakerCooldownUntil: null,
        lastError: null,
        recentErrors: [],
      };
      this.scrapersMap.set(upperId, info);
    }
    return info;
  }

  /**
   * Verifica se o Circuit Breaker está ativo para a fonte.
   * Se o tempo de cooldown tiver expirado, reabre automaticamente em modo de teste (HALF-OPEN).
   */
  public static isCircuitOpen(scraperId: string): boolean {
    const info = this.getOrCreateScraper(scraperId);
    if (!info.circuitBreakerOpen) return false;

    if (info.circuitBreakerCooldownUntil) {
      const cooldownTime = new Date(info.circuitBreakerCooldownUntil).getTime();
      if (Date.now() >= cooldownTime) {
        // Cooldown expirou: reabre a fonte para nova tentativa
        info.circuitBreakerOpen = false;
        info.circuitBreakerCooldownUntil = null;
        info.status = "DEGRADED";
        console.log(
          `[CircuitBreaker] ⏳ Cooldown expirado para ${info.name}. Tentando reativação (HALF-OPEN)...`,
        );
        return false;
      }
    }

    return true;
  }

  /**
   * Aciona explicitamente o Circuit Breaker (ex: bloqueio Cloudflare ou erros consecutivos)
   */
  public static recordCircuitBreak(
    scraperId: string,
    reason: string,
    cooldownMs = 600000, // 10 minutos de cooldown padrão
  ): void {
    const info = this.getOrCreateScraper(scraperId);
    const cooldownUntil = new Date(Date.now() + cooldownMs).toISOString();

    info.circuitBreakerOpen = true;
    info.circuitBreakerCooldownUntil = cooldownUntil;
    info.status = "CIRCUIT_OPEN";

    const errorEntry: ScraperRecentError = {
      timestamp: new Date().toISOString(),
      message: `Circuit Breaker ativado (${(cooldownMs / 60000).toFixed(0)}m): ${reason}`,
    };
    info.lastError = errorEntry;
    info.recentErrors.unshift(errorEntry);
    if (info.recentErrors.length > 10) info.recentErrors.pop();

    LoggerService.warn(
      "CRAWLER",
      "SCRAPER_CIRCUIT_BREAK",
      `Circuit Breaker acionado para ${info.name}. Cooldown até ${cooldownUntil}: ${reason}`,
      { scraperId: info.id, cooldownUntil, reason },
    );
  }

  public static recordStart(scraperId: string, name?: string): void {
    const info = this.getOrCreateScraper(scraperId, name);
    info.lastRunAt = new Date().toISOString();
  }

  public static recordSuccess(
    scraperId: string,
    jobsFound: number,
    durationMs: number,
  ): void {
    const info = this.getOrCreateScraper(scraperId);
    const now = new Date().toISOString();

    info.lastSuccessAt = now;
    info.lastJobsFound = jobsFound;
    info.totalJobsCaptured += jobsFound;
    info.consecutiveFailures = 0;

    if (jobsFound === 0) {
      info.consecutiveZeroRuns++;
    } else {
      info.consecutiveZeroRuns = 0;
    }

    // Se estava em circuit breaker ou degradado, restaura para saudável
    info.circuitBreakerOpen = false;
    info.circuitBreakerCooldownUntil = null;
    info.status = info.consecutiveZeroRuns >= 5 ? "DEGRADED" : "HEALTHY";
  }

  public static recordFailure(
    scraperId: string,
    error: string,
    term?: string,
  ): void {
    const info = this.getOrCreateScraper(scraperId);
    info.consecutiveFailures++;

    const errorEntry: ScraperRecentError = {
      timestamp: new Date().toISOString(),
      message: error,
      term,
    };
    info.lastError = errorEntry;
    info.recentErrors.unshift(errorEntry);
    if (info.recentErrors.length > 10) info.recentErrors.pop();

    // Se acumular 3 falhas consecutivas, aciona o circuit breaker por 10 minutos
    if (info.consecutiveFailures >= 3 && !info.circuitBreakerOpen) {
      this.recordCircuitBreak(
        scraperId,
        `Acumulou ${info.consecutiveFailures} falhas consecutivas: ${error}`,
      );
    } else if (!info.circuitBreakerOpen) {
      info.status = "FAILING";
    }
  }

  public static recordTermError(
    scraperId: string,
    term: string,
    error: string,
  ): void {
    const info = this.getOrCreateScraper(scraperId);
    const errorEntry: ScraperRecentError = {
      timestamp: new Date().toISOString(),
      message: error,
      term,
    };
    info.lastError = errorEntry;
    info.recentErrors.unshift(errorEntry);
    if (info.recentErrors.length > 10) info.recentErrors.pop();

    if (info.status === "HEALTHY") {
      info.status = "DEGRADED";
    }
  }

  public static getAllScrapersHealth(): ScraperHealthInfo[] {
    this.initialize();
    return Array.from(this.scrapersMap.values()).map((s) => ({
      ...s,
      recentErrors: [...s.recentErrors],
    }));
  }

  /**
   * Avalia os 3 cenários de alertas do sistema:
   * 1. WhatsApp desconectado há muito tempo (>15min)
   * 2. Fonte sem vagas / falhando repetidamente / Circuit Breaker
   * 3. Falhas repetidas de sincronização do Supabase (>=3)
   */
  public static getActiveAlerts(): SystemAlert[] {
    this.initialize();
    const alerts: SystemAlert[] = [];
    const now = new Date().toISOString();

    // 1. Alerta WhatsApp
    const waStatus = WhatsAppBot.getStatus();
    if (waStatus.enabled && waStatus.status !== "connected") {
      const disconnectedSecs = waStatus.disconnectedSeconds || 0;
      // Alerta imediato de aviso e crítico se mais de 15 minutos (900s)
      const isCritical = disconnectedSecs >= 900;
      alerts.push({
        id: "alert-wa-disconnected",
        code: "WHATSAPP_DISCONNECTED",
        severity: isCritical ? "critical" : "warning",
        message:
          disconnectedSecs > 0
            ? `Bot do WhatsApp desconectado há ${(disconnectedSecs / 60).toFixed(0)} minuto(s). Notificações de vagas suspensas.`
            : `Bot do WhatsApp está desconectado. Notificações automáticas suspensas.`,
        detectedAt: waStatus.disconnectedSince || now,
        metadata: {
          disconnectedSeconds: disconnectedSecs,
          botNumber: waStatus.botNumber,
        },
      });
    }

    // 2. Alertas por Fonte de Vagas
    for (const scraper of this.scrapersMap.values()) {
      if (scraper.circuitBreakerOpen) {
        alerts.push({
          id: `alert-circuit-${scraper.id.toLowerCase()}`,
          code: "SOURCE_CIRCUIT_OPEN",
          severity: "warning",
          source: scraper.id,
          message: `Scraper ${scraper.name} com Circuit Breaker ativo até ${scraper.circuitBreakerCooldownUntil || "fim do cooldown"}.`,
          detectedAt: scraper.lastError?.timestamp || now,
          metadata: {
            cooldownUntil: scraper.circuitBreakerCooldownUntil,
            consecutiveFailures: scraper.consecutiveFailures,
          },
        });
      } else if (scraper.consecutiveFailures >= 3) {
        alerts.push({
          id: `alert-failing-${scraper.id.toLowerCase()}`,
          code: "SOURCE_FAILING",
          severity: "warning",
          source: scraper.id,
          message: `Scraper ${scraper.name} acumulou ${scraper.consecutiveFailures} falhas consecutivas.`,
          detectedAt: scraper.lastError?.timestamp || now,
          metadata: {
            consecutiveFailures: scraper.consecutiveFailures,
            lastError: scraper.lastError?.message,
          },
        });
      } else if (
        scraper.totalJobsCaptured > 0 &&
        scraper.consecutiveZeroRuns >= 5 &&
        scraper.lastSuccessAt &&
        Date.now() - new Date(scraper.lastSuccessAt).getTime() > 24 * 3600 * 1000
      ) {
        alerts.push({
          id: `alert-nojobs-${scraper.id.toLowerCase()}`,
          code: "SOURCE_NO_JOBS",
          severity: "warning",
          source: scraper.id,
          message: `Scraper ${scraper.name} não encontra nenhuma vaga nova há mais de 24 horas (${scraper.consecutiveZeroRuns} ciclos com 0 vagas).`,
          detectedAt: now,
          metadata: {
            consecutiveZeroRuns: scraper.consecutiveZeroRuns,
            lastSuccessAt: scraper.lastSuccessAt,
          },
        });
      }
    }

    // 3. Alertas do Supabase
    const supabaseStatus = StorageService.getSupabaseSyncStatus();
    if (supabaseStatus.isConfigured && supabaseStatus.consecutiveFailures >= 3) {
      const isCritical = supabaseStatus.consecutiveFailures >= 5;
      alerts.push({
        id: "alert-supabase-sync-failing",
        code: "SUPABASE_SYNC_FAILING",
        severity: isCritical ? "critical" : "warning",
        message: `Sincronização com Supabase falhou ${supabaseStatus.consecutiveFailures} vezes consecutivas (${supabaseStatus.pendingQueueSize} vagas represadas na fila).`,
        detectedAt: now,
        metadata: {
          consecutiveFailures: supabaseStatus.consecutiveFailures,
          pendingQueueSize: supabaseStatus.pendingQueueSize,
        },
      });
    }

    return alerts;
  }

  /**
   * Monta o relatório estruturado de integridade do sistema
   */
  public static getHealthReport(isScraping = false): SystemHealthReport {
    this.initialize();
    const mem = process.memoryUsage();
    const scrapers = this.getAllScrapersHealth();
    const alerts = this.getActiveAlerts();

    const hasCritical = alerts.some((a) => a.severity === "critical");
    const hasWarnings = alerts.length > 0;

    const systemStatus = hasCritical
      ? "unhealthy"
      : hasWarnings
        ? "degraded"
        : "healthy";
    const status = hasCritical ? "unhealthy" : hasWarnings ? "degraded" : "ok";

    const waStatus = WhatsAppBot.getStatus();
    const supabaseStatus = StorageService.getSupabaseSyncStatus();

    return {
      status,
      systemStatus,
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
      memoryUsageMB: {
        rss: Math.round(mem.rss / 1024 / 1024),
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
      },
      isScraping,
      whatsapp: {
        enabled: waStatus.enabled ?? false,
        status: waStatus.status,
        botNumber: waStatus.botNumber,
        disconnectedSince: waStatus.disconnectedSince || null,
        disconnectedSeconds: waStatus.disconnectedSeconds || 0,
        alert: alerts.some((a) => a.code === "WHATSAPP_DISCONNECTED"),
      },
      supabase: {
        isConfigured: supabaseStatus.isConfigured,
        consecutiveFailures: supabaseStatus.consecutiveFailures,
        pendingQueueSize: supabaseStatus.pendingQueueSize,
        isSyncing: supabaseStatus.isSyncing,
        alert: alerts.some((a) => a.code === "SUPABASE_SYNC_FAILING"),
      },
      scrapers: {
        total: scrapers.length,
        healthy: scrapers.filter((s) => s.status === "HEALTHY").length,
        degraded: scrapers.filter((s) => s.status === "DEGRADED").length,
        circuitOpen: scrapers.filter((s) => s.circuitBreakerOpen).length,
        sources: scrapers,
      },
      alerts,
    };
  }

  /**
   * Reseta os estados internos (utilitário para testes)
   */
  public static reset(): void {
    this.scrapersMap.clear();
    this.isInitialized = false;
    this.initialize();
  }
}
