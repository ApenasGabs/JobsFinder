import cron, { ScheduledTask } from "node-cron";
import { WhatsAppBot } from "../bot/whatsapp.js";
import { Job, ScrapeOptions } from "../types.js";
import { TechClassifierService } from "./classifier.js";
import { CompanyAuditorService } from "./company-auditor.js";
import { ConfigService } from "./config.js";
import { CrawlerService } from "./crawler.js";
import { LoggerService } from "./logger.js";

export class SchedulerService {
  private static task: ScheduledTask | null = null;
  private static auditTask: ScheduledTask | null = null;
  private static isRunningNow = false;
  private static lastRunAt: string | null = null;

  public static initialize(): void {
    const config = ConfigService.getConfig();
    const cronExpression =
      process.env.CRON_SCHEDULE ||
      config.scheduler?.cronSchedule ||
      "*/30 * * * *";
    const isEnabled = config.scheduler?.enabled ?? true;

    if (!isEnabled) {
      console.log(
        "[Scheduler] Agendador automático desativado na configuração.",
      );
      return;
    }

    if (this.task) {
      this.task.stop();
    }

    if (this.auditTask) {
      this.auditTask.stop();
    }

    console.log(
      `[Scheduler] ⏰ Agendador ativo com expressão cron: "${cronExpression}"`,
    );

    this.task = cron.schedule(cronExpression, async () => {
      console.log(
        `[Scheduler] 🔔 Disparando varredura periódica programada [${new Date().toISOString()}]`,
      );
      LoggerService.info(
        "SCHEDULER",
        "SCHEDULER_TRIGGER",
        "Disparo de varredura periódica programada pelo Scheduler 24/7",
      );
      await this.runScrapeAndNotify();
    });

    const auditCronExpression = process.env.AUDIT_CRON_SCHEDULE || "0 3 * * 0";
    console.log(
      `[Scheduler] 🔍 Auditoria semanal de ATS configurada com cron: "${auditCronExpression}"`,
    );
    this.auditTask = cron.schedule(auditCronExpression, async () => {
      console.log(
        `[Scheduler] 🔍 Disparando auditoria periódica agendada de empresas ATS [${new Date().toISOString()}]`,
      );
      try {
        await CompanyAuditorService.auditAll({ autoDisableBroken: true });
      } catch (err) {
        console.error("[Scheduler] Erro durante auditoria agendada de empresas:", err);
      }
    });
  }

  public static async runScrapeAndNotify(): Promise<{
    totalFound: number;
    newJobsCount: number;
  }> {
    if (this.isRunningNow || CrawlerService.isScraping()) {
      console.log(
        "[Scheduler] Uma busca já está em andamento. Pulando ciclo agendado.",
      );
      LoggerService.info(
        "SCHEDULER",
        "SCHEDULER_SKIPPED",
        "Varredura pulada pois outra busca já está em andamento",
      );
      return { totalFound: 0, newJobsCount: 0 };
    }

    this.isRunningNow = true;
    this.lastRunAt = new Date().toISOString();
    const newJobsMap = new Map<string, Job>();

    try {
      const config = ConfigService.getConfig();
      const options: ScrapeOptions = {
        keywords: config.searchTerms,
        sources: config.sources.filter((s) => s.enabled).map((s) => s.id),
        concurrency: 8,
      };

      const result = await CrawlerService.executeScrape(options, (event) => {
        // Coleta apenas as vagas genuinamente novas detectadas durante a varredura
        if (event.type === "job" && event.job && event.isNew) {
          // Trava de segurança: garante que é de TI e deduplica por ID
          if (
            event.job.isTech !== false &&
            TechClassifierService.isTechSync(event.job.title)
          ) {
            newJobsMap.set(event.job.id, event.job);
          }
        }
      });

      const newJobsCollected = Array.from(newJobsMap.values());

      console.log(
        `[Scheduler] Varredura concluída: ${result.totalFound} vagas no total, ${newJobsCollected.length} novas.`,
      );
      LoggerService.info(
        "SCHEDULER",
        "SCHEDULER_COMPLETED",
        `Varredura agendada concluída: ${result.totalFound} vagas no total, ${newJobsCollected.length} novas vagas de TI`,
        {
          totalFound: result.totalFound,
          newJobsCount: newJobsCollected.length,
        },
      );

      if (newJobsCollected.length > 0) {
        console.log(
          `[Scheduler] Despachando ${newJobsCollected.length} novas vagas para o Bot do WhatsApp...`,
        );
        const enqueued = await WhatsAppBot.notifyNewJobs(newJobsCollected);
        console.log(
          `[Scheduler] WhatsApp Bot enfileirou ${enqueued} de ${newJobsCollected.length} novas vagas para envio.`,
        );
      }

      // Atualiza timestamp da última execução
      ConfigService.updateConfig({
        scheduler: {
          enabled: config.scheduler?.enabled ?? true,
          cronSchedule: config.scheduler?.cronSchedule || "*/30 * * * *",
          lastRunAt: this.lastRunAt,
        },
      });

      return {
        totalFound: result.totalFound,
        newJobsCount: newJobsCollected.length,
      };
    } catch (err) {
      console.error("[Scheduler] Erro durante a varredura agendada:", err);
      return { totalFound: 0, newJobsCount: 0 };
    } finally {
      this.isRunningNow = false;
    }
  }

  public static getStatus() {
    const config = ConfigService.getConfig();
    return {
      enabled: config.scheduler?.enabled ?? true,
      cronSchedule: config.scheduler?.cronSchedule || "*/30 * * * *",
      lastRunAt: this.lastRunAt,
      isRunningNow: this.isRunningNow,
      isAuditing: CompanyAuditorService.isAuditing(),
      lastAuditReport: CompanyAuditorService.getLastReport(),
    };
  }

  public static stop(): void {
    if (this.task) {
      this.task.stop();
      this.task = null;
    }
    if (this.auditTask) {
      this.auditTask.stop();
      this.auditTask = null;
    }
  }
}
