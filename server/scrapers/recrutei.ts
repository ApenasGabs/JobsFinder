import { ConfigService } from "../services/config.js";
import { StorageService } from "../services/storage.js";
import {
  ContractType,
  Job,
  ScrapeOptions,
  SeniorityLevel,
  WorkModel,
} from "../types.js";
import { resilientFetch } from "../utils/fetch.js";
import {
  detectContractType,
  detectSeniority,
  detectWorkModel,
  extractStack,
} from "../utils/normalizer.js";
import { runWithConcurrency } from "../utils/pool.js";
import { BaseScraper } from "./base.js";

export interface RecruteiRawJob {
  id: number | string;
  title: string;
  slug?: string;
  public_link?: string;
  regime?: string;
  department?: string;
  company_name?: string;
  salary?: string;
  show_remuneration?: number | boolean;
  show_regime?: number | boolean;
  show_client?: number | boolean;
  location?: string[] | string;
  model?: string;
  description?: string;
  pcd?: boolean;
  is_inclusive?: number | boolean;
  client?: { name?: string } | string | null;
  isDisabled?: boolean;
}

export interface RecruteiDepartmentGroup {
  department?: string;
  total?: number;
  items?: RecruteiRawJob[];
}

export function normalizeRecruteiJob(
  item: RecruteiRawJob,
  company: { name: string; slug: string },
): Omit<Job, "id" | "scrapedAt"> | null {
  if (item.isDisabled === true) {
    return null;
  }

  const title = (item.title || "").trim();
  if (!title) {
    return null;
  }

  const slug = (company.slug || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/jobs\.recrutei\.com\.br\//i, "")
    .replace(/\/.*$/, "");

  const clientName =
    typeof item.client === "string"
      ? item.client.trim()
      : item.client?.name?.trim() || "";
  const companyName = (
    clientName ||
    item.company_name ||
    company.name ||
    "Recrutei"
  ).trim();

  let rawLocation = "";
  if (Array.isArray(item.location)) {
    const parts = item.location.map((p) => (p || "").trim()).filter(Boolean);
    if (parts.length >= 2) {
      rawLocation = `${parts[0]}, ${parts[1]}`;
    } else if (parts.length === 1) {
      rawLocation = parts[0];
    }
  } else if (typeof item.location === "string") {
    rawLocation = item.location.trim();
  }

  let model: WorkModel = detectWorkModel(
    `${title} ${item.model || ""} ${rawLocation} ${item.description || ""}`,
  );
  if (model === "NAO_INFORMADO" && rawLocation) {
    model = "PRESENCIAL";
  }

  let location = rawLocation || (model === "REMOTO" ? "Remoto" : "Brasil");
  if (
    model === "REMOTO" &&
    (!rawLocation || rawLocation.toLowerCase().includes("remoto"))
  ) {
    location = "Remoto";
  }

  const contractType: ContractType = detectContractType(
    `${item.regime || ""} ${title}`,
    "CLT",
  );
  const seniorityLevel: SeniorityLevel = detectSeniority(title);

  let salary: string | undefined;
  if (
    item.salary &&
    item.salary.trim() &&
    item.salary.trim().toLowerCase() !== "a combinar" &&
    item.show_remuneration !== 0 &&
    item.show_remuneration !== false
  ) {
    salary = item.salary.trim();
  }

  const dept = (item.department || "").trim();
  const cleanDescription = (item.description || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);

  const stack = extractStack(`${title} ${dept} ${cleanDescription}`);
  const jobUrl =
    item.public_link?.trim() ||
    `https://jobs.recrutei.com.br/${slug}/vacancy/${item.id}${item.slug ? `-${item.slug}` : ""}`;

  return {
    title,
    company: companyName,
    location,
    workModel: model,
    salary,
    contractType,
    seniorityLevel,
    url: jobUrl,
    source: "RECRUTEI",
    stack,
    description:
      cleanDescription ||
      `Área: ${dept || "Geral"} | ATS: Recrutei | Empresa: ${companyName}`,
  };
}

export class RecruteiScraper implements BaseScraper {
  public readonly id = "RECRUTEI";
  public readonly name = "Recrutei ATS (Brasil)";
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
    const rawCompanies: Array<{
      name: string;
      slug: string;
      link?: string;
      enabled?: boolean;
    }> = ((ConfigService.getConfig() as any).recruteiCompanies || []);

    const seenSlugs = new Set<string>();
    const companies = rawCompanies.filter((c) => {
      if (c.enabled === false) return false;
      const s = (c.slug || "")
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\/jobs\.recrutei\.com\.br\//i, "")
        .replace(/\/.*$/, "");
      if (!s || seenSlugs.has(s)) return false;
      seenSlugs.add(s);
      return true;
    });

    const keywords = (options.keywords || [])
      .map((k) => k.toLowerCase().trim())
      .filter(Boolean);

    const foundJobs: Job[] = [];
    let completedCount = 0;
    const concurrency = options.concurrency || 6;

    await runWithConcurrency(companies, concurrency, async (company) => {
      try {
        const cleanSlug = company.slug
          .trim()
          .toLowerCase()
          .replace(/^https?:\/\/jobs\.recrutei\.com\.br\//i, "")
          .replace(/\/.*$/, "");

        const apiUrl = `https://api.recrutei.com.br/api/v2/vacancies/per-departments/${encodeURIComponent(cleanSlug)}`;
        const response = await resilientFetch(apiUrl, {
          method: "POST",
          timeoutMs: 12000,
          maxRetries: 1,
          source: "RECRUTEI",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Origin: "https://jobs.recrutei.com.br",
            Referer: `https://jobs.recrutei.com.br/${cleanSlug}`,
            "User-Agent":
              "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          },
          body: JSON.stringify({}),
        });

        if (response.ok) {
          const payload = await response.json();
          const groupsOrItems: Array<RecruteiDepartmentGroup | RecruteiRawJob> =
            payload?.data?.vacancies || payload?.vacancies || [];

          const rawJobs: RecruteiRawJob[] = [];
          for (const entry of groupsOrItems) {
            if (
              entry &&
              typeof entry === "object" &&
              "items" in entry &&
              Array.isArray(entry.items)
            ) {
              for (const item of entry.items) {
                rawJobs.push({
                  ...item,
                  department: item.department || entry.department,
                });
              }
            } else if (entry && typeof entry === "object" && "title" in entry) {
              rawJobs.push(entry as RecruteiRawJob);
            }
          }

          for (const raw of rawJobs) {
            const normalized = normalizeRecruteiJob(raw, {
              name: company.name,
              slug: cleanSlug,
            });
            if (!normalized) continue;

            const textToMatch =
              `${normalized.title} ${normalized.location} ${normalized.stack.join(" ")}`.toLowerCase();
            if (keywords.length > 0) {
              const matches = keywords.some((k) => textToMatch.includes(k));
              if (!matches) continue;
            }

            const { job, isNew } = StorageService.upsertJob(normalized);
            foundJobs.push(job);
            onJobFound(job, isNew);
          }
        }
      } catch {
        // Ignora falhas isoladas de endpoints de empresas
      }

      completedCount++;
      if (onProgress && companies.length > 0) {
        const percent = Math.round((completedCount / companies.length) * 100);
        onProgress({
          message: `Consultando Recrutei: ${completedCount}/${companies.length} empresas`,
          currentCompany: company.name,
          percent,
        });
      }
    });

    return foundJobs;
  }
}
