export type WorkModel = "REMOTO" | "HIBRIDO" | "PRESENCIAL" | "NAO_INFORMADO";

export type ContractType = "CLT" | "PJ" | "FREELANCER" | "ESTAGIO" | "OUTRO";

export type SeniorityLevel =
  | "ESTAGIO"
  | "JUNIOR"
  | "PLENO"
  | "SENIOR"
  | "ESPECIALISTA"
  | "NAO_INFORMADO";

export interface Job {
  id: string;
  title: string;
  company: string;
  location: string;
  workModel: WorkModel;
  salary?: string;
  contractType: ContractType;
  seniorityLevel: SeniorityLevel;
  url: string;
  source: string;
  stack: string[];
  scrapedAt: string;
  description?: string;
  notifiedAt?: string | null; // Data/hora em que a vaga foi enviada ao WhatsApp
  isTech?: boolean;
}

export interface ScrapeOptions {
  keywords: string[];
  sources: string[];
  contractType?: ContractType;
  seniority?: SeniorityLevel;
  companies?: string[]; // Para filtrar empresas da Gupy
  concurrency?: number;
}

export interface ScrapeProgressEvent {
  type: "start" | "progress" | "job" | "source_done" | "done" | "error";
  source?: string;
  job?: Job;
  isNew?: boolean;
  message?: string;
  totalFound?: number;
  currentCompany?: string;
  progressPercent?: number;
}

export interface WhatsAppConfig {
  enabled: boolean;
  targetGroupJid: string; // Ex: '120363xxxxxx@g.us'
  targetGroupName?: string;
  targetCategories?: string[]; // Ex: ['ESTAGIO', 'JUNIOR'] ou ['TODAS']
  batchSize?: number; // Ex: 3 vagas por bloco
  batchIntervalMinutes?: number; // Ex: 5 minutos entre blocos
}

export interface WhatsAppStatus {
  status: "disconnected" | "connecting" | "connected";
  botNumber: string | null;
  qrCode: string | null;
  enabled?: boolean;
  targetGroupJid?: string;
  targetGroupName?: string;
  targetCategories?: string[];
  queuePendingCount?: number;
  isProcessingQueue?: boolean;
  nextBatchRemainingSeconds?: number;
  disconnectedSince?: string | null;
  disconnectedSeconds?: number;
}

export type ScraperStatusType =
  | "HEALTHY"
  | "DEGRADED"
  | "CIRCUIT_OPEN"
  | "FAILING";

export interface ScraperRecentError {
  timestamp: string;
  message: string;
  term?: string;
}

export interface ScraperHealthInfo {
  id: string;
  name: string;
  status: ScraperStatusType;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastJobsFound: number;
  totalJobsCaptured: number;
  consecutiveFailures: number;
  consecutiveZeroRuns: number;
  circuitBreakerOpen: boolean;
  circuitBreakerCooldownUntil: string | null;
  lastError: ScraperRecentError | null;
  recentErrors: ScraperRecentError[];
}

export type AlertCode =
  | "WHATSAPP_DISCONNECTED"
  | "SOURCE_CIRCUIT_OPEN"
  | "SOURCE_FAILING"
  | "SOURCE_NO_JOBS"
  | "SUPABASE_SYNC_FAILING";

export interface SystemAlert {
  id: string;
  code: AlertCode;
  severity: "warning" | "critical";
  source?: string;
  message: string;
  detectedAt: string;
  metadata?: Record<string, any>;
}

export interface SystemHealthReport {
  status: "ok" | "degraded" | "unhealthy";
  systemStatus: "healthy" | "degraded" | "unhealthy";
  uptimeSeconds: number;
  timestamp: string;
  memoryUsageMB: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
  };
  isScraping: boolean;
  whatsapp: {
    enabled: boolean;
    status: string;
    botNumber: string | null;
    disconnectedSince: string | null;
    disconnectedSeconds: number;
    alert: boolean;
  };
  supabase: {
    isConfigured: boolean;
    consecutiveFailures: number;
    pendingQueueSize: number;
    isSyncing: boolean;
    alert: boolean;
  };
  scrapers: {
    total: number;
    healthy: number;
    degraded: number;
    circuitOpen: number;
    sources: ScraperHealthInfo[];
  };
  alerts: SystemAlert[];
}

export interface SchedulerConfig {
  enabled: boolean;
  cronSchedule: string; // Ex: '*/30 * * * *' (a cada 30 minutos)
  lastRunAt?: string;
}

export type CompanyAuditStatus = "OK" | "BROKEN" | "WARNING";

export interface CompanyAuditResult {
  ats: string;
  name: string;
  slug: string;
  link: string;
  status: CompanyAuditStatus;
  httpStatus?: number;
  error?: string;
  checkedUrl: string;
  jobsCount?: number;
  durationMs: number;
}

export interface CompanyAuditReport {
  timestamp: string;
  totalChecked: number;
  healthyCount: number;
  brokenCount: number;
  warningCount: number;
  durationMs: number;
  results: CompanyAuditResult[];
  autoDisabledCount?: number;
}

export interface CompanyConfig {
  name: string;
  link: string;
  slug: string;
  enabled: boolean;
  status?: "healthy" | "broken_link" | "unknown";
  lastAuditedAt?: string;
  lastAuditStatus?: number;
  lastAuditError?: string;
}

export interface AppConfig {
  searchTerms: string[];
  seniorityLevels: string[];
  contractTypes: string[];
  sources: Array<{
    id: string;
    name: string;
    type: string;
    enabled: boolean;
    fastMode: boolean;
  }>;
  gupyCompanies: CompanyConfig[];
  inhireCompanies?: CompanyConfig[];
  ashbyCompanies?: CompanyConfig[];
  leverCompanies?: CompanyConfig[];
  greenhouseCompanies?: CompanyConfig[];
  workableCompanies?: CompanyConfig[];
  whatsapp?: WhatsAppConfig;
  scheduler?: SchedulerConfig;
}
