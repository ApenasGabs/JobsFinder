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

interface GupyRawJob {
  id: number | string;
  name?: string;
  title?: string;
  type?: string;
  department?: string;
  careerPageUrl?: string;
  jobUrl?: string;
  workplaceType?: string;
  city?: string;
  state?: string;
  country?: string;
  publishedDate?: string;
  workplace?: {
    address?: {
      city?: string;
      state?: string;
      stateShortName?: string;
      country?: string;
    };
    workplaceType?: string;
  };
  description?: string;
}

export class GupyScraper implements BaseScraper {
  public readonly id = "GUPY";
  public readonly name = "Gupy (134 Empresas)";
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
    const companies = config.gupyCompanies.filter((c) => c.enabled !== false);
    const keywords = (options.keywords || [])
      .map((k) => k.toLowerCase().trim())
      .filter(Boolean);

    const foundJobs: Job[] = [];
    let completedCount = 0;
    const concurrency = options.concurrency || 10; // 10 conexões assíncronas paralelas

    await runWithConcurrency(companies, concurrency, async (company) => {
      try {
        const portalUrl = company.link
          ? company.link.replace(/\/$/, "")
          : `https://${company.slug}.gupy.io`;
        const response = await resilientFetch(portalUrl, {
          timeoutMs: 10000,
          maxRetries: 1,
          source: 'GUPY',
          headers: {
            "User-Agent":
              "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
          },
        });

        if (response.ok) {
          const html = await response.text();
          const nextDataMatch = html.match(
            /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/,
          );

          if (nextDataMatch) {
            const nextData = JSON.parse(nextDataMatch[1]);
            const jobsList: GupyRawJob[] =
              nextData.props?.pageProps?.jobs || [];

            for (const item of jobsList) {
              const title = item.title || item.name || "Vaga sem título";
              const textToMatch =
                `${title} ${item.department || ""} ${item.type || ""}`.toLowerCase();

              // Se houver filtro de palavra-chave, verifica se bate com algum dos termos
              if (keywords.length > 0) {
                const matches = keywords.some((k) => textToMatch.includes(k));
                if (!matches) continue;
              }

              let model: WorkModel = "NAO_INFORMADO";
              const wpType = item.workplace?.workplaceType?.toLowerCase();
              if (wpType === "remote") model = "REMOTO";
              else if (wpType === "hybrid") model = "HIBRIDO";
              else if (wpType === "on-site" || wpType === "onsite")
                model = "PRESENCIAL";
              else model = detectWorkModel(title);

              const addr = item.workplace?.address;
              const locationParts = [
                addr?.city,
                addr?.stateShortName || addr?.state,
                addr?.country || "Brasil",
              ].filter(Boolean);
              const location = locationParts.join(", ") || "Brasil";

              const contractType = detectContractType(
                item.type || title,
                "CLT",
              );
              const seniorityLevel = detectSeniority(title);
              let jobUrl = item.careerPageUrl || `${portalUrl}/jobs/${item.id}`;
              if (jobUrl.includes(".gupy.io/job/")) {
                jobUrl = jobUrl.replace("/job/", "/jobs/");
              }

              const stack = extractStack(`${title} ${item.department || ""}`);

              const jobData = {
                title,
                company: company.name,
                location,
                workModel: model,
                contractType,
                seniorityLevel,
                url: jobUrl,
                source: "GUPY",
                stack,
                description: `Departamento: ${item.department || "Geral"} | Tipo: ${item.type || "Efetivo"}`,
              };

              const { job, isNew } = StorageService.upsertJob(jobData);
              foundJobs.push(job);
              onJobFound(job, isNew);
            }
          }
        }
      } catch {
        // Ignora silenciosamente empresas individuais que podem falhar ou dar timeout
      }

      completedCount++;
      if (onProgress) {
        const percent = Math.round((completedCount / companies.length) * 100);
        onProgress({
          message: `Consultando Gupy: ${completedCount}/${companies.length} empresas`,
          currentCompany: company.name,
          percent,
        });
      }
    });

    return foundJobs;
  }
}
