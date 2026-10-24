import { ConfigService } from "../services/config.js";
import { StorageService } from "../services/storage.js";
import { Job, ScrapeOptions, WorkModel } from "../types.js";
import {
  detectContractType,
  detectSeniority,
  detectWorkModel,
  extractStack,
} from "../utils/normalizer.js";
import { runWithConcurrency } from "../utils/pool.js";
import { resilientFetch } from "../utils/fetch.js";
import { BaseScraper } from "./base.js";

export class SolidesScraper implements BaseScraper {
  public readonly id = "SOLIDES";
  public readonly name = "Solides (Empresas BR)";
  public readonly type = "CLT" as const;
  public readonly isFastMode = true;

  public async scrape(
    options: ScrapeOptions,
    onJobFound: (job: Job, isNew?: boolean) => void,
    onProgress?: (progress: {
      message: string;
      currentCompany?: string;
      percent?: number;
    }) => void,
  ): Promise<Job[]> {
    const config = ConfigService.getConfig();
    const companies = ((config as any).solidesCompanies || []).filter(
      (c: any) => c.enabled !== false,
    );
    const keywords = (options.keywords || [])
      .map((k) => k.toLowerCase().trim())
      .filter(Boolean);

    const foundJobs: Job[] = [];
    let completedCount = 0;
    const concurrency = options.concurrency || 10;

    await runWithConcurrency(companies, concurrency, async (company) => {
      try {
        const apiUrl = `https://apigw.solides.com.br/jobs/v3/companies/${encodeURIComponent(company.slug)}/vacancies?take=50`;
        const response = await resilientFetch(apiUrl, {
          timeoutMs: 10000,
          maxRetries: 1,
          source: "SOLIDES",
          headers: {
            Accept: "application/json",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          },
        });

        if (!response.ok) return;

        const payload = await response.json();
        const rawVacancies: any[] = payload.data || [];

        for (const item of rawVacancies) {
          const title = (item.title || "").trim();
          if (!title) continue;

          const desc = item.description || "";
          const fullText = `${title} ${desc}`.toLowerCase();

          // Filtro por palavra-chave se especificado
          if (keywords.length > 0) {
            const matchesKeyword = keywords.some((kw) => fullText.includes(kw));
            if (!matchesKeyword) continue;
          }

          let workModel: WorkModel = "NAO_INFORMADO";
          if (item.homeOffice) {
            workModel = "REMOTO";
          } else if (item.jobType === "hibrido") {
            workModel = "HIBRIDO";
          } else if (item.jobType === "presencial") {
            workModel = "PRESENCIAL";
          } else {
            workModel = detectWorkModel(`${title} ${desc}`);
          }

          const city = item.city?.name || "";
          const state = item.state?.code || "";
          const location = city && state ? `${city} - ${state}` : (city || state || "Brasil");

          const jobUrl = `https://${company.slug}.vagas.solides.com.br/vaga/${item.id}`;

          const job: Job = {
            id: `solides_${item.id}`,
            title,
            company: company.name,
            location,
            workModel,
            contractType: detectContractType(
              item.recruitmentContractType?.[0]?.name || desc,
            ),
            seniorityLevel: detectSeniority(title),
            url: jobUrl,
            source: "SOLIDES",
            stack: extractStack(fullText),
            scrapedAt: new Date().toISOString(),
            description: desc,
          };

          const isNew = StorageService.saveJob(job);
          onJobFound(job, isNew);
          foundJobs.push(job);
        }
      } catch (err: any) {
        console.warn(`[SolidesScraper] Erro ao buscar vagas para ${company.name}:`, err.message);
      } finally {
        completedCount++;
        onProgress?.({
          message: `Processando Solides: ${company.name}`,
          currentCompany: company.name,
          percent: Math.round((completedCount / companies.length) * 100),
        });
      }
    });

    return foundJobs;
  }
}
