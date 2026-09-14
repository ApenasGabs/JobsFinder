import cors from "cors";
import express, { Request, Response } from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { WhatsAppBot } from "./bot/whatsapp.js";
import { LightpandaEngine } from "./engines/lightpanda.js";
import { ScraperRegistry } from "./scrapers/base.js";
import { TechClassifierService } from "./services/classifier.js";
import { ConfigService } from "./services/config.js";
import { CrawlerService } from "./services/crawler.js";
import { LogCategory, LoggerService, LogLevel } from "./services/logger.js";
import { SchedulerService } from "./services/scheduler.js";
import { StorageService } from "./services/storage.js";
import {
  ContractType,
  ScrapeOptions,
  SeniorityLevel,
  WorkModel,
} from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DIST_DIR = path.resolve(__dirname, "../dist");

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;
const HOST = process.env.HOST || "0.0.0.0";

app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  }),
);
app.use(express.json());

// Inicializa os serviços
// Inicializa os serviços centrais
StorageService.initialize();
CrawlerService.initialize();
SchedulerService.initialize();

// Inicializa o Bot do WhatsApp se habilitado ou se configurado para conectar
WhatsAppBot.initialize().catch((err) => {
  console.warn(
    "[Server] WhatsApp Bot aguardando pareamento ou inicialização:",
    err,
  );
});

// 1. Health check & estatísticas de baixo consumo
app.get("/api/health", (_req: Request, res: Response) => {
  const mem = process.memoryUsage();
  res.json({
    status: "ok",
    uptimeSeconds: Math.round(process.uptime()),
    memoryUsageMB: {
      rss: Math.round(mem.rss / 1024 / 1024),
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
    },
    isScraping: CrawlerService.isScraping(),
  });
});

// 2. Configuração centralizada (Leitura e Atualização)
app.get("/api/config", (_req: Request, res: Response) => {
  res.json(ConfigService.getConfig());
});

app.put("/api/config", (req: Request, res: Response) => {
  try {
    const updated = ConfigService.updateConfig(req.body);
    // Reinicia o agendador se a frequência do cron mudou
    SchedulerService.initialize();
    res.json({ success: true, config: updated });
  } catch (err) {
    res.status(400).json({ error: "Erro ao atualizar configuração" });
  }
});

// 3. Listagem de fontes e status do Lightpanda
app.get("/api/sources", async (_req: Request, res: Response) => {
  const sources = ScraperRegistry.getAll().map((s) => ({
    id: s.id,
    name: s.name,
    type: s.type,
    isFastMode: s.isFastMode,
  }));

  const lightpanda = await LightpandaEngine.checkStatus();

  res.json({
    sources,
    lightpanda,
  });
});

// 4. Consulta de Vagas com Filtros e Paginação
app.get("/api/jobs", (req: Request, res: Response) => {
  const {
    search,
    source,
    workModel,
    seniority,
    contractType,
    notified,
    onlyTech,
    page,
    pageSize,
  } = req.query;

  const result = StorageService.getJobs({
    search: search ? String(search) : undefined,
    source: source ? String(source) : undefined,
    workModel: workModel ? (String(workModel) as WorkModel) : undefined,
    seniority: seniority ? (String(seniority) as SeniorityLevel) : undefined,
    contractType: contractType
      ? (String(contractType) as ContractType)
      : undefined,
    notified: notified ? String(notified) : undefined,
    onlyTech:
      onlyTech !== undefined ? onlyTech === "true" || onlyTech === "1" : false,
    page: page ? parseInt(String(page), 10) : 1,
    pageSize: pageSize ? parseInt(String(pageSize), 10) : 50,
  });

  res.json(result);
});

// Contagem de vagas pendentes de envio por categoria
app.get("/api/jobs/pending-count", (req: Request, res: Response) => {
  const { category } = req.query;
  const jobs = StorageService.getUnnotifiedJobs(
    category ? String(category) : undefined,
  );
  res.json({ count: jobs.length });
});

// Toggle manual de status de envio da vaga
app.patch("/api/jobs/:id/notified", (req: Request, res: Response) => {
  const { id } = req.params;
  const { notified } = req.body;
  const job = StorageService.toggleJobNotified(
    id,
    typeof notified === "boolean" ? notified : undefined,
  );
  if (!job) {
    return res.status(404).json({ error: "Vaga não encontrada" });
  }
  res.json({ success: true, job });
});

// Excluir vaga individual
app.delete("/api/jobs/:id", (req: Request, res: Response) => {
  const deleted = StorageService.deleteJob(req.params.id);
  res.json({ success: deleted });
});

// Expurgo em massa de vagas não-tech
app.post("/api/jobs/purge-non-tech", (_req: Request, res: Response) => {
  const result = StorageService.purgeNonTechJobs();
  res.json({ success: true, ...result });
});

// Curadoria humana de vagas (Feedback do usuário - USER priority)
app.post("/api/classifier/feedback", (req: Request, res: Response) => {
  const { jobId, title, isTech } = req.body;
  if (!title && !jobId) {
    return res.status(400).json({ error: "title ou jobId é obrigatório." });
  }

  if (jobId) {
    const result = StorageService.updateJobTechStatus(jobId, !!isTech);
    return res.json(result);
  }

  const feedback = TechClassifierService.recordUserFeedback(
    String(title),
    !!isTech,
  );
  res.json({ success: true, feedback });
});

// Estatísticas do classificador de tecnologia
app.get("/api/classifier/stats", (_req: Request, res: Response) => {
  res.json(TechClassifierService.getStats());
});

// 5. Limpeza de Vagas
app.delete("/api/jobs", (_req: Request, res: Response) => {
  StorageService.clear();
  res.json({ success: true, message: "Banco de dados de vagas limpo" });
});

// 6. Estatísticas
app.get("/api/stats", (_req: Request, res: Response) => {
  res.json(StorageService.getStats());
});

// 7. ROTAS DO BOT WHATSAPP (BAILEYS)
app.get("/api/whatsapp/status", (_req: Request, res: Response) => {
  res.json(WhatsAppBot.getStatus());
});

app.post("/api/whatsapp/config", (req: Request, res: Response) => {
  const { enabled, targetGroupJid, targetGroupName, targetCategories } =
    req.body;
  const current = ConfigService.getConfig();

  const updatedConfig = ConfigService.updateConfig({
    whatsapp: {
      enabled: enabled ?? current.whatsapp?.enabled ?? false,
      targetGroupJid: targetGroupJid ?? current.whatsapp?.targetGroupJid ?? "",
      targetGroupName:
        targetGroupName ?? current.whatsapp?.targetGroupName ?? "",
      targetCategories: targetCategories ??
        current.whatsapp?.targetCategories ?? ["TODAS"],
      batchSize: current.whatsapp?.batchSize ?? 3,
      batchIntervalMinutes: current.whatsapp?.batchIntervalMinutes ?? 5,
    },
  });

  res.json({ success: true, whatsapp: updatedConfig.whatsapp });
});

app.post("/api/whatsapp/dispatch", async (req: Request, res: Response) => {
  const { category } = req.body;
  const result = await WhatsAppBot.dispatchCategoryJobs(category || "TODAS");
  res.json(result);
});

app.get("/api/whatsapp/groups", async (req: Request, res: Response) => {
  const force = req.query.force === "true";
  const groups = await WhatsAppBot.getParticipatingGroups(force);
  res.json({ groups });
});

app.post("/api/whatsapp/test", async (_req: Request, res: Response) => {
  const result = await WhatsAppBot.sendTestMessage();
  res.json(result);
});

// 8. ROTAS DO AGENDADOR (SCHEDULER)
app.get("/api/scheduler/status", (_req: Request, res: Response) => {
  res.json(SchedulerService.getStatus());
});

app.post("/api/scheduler/trigger", async (_req: Request, res: Response) => {
  try {
    const result = await SchedulerService.runScrapeAndNotify();
    res.json({ success: true, result });
  } catch (err: any) {
    res
      .status(500)
      .json({ error: err?.message || "Erro ao disparar varredura agendada" });
  }
});

// 9. STREAMING EM TEMPO REAL VIA SERVER-SENT EVENTS (SSE)
app.get("/api/scrape/stream", async (req: Request, res: Response) => {
  // Configura cabeçalhos SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const sendEvent = (data: any) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  if (CrawlerService.isScraping()) {
    sendEvent({
      type: "error",
      message: "Já existe uma busca em andamento. Aguarde a conclusão.",
    });
    res.end();
    return;
  }

  const keywordsParam = req.query.keywords
    ? String(req.query.keywords)
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean)
    : [];
  const sourcesParam = req.query.sources
    ? String(req.query.sources)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  const config = ConfigService.getConfig();
  const keywords =
    keywordsParam.length > 0 ? keywordsParam : config.searchTerms;
  const sources =
    sourcesParam.length > 0
      ? sourcesParam
      : config.sources.filter((s) => s.enabled).map((s) => s.id);

  const options: ScrapeOptions = {
    keywords,
    sources,
    concurrency: 8,
  };

  // Keep-alive heartbeat para conexões longas
  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, 15000);

  try {
    await CrawlerService.executeScrape(options, (event) => {
      sendEvent(event);
    });
  } catch (err: any) {
    sendEvent({
      type: "error",
      message: err?.message || "Erro inesperado na busca",
    });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

// 8. Disparo síncrono/POST (alternativa ao SSE)
// 10. Disparo síncrono/POST (alternativa ao SSE)
app.post("/api/scrape", async (req: Request, res: Response) => {
  if (CrawlerService.isScraping()) {
    res.status(409).json({ error: "Já existe uma busca em andamento." });
    return;
  }

  const { keywords, sources } = req.body;
  const config = ConfigService.getConfig();

  const options: ScrapeOptions = {
    keywords: keywords || config.searchTerms,
    sources:
      sources || config.sources.filter((s) => s.enabled).map((s) => s.id),
    concurrency: 8,
  };

  try {
    const result = await CrawlerService.executeScrape(options, () => {});
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Erro ao executar crawler" });
  }
});

// 11. ROTAS DE AUDITORIA E TELEMETRIA (LOGS)
app.get("/api/logs", (req: Request, res: Response) => {
  const { category, level, search, limit, since } = req.query;
  const logs = LoggerService.getLogs({
    category: category ? (String(category) as LogCategory) : undefined,
    level: level ? (String(level) as LogLevel) : undefined,
    search: search ? String(search) : undefined,
    limit: limit ? parseInt(String(limit), 10) : 100,
    since: since ? String(since) : undefined,
  });
  const stats = LoggerService.getStats();
  res.json({ logs, stats });
});

app.get("/api/logs/stats", (_req: Request, res: Response) => {
  res.json(LoggerService.getStats());
});

app.get("/api/logs/export", (_req: Request, res: Response) => {
  const logs = LoggerService.exportLogs();
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="s-job-crawler-logs.json"',
  );
  res.setHeader("Content-Type", "application/json");
  res.json(logs);
});

app.delete("/api/logs", (_req: Request, res: Response) => {
  LoggerService.clearLogs();
  res.json({ success: true, message: "Logs limpos com sucesso" });
});

// Serve o frontend React compilado se existir a pasta dist/
if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
  app.use((req: Request, res: Response, next) => {
    if (req.path.startsWith("/api")) return next();
    res.sendFile(path.join(DIST_DIR, "index.html"));
  });
}

app.listen(PORT, HOST, () => {
  console.log(`====================================================`);
  console.log(`🚀 S-Job-Crawler Engine rodando em http://${HOST}:${PORT}`);
  console.log(`📡 SSE Stream: http://${HOST}:${PORT}/api/scrape/stream`);
  console.log(`⚙️  Configuração: http://${HOST}:${PORT}/api/config`);
  console.log(`📊 Estatísticas: http://${HOST}:${PORT}/api/stats`);
  console.log(`🤖 WhatsApp Bot: http://${HOST}:${PORT}/api/whatsapp/status`);
  console.log(`⏰ Scheduler 24/7 ativo`);
  console.log(`====================================================`);
});
