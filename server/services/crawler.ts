import { AshbyScraper } from "../scrapers/ashby.js";
import { ScraperRegistry } from "../scrapers/base.js";
import { Freelas99Scraper } from "../scrapers/freelas99.js";
import { GeekHunterScraper } from "../scrapers/geekhunter.js";
import { GreenhouseScraper } from "../scrapers/greenhouse.js";
import { GupyScraper } from "../scrapers/gupy.js";
import { InHireScraper } from "../scrapers/inhire.js";
import { LeverScraper } from "../scrapers/lever.js";
import { ProgramathorScraper } from "../scrapers/programathor.js";
import { RemoteOKScraper } from "../scrapers/remoteok.js";
import { WorkableScraper } from "../scrapers/workable.js";
import { Job, ScrapeOptions, ScrapeProgressEvent } from "../types.js";
import { TechClassifierService } from "./classifier.js";
import { LoggerService } from "./logger.js";
import { StorageService } from "./storage.js";

export class CrawlerService {
  private static isRegistered = false;
  private static isRunning = false;

  public static initialize(): void {
    if (this.isRegistered) return;

    ScraperRegistry.register(new GupyScraper());
    ScraperRegistry.register(new InHireScraper());
    ScraperRegistry.register(new AshbyScraper());
    ScraperRegistry.register(new LeverScraper());
    ScraperRegistry.register(new GreenhouseScraper());
    ScraperRegistry.register(new WorkableScraper());
    ScraperRegistry.register(new RemoteOKScraper());
    ScraperRegistry.register(new ProgramathorScraper());
    ScraperRegistry.register(new Freelas99Scraper());
    ScraperRegistry.register(new GeekHunterScraper());

    StorageService.initialize();
    this.isRegistered = true;
    console.log(
      "[CrawlerService] Todos os 10 scrapers registrados com sucesso.",
    );
  }

  public static isScraping(): boolean {
    return this.isRunning;
  }

  public static async executeScrape(
    options: ScrapeOptions,
    onProgress: (event: ScrapeProgressEvent) => void,
  ): Promise<{ totalFound: number; durationMs: number; jobs: Job[] }> {
    this.initialize();

    if (this.isRunning) {
      throw new Error("Uma busca já está em andamento. Aguarde a conclusão.");
    }

    this.isRunning = true;
    const startTime = Date.now();
    const collectedJobs: Job[] = [];

    onProgress({
      type: "start",
      message: "Iniciando varredura unificada de vagas...",
      totalFound: 0,
    });

    try {
      const selectedSources =
        options.sources && options.sources.length > 0
          ? options.sources.map((s) => s.toUpperCase())
          : [
              "GUPY",
              "INHIRE",
              "ASHBY",
              "LEVER",
              "GREENHOUSE",
              "WORKABLE",
              "REMOTEOK",
              "PROGRAMATHOR",
              "FREELAS_99",
              "GEEKHUNTER",
            ];

      const scrapers = selectedSources
        .map((s) => ScraperRegistry.get(s))
        .filter((s): s is NonNullable<typeof s> => Boolean(s));

      console.log(
        `[CrawlerService] Disparando ${scrapers.length} scrapers para os termos:`,
        options.keywords,
      );
      LoggerService.info(
        "CRAWLER",
        "CRAWL_STARTED",
        `Iniciando busca com ${scrapers.length} scrapers para ${options.keywords.length} termo(s)`,
        {
          scrapers: scrapers.map((s) => s.id),
          keywords: options.keywords,
        },
      );

      const scraperStats: Record<string, { jobs: number; durationMs: number; status: 'SUCCESS' | 'ERROR' }> = {};

      // Executa os scrapers selecionados em paralelo
      const promises = scrapers.map(async (scraper) => {
        const scraperStart = Date.now();
        try {
          onProgress({
            type: "progress",
            source: scraper.id,
            message: `Iniciando scraper: ${scraper.name}`,
          });

          const jobs = await scraper.scrape(
            options,
            (newJob) => {
              // Descarta vagas que não sejam de Tecnologia/TI
              if (
                newJob.isTech === false ||
                !TechClassifierService.isTechSync(newJob.title)
              ) {
                return;
              }
              newJob.isTech = true;
              collectedJobs.push(newJob);
              onProgress({
                type: "job",
                source: scraper.id,
                job: newJob,
                totalFound: collectedJobs.length,
              });
            },
            (progress) => {
              onProgress({
                type: "progress",
                source: scraper.id,
                message: progress.message,
                currentCompany: progress.currentCompany,
                progressPercent: progress.percent,
              });
            },
          );

          const scraperDuration = Date.now() - scraperStart;
          scraperStats[scraper.id] = {
            jobs: jobs.length,
            durationMs: scraperDuration,
            status: "SUCCESS",
          };

          onProgress({
            type: "source_done",
            source: scraper.id,
            message: `${scraper.name} concluído com ${jobs.length} vagas (${(scraperDuration / 1000).toFixed(1)}s).`,
          });

          return jobs;
        } catch (err) {
          const scraperDuration = Date.now() - scraperStart;
          scraperStats[scraper.id] = {
            jobs: 0,
            durationMs: scraperDuration,
            status: "ERROR",
          };

          console.error(`[CrawlerService] Erro no scraper ${scraper.id}:`, err);
          LoggerService.error(
            "CRAWLER",
            "SCRAPER_ERROR",
            `Falha no scraper ${scraper.name}: ${(err as any)?.message || err}`,
            {
              scraperId: scraper.id,
              error: (err as any)?.message || String(err),
              durationMs: scraperDuration,
            },
          );
          onProgress({
            type: "error",
            source: scraper.id,
            message: `Falha ao executar ${scraper.name}`,
          });
          return [];
        }
      });

      await Promise.all(promises);

      // Garante que tudo foi persistido em disco
      StorageService.flushToDisk();

      const durationMs = Date.now() - startTime;
      LoggerService.info(
        "CRAWLER",
        "CRAWL_COMPLETED",
        `Busca finalizada: ${collectedJobs.length} vagas de TI capturadas em ${(durationMs / 1000).toFixed(1)}s`,
        { totalFound: collectedJobs.length, durationMs, scrapers: scraperStats },
      );
      onProgress({
        type: "done",
        message: `Busca concluída em ${(durationMs / 1000).toFixed(1)}s! Total de ${collectedJobs.length} vagas encontradas.`,
        totalFound: collectedJobs.length,
      });

      return {
        totalFound: collectedJobs.length,
        durationMs,
        jobs: collectedJobs,
      };
    } finally {
      this.isRunning = false;
    }
  }
}
