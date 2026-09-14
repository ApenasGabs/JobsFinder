import cron, { ScheduledTask } from "node-cron";
import { WhatsAppBot } from "../bot/whatsapp.js";
import { Job, ScrapeOptions } from "../types.js";
import { ConfigService } from "./config.js";
import { CrawlerService } from "./crawler.js";
import { LoggerService } from "./logger.js";

export class SchedulerService {
  private static task: ScheduledTask | null = null;
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
    const newJobsCollected: Job[] = [];

    try {
      const config = ConfigService.getConfig();
      const options: ScrapeOptions = {
        keywords: config.searchTerms,
        sources: config.sources.filter((s) => s.enabled).map((s) => s.id),
        concurrency: 8,
      };

      const result = await CrawlerService.executeScrape(options, (event) => {
        // Coleta apenas as vagas novas detectadas durante a varredura
        if (event.type === "job" && event.job && !event.job.notifiedAt) {
          newJobsCollected.push(event.job);
        }
      });

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
        await WhatsAppBot.notifyNewJobs(newJobsCollected);
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
    };
  }
}
