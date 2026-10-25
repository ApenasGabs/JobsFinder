import makeWASocket, {
  DisconnectReason,
  proto,
  useMultiFileAuthState,
  WASocket,
} from "@whiskeysockets/baileys";
import fs from "fs";
import path from "path";
import pino from "pino";
import qrcode from "qrcode";
import { fileURLToPath } from "url";
import { TechClassifierService } from "../services/classifier.js";
import { ConfigService } from "../services/config.js";
import { LoggerService } from "../services/logger.js";
import { StorageService } from "../services/storage.js";
import { SupabaseSyncService } from "../services/supabase.js";
import { Job, WhatsAppStatus } from "../types.js";
import {
  buildDigest,
  buildWeeklySummary,
  DEFAULT_RADAR_URL,
  DIGESTS,
  DigestKind,
  DigestResult,
  getDigestOptionsForKind,
  getDigestRuntimeConfig,
} from "./digest.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AUTH_DIR =
  process.env.AUTH_BAILEYS_DIR || path.resolve(__dirname, "../../auth_baileys");
const DATA_DIR =
  process.env.DATA_DIR || path.resolve(__dirname, "../../data");
const QUEUE_FILE = path.join(DATA_DIR, "whatsapp_queue.json");
const DIGEST_QUEUE_FILE = path.join(DATA_DIR, "whatsapp_digest_queue.json");
const DIGEST_STATE_FILE = path.join(DATA_DIR, "digest_state.json");

export interface QueuedDigestEnvelope {
  id: string;
  kind: DigestKind | "weekly" | "custom";
  slotKey: string;
  text: string;
  includedIds: string[];
  expiredIds: string[];
  targetGroupJid?: string;
  createdAt: string;
}

export interface CustomDigestFilterInput {
  seniorities?: string[];
  workModel?: string;
  contractType?: string;
  source?: string;
  search?: string;
  onlyUnsent?: boolean;
  maxAgeDays?: number;
  includeAbroad?: boolean;
  maxChars?: number;
  title?: string;
  emoji?: string;
  targetGroupJid?: string;
  customText?: string;
  markAsSent?: boolean;
}

// Silencia ruído de sessões e buffers de criptografia do libsignal no stdout
let isLibsignalSilenced = false;
function silenceLibsignalLogs(): void {
  if (isLibsignalSilenced) return;
  isLibsignalSilenced = true;
  const originalInfo = console.info;
  console.info = (...args: any[]) => {
    const msg = typeof args[0] === "string" ? args[0] : "";
    if (
      msg.includes("Closing session") ||
      msg.includes("Removing old closed session") ||
      msg.includes("Closing open session")
    ) {
      return;
    }
    originalInfo.apply(console, args);
  };
}

export class WhatsAppBot {
  private static sock: WASocket | null = null;
  private static status: "disconnected" | "connecting" | "connected" =
    "disconnected";
  private static qrCodeDataUrl: string | null = null;
  private static botNumber: string | null = null;
  private static isStarting = false;
  private static messageQueue: Job[] = [];
  private static digestQueue: QueuedDigestEnvelope[] = [];
  private static sentSlots: Record<string, string> = {};
  private static isProcessingQueue = false;
  private static nextBatchTimestamp: number | null = null;
  private static batchTimer: NodeJS.Timeout | null = null;
  private static reconnectAttempts = 0;
  private static reconnectTimeout: NodeJS.Timeout | null = null;
  private static hasRunColdStart = false;
  private static isQueueLoaded = false;
  private static disconnectedSince: number | null = Date.now();
  private static cachedGroups: Array<{
    id: string;
    subject: string;
    participants: number;
  }> = [];
  private static lastGroupsFetch = 0;

  public static async initialize(): Promise<void> {
    if (this.sock || this.isStarting) return;
    this.isStarting = true;

    // Ativa filtragem de ruído de criptografia do libsignal
    silenceLibsignalLogs();

    // Carrega fila persistida do disco uma única vez
    this.ensureQueueLoaded();

    try {
      if (!fs.existsSync(AUTH_DIR)) {
        fs.mkdirSync(AUTH_DIR, { recursive: true });
      }

      console.log(
        "[WhatsApp] Inicializando autenticação Baileys em:",
        AUTH_DIR,
      );
      const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

      this.status = "connecting";

      const sock = makeWASocket({
        auth: state,
        logger: pino({ level: "silent" }),
        printQRInTerminal: true,
        browser: ["QueroVagas Crawler", "Desktop", "1.0.0"],
      });

      this.sock = sock;

      sock.ev.on("creds.update", saveCreds);

      sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          try {
            this.qrCodeDataUrl = await qrcode.toDataURL(qr);
            console.log(
              "[WhatsApp] Novo QR Code gerado! Pronto para escanear no terminal ou painel web.",
            );
          } catch (err) {
            console.error(
              "[WhatsApp] Erro ao converter QR code em DataURL:",
              err,
            );
          }
        }

        if (connection === "close") {
          const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

          this.status = "disconnected";
          if (!this.disconnectedSince) {
            this.disconnectedSince = Date.now();
          }
          this.sock = null;
          this.qrCodeDataUrl = null;

          if (shouldReconnect) {
            this.reconnectAttempts++;
            // Jitter aleatório de até 3 segundos para evitar thundering herd
            const jitter = Math.floor(Math.random() * 3000);
            const delayMs = WhatsAppBot.calculateReconnectDelay(
              this.reconnectAttempts,
              jitter,
            );

            console.log(
              `[WhatsApp] Conexão encerrada (código: ${statusCode}). Reconectando (tentativa ${this.reconnectAttempts}) em ${(delayMs / 1000).toFixed(1)}s`,
            );
            LoggerService.warn(
              "WHATSAPP",
              "WA_DISCONNECTED",
              `Conexão encerrada (código: ${statusCode}). Reconectar em ${(delayMs / 1000).toFixed(1)}s (tentativa ${this.reconnectAttempts})`,
              { statusCode, reconnectAttempts: this.reconnectAttempts, delayMs },
            );

            if (this.reconnectTimeout) {
              clearTimeout(this.reconnectTimeout);
            }
            this.reconnectTimeout = setTimeout(() => {
              this.reconnectTimeout = null;
              this.initialize();
            }, delayMs);
          } else {
            console.log(
              `[WhatsApp] Conexão encerrada permanentemente (logout). Não haverá reconexão automática.`,
            );
            LoggerService.warn(
              "WHATSAPP",
              "WA_LOGGED_OUT",
              "Sessão encerrada por logout do WhatsApp. Necessário novo pareamento.",
              { statusCode },
            );
          }
        } else if (connection === "open") {
          this.status = "connected";
          this.qrCodeDataUrl = null;
          this.reconnectAttempts = 0;
          this.disconnectedSince = null;
          if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
          }

          const userJid = sock.user?.id || "";
          this.botNumber = userJid.split(":")[0] || userJid.split("@")[0];
          console.log(
            `[WhatsApp] ✅ Conectado com sucesso como: ${this.botNumber}`,
          );
          LoggerService.info(
            "WHATSAPP",
            "WA_CONNECTED",
            `Conectado com sucesso como +${this.botNumber}`,
            { botNumber: this.botNumber },
          );

          // Cold Start Protection: marca vagas anteriores apenas na primeira conexão real do processo
          if (!this.hasRunColdStart) {
            StorageService.markAllExistingAsNotified();
            this.hasRunColdStart = true;
            console.log(
              "[WhatsApp] 🛡️ Cold Start Protection executado na inicialização.",
            );
          }

          // Se houver mensagens ou vagas na fila restaurada do disco, retoma o envio
          if (
            (this.digestQueue.length > 0 || this.messageQueue.length > 0) &&
            !this.isProcessingQueue
          ) {
            console.log(
              `[WhatsApp] Retomando envio da fila persistida (${this.digestQueue.length} digest(s), ${this.messageQueue.length} vaga(s))...`,
            );
            this.processQueue();
          }
        }
      });

      // Listener de mensagens recebidas para comandos
      sock.ev.on("messages.upsert", async (m) => {
        if (m.type !== "notify") return;
        for (const msg of m.messages) {
          if (!msg.key.fromMe && msg.message) {
            await this.handleIncomingMessage(msg);
          }
        }
      });
    } catch (err) {
      console.error("[WhatsApp] Falha ao iniciar Baileys:", err);
      this.status = "disconnected";
    } finally {
      this.isStarting = false;
    }
  }

  private static resolveTargetGroupJid(): string {
    const runtimeCfg = getDigestRuntimeConfig();
    if (runtimeCfg.groupJidOverride) return runtimeCfg.groupJidOverride;
    const config = ConfigService.getConfig();
    return config.whatsapp?.targetGroupJid || "";
  }

  public static getStatus(): WhatsAppStatus {
    this.ensureQueueLoaded();
    const config = ConfigService.getConfig();
    return {
      status: this.status,
      botNumber: this.botNumber,
      qrCode: this.qrCodeDataUrl,
      enabled: config.whatsapp?.enabled ?? false,
      targetGroupJid: this.resolveTargetGroupJid(),
      targetGroupName: config.whatsapp?.targetGroupName || "",
      targetCategories: config.whatsapp?.targetCategories || ["TODAS"],
      queuePendingCount: this.messageQueue.length + this.digestQueue.length,
      isProcessingQueue: this.isProcessingQueue,
      nextBatchRemainingSeconds: this.nextBatchTimestamp
        ? Math.max(0, Math.round((this.nextBatchTimestamp - Date.now()) / 1000))
        : 0,
      disconnectedSince:
        this.status !== "connected" && this.disconnectedSince
          ? new Date(this.disconnectedSince).toISOString()
          : null,
      disconnectedSeconds:
        this.status !== "connected" && this.disconnectedSince
          ? Math.max(0, Math.round((Date.now() - this.disconnectedSince) / 1000))
          : 0,
    };
  }

  /**
   * Retorna os grupos em que o bot é participante para selecionar na UI
   * Usa cache em memória para evitar erro 'rate-overlimit' do WhatsApp
   */
  public static async getParticipatingGroups(
    forceRefresh = false,
  ): Promise<Array<{ id: string; subject: string; participants: number }>> {
    const config = ConfigService.getConfig();
    const configuredJid = this.resolveTargetGroupJid();
    const configuredName = config.whatsapp?.targetGroupName;

    if (!this.sock || this.status !== "connected") {
      if (this.cachedGroups.length === 0 && configuredJid) {
        return [
          {
            id: configuredJid,
            subject: configuredName || "Grupo Configurado",
            participants: 0,
          },
        ];
      }
      return this.cachedGroups;
    }

    const now = Date.now();
    // Cache de 3 minutos para evitar estourar o limite de requisições do WhatsApp
    if (
      !forceRefresh &&
      this.cachedGroups.length > 0 &&
      now - this.lastGroupsFetch < 180000
    ) {
      return this.cachedGroups;
    }

    // Se for forceRefresh, aplica um throttle de segurança de 10 segundos
    if (
      forceRefresh &&
      now - this.lastGroupsFetch < 10000 &&
      this.cachedGroups.length > 0
    ) {
      return this.cachedGroups;
    }

    try {
      const groups = await this.sock.groupFetchAllParticipating();
      this.cachedGroups = Object.values(groups).map((g) => ({
        id: g.id,
        subject: g.subject,
        participants: g.participants?.length || 0,
      }));
      this.lastGroupsFetch = now;
      return this.cachedGroups;
    } catch (err: any) {
      console.warn(
        "[WhatsApp] Aviso ao buscar grupos participantes:",
        err?.message || err,
      );
      // Se deu rate limit ou erro de rede, preserva o cache anterior em vez de zerar
      if (this.cachedGroups.length > 0) {
        return this.cachedGroups;
      }
      if (configuredJid) {
        return [
          {
            id: configuredJid,
            subject: configuredName || "Grupo Configurado",
            participants: 0,
          },
        ];
      }
      return [];
    }
  }

  /**
   * Envia uma notificação de teste para o grupo configurado
   */
  public static async sendTestMessage(): Promise<{
    success: boolean;
    message: string;
  }> {
    const target = this.resolveTargetGroupJid();

    if (!target) {
      return {
        success: false,
        message: "Nenhum grupo do WhatsApp configurado.",
      };
    }
    if (!this.sock || this.status !== "connected") {
      return {
        success: false,
        message: "Bot do WhatsApp não está conectado. Escaneie o QR Code.",
      };
    }

    const testText = `🤖 *Bot de Vagas* conectado com sucesso!\n\nEste grupo receberá digests agendados de vagas de TI (12h e 18h) e o resumo semanal aos domingos.`;
    await this.sock.sendMessage(target, { text: testText });
    return { success: true, message: "Mensagem de teste enviada com sucesso!" };
  }

  /**
   * O envio imediato foi substituído por digests agendados (12h e 18h).
   * As vagas coletadas ficam pendentes em StorageService (notifiedAt = null)
   * até o próximo digest.
   */
  public static async notifyNewJobs(newJobs: Job[]): Promise<number> {
    if (newJobs.length > 0) {
      console.log(
        `[WhatsApp] ${newJobs.length} nova(s) vaga(s) salva(s) como pendente(s) para o próximo digest agendado.`,
      );
    }
    return 0;
  }

  /**
   * Gera a chave de janela de disparo (ex: "entry:2026-10-23") no fuso configurado
   * para evitar reenvio caso o bot reinicie no mesmo horário/dia.
   */
  public static buildSlotKey(
    kind: DigestKind | "weekly" | "custom",
    now = new Date(),
  ): string {
    const tz = getDigestRuntimeConfig().timezone || "America/Sao_Paulo";
    const datePart = new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: tz,
    }).format(now);
    return `${kind}:${datePart}`;
  }

  public static hasSlotBeenSent(slotKey: string): boolean {
    this.ensureQueueLoaded();
    return Boolean(this.sentSlots[slotKey]);
  }

  public static markSlotSent(slotKey: string, now = new Date()): void {
    this.ensureQueueLoaded();
    this.sentSlots[slotKey] = now.toISOString();
    this.saveDigestStateToDisk();
  }

  /**
   * Executa o digest de uma categoria ('entry' ou 'senior').
   * Respeita regra do silêncio, deduplicação de janela (anti-restart spam) e DIGEST_DRY_RUN.
   */
  public static async runDigest(
    kind: DigestKind,
    opts?: { force?: boolean; now?: Date },
  ): Promise<{
    sent: boolean;
    dryRun?: boolean;
    skippedSlot?: boolean;
    slotKey: string;
    result: DigestResult | null;
  }> {
    this.ensureQueueLoaded();
    const now = opts?.now || new Date();
    const slotKey = this.buildSlotKey(kind, now);
    const runtimeCfg = getDigestRuntimeConfig();

    if (
      !opts?.force &&
      !runtimeCfg.dryRun &&
      (this.hasSlotBeenSent(slotKey) ||
        this.digestQueue.some((d) => d.slotKey === slotKey))
    ) {
      console.log(
        `[WhatsApp Digest] ⏭️ Digest "${kind}" (${slotKey}) já foi enviado ou enfileirado hoje. Ignorando duplicata.`,
      );
      return {
        sent: false,
        skippedSlot: true,
        slotKey,
        result: null,
      };
    }

    const { seniorities, options } = getDigestOptionsForKind(kind, now);
    const pending = StorageService.getUnsentJobs({ seniorities });

    // Verifica expiração mesmo se não atingir minJobs
    const cutoff =
      now.getTime() - (options.maxAgeDays ?? 5) * 24 * 60 * 60 * 1000;
    const preExpiredIds = pending
      .filter((j) => {
        const ts = new Date(j.scrapedAt).getTime();
        return !Number.isNaN(ts) && ts < cutoff;
      })
      .map((j) => j.id);

    const result = buildDigest(pending, options);

    if (!result) {
      if (!runtimeCfg.dryRun && preExpiredIds.length > 0) {
        StorageService.markExpired(preExpiredIds);
      }
      console.log(
        `[WhatsApp Digest] 🤫 Silêncio para "${kind}": menos vagas elegíveis que o mínimo (${options.minJobs}). Pendentes avaliadas: ${pending.length}.`,
      );
      LoggerService.info(
        "WHATSAPP",
        "WA_DIGEST_SKIPPED_MIN_JOBS",
        `Digest "${kind}" não enviado: menos vagas elegíveis que o mínimo (${options.minJobs})`,
        { kind, pendingCount: pending.length, minJobs: options.minJobs },
      );
      return {
        sent: false,
        slotKey,
        result: null,
      };
    }

    if (runtimeCfg.dryRun) {
      console.log(
        `\n[WhatsApp Digest][DRY_RUN] (${kind} | ${slotKey} | ${result.includedIds.length} vagas incluídas, ${result.omitted} omitidas, ${result.expiredIds.length} expiradas):\n${result.text}\n`,
      );
      LoggerService.info(
        "WHATSAPP",
        "WA_DIGEST_DRY_RUN",
        `[DRY_RUN] Digest "${kind}" gerado com ${result.includedIds.length} vagas (${result.text.length} chars)`,
        {
          kind,
          slotKey,
          includedCount: result.includedIds.length,
          omitted: result.omitted,
          expiredCount: result.expiredIds.length,
          textLength: result.text.length,
        },
      );
      return {
        sent: false,
        dryRun: true,
        slotKey,
        result,
      };
    }

    const envelope: QueuedDigestEnvelope = {
      id: `digest-${kind}-${Date.now()}`,
      kind,
      slotKey,
      text: result.text,
      includedIds: result.includedIds,
      expiredIds: result.expiredIds,
      createdAt: now.toISOString(),
    };

    this.enqueueDigestEnvelope(envelope);
    return {
      sent: true,
      slotKey,
      result,
    };
  }

  /**
   * Gera e enfileira o resumo semanal de domingo (~11h).
   */
  public static async runWeeklySummary(opts?: {
    force?: boolean;
    now?: Date;
  }): Promise<{
    sent: boolean;
    dryRun?: boolean;
    skippedSlot?: boolean;
    slotKey: string;
    text: string | null;
  }> {
    this.ensureQueueLoaded();
    const now = opts?.now || new Date();
    const slotKey = this.buildSlotKey("weekly", now);
    const runtimeCfg = getDigestRuntimeConfig();

    if (
      !opts?.force &&
      !runtimeCfg.dryRun &&
      (this.hasSlotBeenSent(slotKey) ||
        this.digestQueue.some((d) => d.slotKey === slotKey))
    ) {
      console.log(
        `[WhatsApp Weekly] ⏭️ Resumo semanal (${slotKey}) já enviado ou enfileirado hoje. Ignorando.`,
      );
      return {
        sent: false,
        skippedSlot: true,
        slotKey,
        text: null,
      };
    }

    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const config = ConfigService.getConfig();
    const localMonitoredCount = [
      ...(config.gupyCompanies || []),
      ...(config.inhireCompanies || []),
      ...(config.ashbyCompanies || []),
      ...(config.leverCompanies || []),
      ...(config.greenhouseCompanies || []),
      ...(config.workableCompanies || []),
      ...(config.solidesCompanies || []),
      ...(config.quickinCompanies || []),
      ...(config.smartrecruitersCompanies || []),
    ].filter((c) => c.enabled !== false).length;

    const supabaseStats =
      await SupabaseSyncService.fetchCommunityRadarStats(sevenDaysAgo);

    const monitoredCompaniesCount = Math.max(
      localMonitoredCount,
      supabaseStats.monitoredCompaniesCount ?? 0,
    );
    const weeklyTechJobsCount =
      StorageService.getTechJobsCountSince(sevenDaysAgo);

    const text = buildWeeklySummary({
      monitoredCompaniesCount:
        monitoredCompaniesCount > 0 ? monitoredCompaniesCount : null,
      weeklyTechJobsCount:
        weeklyTechJobsCount > 0 ? weeklyTechJobsCount : null,
      newSuggestions: supabaseStats.newSuggestions,
      topVotedSuggestions: supabaseStats.topVotedSuggestions,
      radarUrl: runtimeCfg.radarUrl,
      now,
    });

    if (!text) {
      console.log(
        "[WhatsApp Weekly] 🤫 Nenhum dado confiável disponível para o resumo semanal.",
      );
      return {
        sent: false,
        slotKey,
        text: null,
      };
    }

    if (runtimeCfg.dryRun) {
      console.log(`\n[WhatsApp Weekly][DRY_RUN] (${slotKey}):\n${text}\n`);
      LoggerService.info(
        "WHATSAPP",
        "WA_WEEKLY_DRY_RUN",
        `[DRY_RUN] Resumo semanal gerado (${text.length} chars)`,
        { slotKey, textLength: text.length },
      );
      return {
        sent: false,
        dryRun: true,
        slotKey,
        text,
      };
    }

    const envelope: QueuedDigestEnvelope = {
      id: `weekly-${Date.now()}`,
      kind: "weekly",
      slotKey,
      text,
      includedIds: [],
      expiredIds: [],
      createdAt: now.toISOString(),
    };

    this.enqueueDigestEnvelope(envelope);
    return {
      sent: true,
      slotKey,
      text,
    };
  }

  public static enqueueDigestEnvelope(envelope: QueuedDigestEnvelope): void {
    this.ensureQueueLoaded();
    if (
      envelope.slotKey &&
      this.digestQueue.some((d) => d.slotKey === envelope.slotKey)
    ) {
      return;
    }
    this.digestQueue.push(envelope);
    this.saveDigestQueueToDisk();
    LoggerService.info(
      "WHATSAPP",
      "WA_DIGEST_ENQUEUED",
      `Digest "${envelope.kind}" enfileirado como mensagem única (${envelope.includedIds.length} vagas)`,
      {
        id: envelope.id,
        kind: envelope.kind,
        slotKey: envelope.slotKey,
        includedCount: envelope.includedIds.length,
      },
    );

    if (!this.isProcessingQueue) {
      this.processQueue();
    }
  }

  /**
   * Adiciona vagas à fila sem duplicar e garantindo que sejam 100% de Tecnologia/TI
   */
  public static enqueueJobs(jobs: Job[]): number {
    this.ensureQueueLoaded();
    const existingIds = new Set(this.messageQueue.map((j) => j.id));
    let addedCount = 0;
    for (const job of jobs) {
      // Trava de segurança WhatsApp: descarta imediatamente se não for confirmada como TI
      if (
        job.isTech === false ||
        !TechClassifierService.isTechSync(job.title)
      ) {
        continue;
      }
      if (!existingIds.has(job.id)) {
        this.messageQueue.push(job);
        existingIds.add(job.id);
        addedCount++;
      }
    }

    if (addedCount > 0) {
      this.saveQueueToDisk();
      LoggerService.info(
        "WHATSAPP",
        "WA_JOBS_ENQUEUED",
        `${addedCount} vaga(s) enfileirada(s) para disparo (Total na fila: ${this.messageQueue.length})`,
        { addedCount, queueTotal: this.messageQueue.length },
      );
    }

    if (addedCount > 0 && !this.isProcessingQueue) {
      this.processQueue();
    }
    return addedCount;
  }

  /**
   * Disparo manual de vagas por categoria (usa o formato de Digest único)
   */
  public static async dispatchCategoryJobs(
    category: string,
  ): Promise<{ enqueued: number; pendingTotal: number; message: string }> {
    const runtimeCfg = getDigestRuntimeConfig();
    if (!runtimeCfg.dryRun && (!this.sock || this.status !== "connected")) {
      return {
        enqueued: 0,
        pendingTotal: this.messageQueue.length + this.digestQueue.length,
        message: "Bot do WhatsApp desconectado. Conecte antes de disparar.",
      };
    }
    const target = this.resolveTargetGroupJid();
    if (!runtimeCfg.dryRun && !target) {
      return {
        enqueued: 0,
        pendingTotal: this.messageQueue.length + this.digestQueue.length,
        message: "Nenhum grupo de WhatsApp configurado para receber vagas.",
      };
    }

    const catUpper = (category || "TODAS").toUpperCase().trim();
    const kinds: DigestKind[] =
      catUpper === "ESTAGIO" || catUpper === "JUNIOR" || catUpper === "ENTRY"
        ? ["entry"]
        : catUpper === "PLENO" ||
            catUpper === "SENIOR" ||
            catUpper === "ESPECIALISTA"
          ? ["senior"]
          : ["entry", "senior"];

    let totalIncluded = 0;
    for (const k of kinds) {
      const res = await this.runDigest(k, { force: true });
      if (res.result) {
        totalIncluded += res.result.includedIds.length;
      }
    }

    if (totalIncluded === 0) {
      return {
        enqueued: 0,
        pendingTotal: this.messageQueue.length + this.digestQueue.length,
        message: `Nenhuma vaga elegível suficiente para compor o digest da categoria "${category}".`,
      };
    }

    return {
      enqueued: totalIncluded,
      pendingTotal: this.messageQueue.length + this.digestQueue.length,
      message: runtimeCfg.dryRun
        ? `[DRY_RUN] Digest gerado no log com ${totalIncluded} vagas!`
        : `Digest com ${totalIncluded} vagas enfileirado como mensagem única!`,
    };
  }

  /**
   * Gera o preview do digest customizado a partir da combinação de filtros selecionada na UI.
   */
  public static previewCustomDigest(input: CustomDigestFilterInput): {
    candidatesCount: number;
    totalCandidates: number;
    includedCount: number;
    text: string;
    includedIds: string[];
    omitted: number;
    expiredIds: string[];
    charCount: number;
    maxChars: number;
    headerTitle: string;
  } {
    const runtimeCfg = getDigestRuntimeConfig();
    const seniorities = Array.isArray(input.seniorities)
      ? (input.seniorities.filter(Boolean) as any[])
      : undefined;

    const maxAgeDays =
      typeof input.maxAgeDays === "number" && input.maxAgeDays > 0
        ? input.maxAgeDays
        : runtimeCfg.maxAgeDays;

    const candidates = StorageService.queryDigestCandidates({
      seniorities,
      workModel: input.workModel,
      contractType: input.contractType,
      source: input.source,
      search: input.search,
      onlyUnsent: input.onlyUnsent ?? true,
      maxAgeDays,
    });

    // Determina título e emoji inteligentes a partir das senioridades escolhidas
    const wantedSet = new Set((seniorities || []).map((s) => s.toUpperCase()));
    const isOnlyEntry =
      wantedSet.size > 0 &&
      Array.from(wantedSet).every((s) => s === "ESTAGIO" || s === "JUNIOR");
    const isOnlySenior =
      wantedSet.size > 0 &&
      Array.from(wantedSet).every(
        (s) =>
          s === "PLENO" ||
          s === "SENIOR" ||
          s === "ESPECIALISTA" ||
          s === "NAO_INFORMADO",
      );

    const defaultTitle = isOnlyEntry
      ? DIGESTS.entry.options.title
      : isOnlySenior
        ? DIGESTS.senior.options.title
        : "VAGAS DE TI SELECIONADAS";
    const defaultEmoji = isOnlyEntry ? "🎓" : "🚀";
    const headerTitle = input.title?.trim() || defaultTitle;

    const maxChars =
      typeof input.maxChars === "number" && input.maxChars >= 500
        ? input.maxChars
        : runtimeCfg.maxChars;

    const result = buildDigest(candidates, {
      title: headerTitle,
      emoji: input.emoji?.trim() || defaultEmoji,
      radarUrl: runtimeCfg.radarUrl,
      maxPerSection: runtimeCfg.maxPerSection,
      maxTotal: runtimeCfg.maxTotal,
      maxChars,
      includeAbroad: input.includeAbroad ?? runtimeCfg.includeAbroad,
      minJobs: 1,
      maxAgeDays,
    });

    if (!result) {
      return {
        candidatesCount: candidates.length,
        totalCandidates: candidates.length,
        includedCount: 0,
        text: "",
        includedIds: [],
        omitted: 0,
        expiredIds: [],
        charCount: 0,
        maxChars,
        headerTitle,
      };
    }

    return {
      candidatesCount: candidates.length,
      totalCandidates: candidates.length,
      includedCount: result.includedIds.length,
      text: result.text,
      includedIds: result.includedIds,
      omitted: result.omitted,
      expiredIds: result.expiredIds,
      charCount: result.text.length,
      maxChars,
      headerTitle,
    };
  }

  /**
   * Envia o digest customizado (do compositor da UI) para o grupo escolhido.
   */
  public static async sendCustomDigest(input: CustomDigestFilterInput): Promise<{
    success: boolean;
    dryRun?: boolean;
    includedCount: number;
    omitted: number;
    targetGroupJid: string;
    message: string;
  }> {
    const runtimeCfg = getDigestRuntimeConfig();
    const targetGroupJid =
      input.targetGroupJid?.trim() || this.resolveTargetGroupJid();

    if (!runtimeCfg.dryRun && (!this.sock || this.status !== "connected")) {
      return {
        success: false,
        includedCount: 0,
        omitted: 0,
        targetGroupJid,
        message: "Bot do WhatsApp desconectado. Conecte antes de enviar.",
      };
    }

    if (!runtimeCfg.dryRun && !targetGroupJid) {
      return {
        success: false,
        includedCount: 0,
        omitted: 0,
        targetGroupJid: "",
        message: "Selecione um grupo de destino no WhatsApp antes de enviar.",
      };
    }

    const preview = this.previewCustomDigest(input);
    const finalText = input.customText?.trim() || preview.text;

    if (!finalText || preview.includedIds.length === 0) {
      return {
        success: false,
        includedCount: 0,
        omitted: 0,
        targetGroupJid,
        message:
          "Nenhuma vaga elegível encontrada para os filtros selecionados.",
      };
    }

    if (runtimeCfg.dryRun) {
      console.log(
        `\n[WhatsApp Custom Digest][DRY_RUN] (target: ${targetGroupJid} | ${preview.includedIds.length} vagas):\n${finalText}\n`,
      );
      return {
        success: true,
        dryRun: true,
        includedCount: preview.includedIds.length,
        omitted: preview.omitted,
        targetGroupJid,
        message: `[DRY_RUN] Mensagem simulada no log com ${preview.includedIds.length} vagas!`,
      };
    }

    const envelope: QueuedDigestEnvelope = {
      id: `custom-${Date.now()}`,
      kind: "custom",
      slotKey: `custom:${Date.now()}`,
      text: finalText,
      includedIds: input.markAsSent === false ? [] : preview.includedIds,
      expiredIds: preview.expiredIds,
      targetGroupJid,
      createdAt: new Date().toISOString(),
    };

    this.enqueueDigestEnvelope(envelope);

    return {
      success: true,
      includedCount: preview.includedIds.length,
      omitted: preview.omitted,
      targetGroupJid,
      message: `Digest com ${preview.includedIds.length} vaga(s) enviado para a fila do grupo selecionado!`,
    };
  }

  /**
   * Processa a fila anti-spam enviando 1 mensagem por vez
   */
  private static async processQueue(): Promise<void> {
    if (
      this.isProcessingQueue ||
      (this.digestQueue.length === 0 && this.messageQueue.length === 0)
    ) {
      return;
    }
    this.isProcessingQueue = true;

    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    this.nextBatchTimestamp = null;

    const config = ConfigService.getConfig();
    const defaultTarget = this.resolveTargetGroupJid();
    const batchIntervalMinutes = config.whatsapp?.batchIntervalMinutes || 5;
    const intervalMs = batchIntervalMinutes * 60 * 1000;

    try {
      if (!this.sock || this.status !== "connected") {
        this.isProcessingQueue = false;
        return;
      }

      if (this.digestQueue.length > 0) {
        const envelope = this.digestQueue.shift()!;
        const target = envelope.targetGroupJid || defaultTarget;
        if (!target) {
          this.isProcessingQueue = false;
          return;
        }
        this.saveDigestQueueToDisk();

        console.log(
          `[WhatsApp] 📨 Enviando mensagem única de digest "${envelope.kind}" para ${target} (${envelope.includedIds.length} vagas)...`,
        );

        try {
          await this.sock.sendMessage(target, { text: envelope.text });
          if (envelope.includedIds.length > 0) {
            StorageService.markSent(envelope.includedIds);
          }
          if (envelope.expiredIds.length > 0) {
            StorageService.markExpired(envelope.expiredIds);
          }
          if (envelope.slotKey) {
            this.markSlotSent(envelope.slotKey);
          }
          console.log(
            `[WhatsApp] ✅ Digest "${envelope.kind}" enviado com sucesso (${envelope.includedIds.length} vagas marcadas como enviadas)!`,
          );
          LoggerService.info(
            "WHATSAPP",
            "WA_DIGEST_DISPATCHED",
            `Digest "${envelope.kind}" enviado com sucesso (${envelope.includedIds.length} vagas)`,
            {
              target,
              kind: envelope.kind,
              slotKey: envelope.slotKey,
              includedCount: envelope.includedIds.length,
              expiredCount: envelope.expiredIds.length,
            },
          );
        } catch (err: any) {
          console.error(
            `[WhatsApp] Erro ao enviar digest "${envelope.kind}":`,
            err?.message || err,
          );
          LoggerService.error(
            "WHATSAPP",
            "WA_DISPATCH_ERROR",
            `Erro ao enviar digest "${envelope.kind}": ${err?.message || err}`,
            {
              target,
              kind: envelope.kind,
              error: err?.message || String(err),
            },
          );
          this.digestQueue.unshift(envelope);
          this.saveDigestQueueToDisk();
        }
      } else if (this.messageQueue.length > 0) {
        if (!defaultTarget) {
          this.isProcessingQueue = false;
          return;
        }
        const queuedJobs = [...this.messageQueue];
        const runtimeCfg = getDigestRuntimeConfig();
        const digestRes = buildDigest(queuedJobs, {
          title: "VAGAS DE TI",
          emoji: "🚀",
          radarUrl: runtimeCfg.radarUrl,
          maxPerSection: runtimeCfg.maxPerSection,
          maxTotal: runtimeCfg.maxTotal,
          maxChars: runtimeCfg.maxChars,
          includeAbroad: runtimeCfg.includeAbroad,
          minJobs: 1,
          maxAgeDays: runtimeCfg.maxAgeDays,
        });

        if (!digestRes) {
          this.messageQueue = [];
          this.saveQueueToDisk();
        } else {
          const handledSet = new Set([
            ...digestRes.includedIds,
            ...digestRes.expiredIds,
          ]);
          const dispatchedJobs = this.messageQueue.filter((j) =>
            handledSet.has(j.id),
          );
          this.messageQueue = this.messageQueue.filter(
            (j) => !handledSet.has(j.id),
          );
          this.saveQueueToDisk();

          try {
            await this.sock.sendMessage(defaultTarget, { text: digestRes.text });
            StorageService.markSent(digestRes.includedIds);
            StorageService.markExpired(digestRes.expiredIds);
            LoggerService.info(
              "WHATSAPP",
              "WA_BATCH_DISPATCHED",
              `Digest consolidado da fila enviado com ${digestRes.includedIds.length} vaga(s)`,
              {
                target: defaultTarget,
                count: digestRes.includedIds.length,
                queueRemaining: this.messageQueue.length,
              },
            );
          } catch (err: any) {
            this.messageQueue.unshift(...dispatchedJobs);
            this.saveQueueToDisk();
          }
        }
      }

      if (this.digestQueue.length > 0 || this.messageQueue.length > 0) {
        this.nextBatchTimestamp = Date.now() + intervalMs;
        this.batchTimer = setTimeout(() => {
          this.isProcessingQueue = false;
          this.processQueue();
        }, intervalMs);
      } else {
        this.isProcessingQueue = false;
        this.nextBatchTimestamp = null;
      }
    } catch (err) {
      console.error("[WhatsApp] Erro ao processar fila de mensagens:", err);
      this.isProcessingQueue = false;
    }
  }

  /**
   * Formata um lote de vagas utilizando o novo builder de Digest limpo e sem ruído.
   */
  public static formatBatchJobMessage(
    jobs: Job[],
    categoryName?: string,
  ): string {
    if (!jobs || jobs.length === 0) return "";

    const catUpper = (categoryName || "").toUpperCase().trim();
    const isEntry =
      catUpper === "ESTAGIO" ||
      catUpper === "JUNIOR" ||
      catUpper === "ENTRY" ||
      jobs.every(
        (j) => j.seniorityLevel === "ESTAGIO" || j.seniorityLevel === "JUNIOR",
      );

    const preset = isEntry ? DIGESTS.entry.options : DIGESTS.senior.options;
    const runtimeCfg = getDigestRuntimeConfig();

    const result = buildDigest(jobs, {
      title: categoryName ? preset.title : "VAGAS DE TI",
      emoji: preset.emoji,
      radarUrl: runtimeCfg.radarUrl || DEFAULT_RADAR_URL,
      maxPerSection: runtimeCfg.maxPerSection,
      maxTotal: runtimeCfg.maxTotal,
      maxChars: runtimeCfg.maxChars,
      includeAbroad: runtimeCfg.includeAbroad,
      minJobs: 1,
      maxAgeDays: 36500,
    });

    return result ? result.text : "";
  }

  private static async handleIncomingMessage(
    msg: proto.IWebMessageInfo,
  ): Promise<void> {
    const text =
      msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
    const from = msg.key.remoteJid;
    if (!from || !text.startsWith("!")) return;

    const command = text.trim().toLowerCase();

    if (command === "!status") {
      const mem = process.memoryUsage();
      const stats = StorageService.getStats();
      const reply = [
        `🤖 *Status do Bot de Vagas*`,
        `📊 *Total de Vagas de TI salvas:* ${stats.totalJobs}`,
        `🏠 *Vagas Remotas:* ${stats.byModel?.REMOTO || 0}`,
        `🧠 *Consumo de RAM:* ${(mem.rss / 1024 / 1024).toFixed(1)} MB`,
        `✅ *Bot WhatsApp:* Operacional e monitorando!`,
      ].join("\n");

      await this.sock?.sendMessage(from, { text: reply });
    } else if (command === "!vagas") {
      const sample = StorageService.getJobs({ pageSize: 3, onlyTech: true });
      if (sample.jobs.length === 0) {
        await this.sock?.sendMessage(from, {
          text: "Nenhuma vaga cadastrada no momento.",
        });
        return;
      }
      const lines = ["📌 *Últimas vagas coletadas:*", ""];
      sample.jobs.forEach((j, i) => {
        const model =
          j.workModel && j.workModel !== "NAO_INFORMADO"
            ? ` [${j.workModel}]`
            : "";
        lines.push(`${i + 1}. *${j.title}* @ ${j.company}${model}`);
        lines.push(`   👉 ${j.url}`);
      });
      await this.sock?.sendMessage(from, { text: lines.join("\n") });
    }
  }

  /**
   * Garante que a fila persistida seja carregada do disco uma única vez
   */
  public static ensureQueueLoaded(): void {
    if (!this.isQueueLoaded) {
      this.loadQueueFromDisk();
      this.isQueueLoaded = true;
    }
  }

  /**
   * Calcula o delay com backoff exponencial para reconexão
   */
  public static calculateReconnectDelay(attempt: number, jitter = 0): number {
    const baseDelay = Math.min(
      300000,
      5000 * Math.pow(1.5, Math.min(attempt, 8)),
    );
    return Math.round(baseDelay + jitter);
  }

  /**
   * Persiste a fila de vagas em disco de forma segura e atômica
   */
  public static saveQueueToDisk(): void {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      const tmpPath = `${QUEUE_FILE}.tmp`;
      fs.writeFileSync(
        tmpPath,
        JSON.stringify(this.messageQueue, null, 2),
        "utf-8",
      );
      fs.renameSync(tmpPath, QUEUE_FILE);
    } catch (err: any) {
      console.error(
        "[WhatsApp] Erro ao salvar fila persistente em disco:",
        err?.message || err,
      );
    }
  }

  /**
   * Persiste a fila de digests em disco de forma segura e atômica
   */
  public static saveDigestQueueToDisk(): void {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      const tmpPath = `${DIGEST_QUEUE_FILE}.tmp`;
      fs.writeFileSync(
        tmpPath,
        JSON.stringify(this.digestQueue, null, 2),
        "utf-8",
      );
      fs.renameSync(tmpPath, DIGEST_QUEUE_FILE);
    } catch (err: any) {
      console.error(
        "[WhatsApp] Erro ao salvar fila de digests em disco:",
        err?.message || err,
      );
    }
  }

  /**
   * Persiste o histórico de slots de digest enviados para evitar duplicidade após restart
   */
  public static saveDigestStateToDisk(): void {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      const tmpPath = `${DIGEST_STATE_FILE}.tmp`;
      fs.writeFileSync(
        tmpPath,
        JSON.stringify(this.sentSlots, null, 2),
        "utf-8",
      );
      fs.renameSync(tmpPath, DIGEST_STATE_FILE);
    } catch (err: any) {
      console.error(
        "[WhatsApp] Erro ao salvar estado de digests em disco:",
        err?.message || err,
      );
    }
  }

  /**
   * Carrega a fila persistida do disco no boot
   */
  public static loadQueueFromDisk(): void {
    try {
      this.isQueueLoaded = true;
      if (fs.existsSync(QUEUE_FILE)) {
        const raw = fs.readFileSync(QUEUE_FILE, "utf-8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.messageQueue = parsed;
          console.log(
            `[WhatsApp] 📥 Fila persistente carregada do disco: ${this.messageQueue.length} vaga(s) pendente(s).`,
          );
        }
      }
      if (fs.existsSync(DIGEST_QUEUE_FILE)) {
        const rawDigest = fs.readFileSync(DIGEST_QUEUE_FILE, "utf-8");
        const parsedDigest = JSON.parse(rawDigest);
        if (Array.isArray(parsedDigest)) {
          this.digestQueue = parsedDigest;
        }
      }
      if (fs.existsSync(DIGEST_STATE_FILE)) {
        const rawState = fs.readFileSync(DIGEST_STATE_FILE, "utf-8");
        const parsedState = JSON.parse(rawState);
        if (parsedState && typeof parsedState === "object") {
          this.sentSlots = parsedState;
        }
      }
    } catch (err: any) {
      console.warn(
        "[WhatsApp] Falha ao carregar fila persistente do disco:",
        err?.message || err,
      );
      this.messageQueue = [];
    }
  }

  public static getReconnectAttempts(): number {
    return this.reconnectAttempts;
  }

  public static isColdStartExecuted(): boolean {
    return this.hasRunColdStart;
  }

  public static resetColdStart(): void {
    this.hasRunColdStart = false;
  }

  public static getQueue(): Job[] {
    this.ensureQueueLoaded();
    return [...this.messageQueue];
  }

  public static getDigestQueue(): QueuedDigestEnvelope[] {
    this.ensureQueueLoaded();
    return [...this.digestQueue];
  }

  public static clearQueue(): void {
    this.messageQueue = [];
    this.digestQueue = [];
    this.saveQueueToDisk();
    this.saveDigestQueueToDisk();
  }

  public static clearDigestState(): void {
    this.sentSlots = {};
    this.saveDigestStateToDisk();
  }

  public static setMockDisconnectedSince(ts: number | null): void {
    this.disconnectedSince = ts;
  }

  public static setMockStatus(
    status: "disconnected" | "connecting" | "connected",
  ): void {
    this.status = status;
  }
}
