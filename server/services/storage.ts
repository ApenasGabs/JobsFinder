import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ContractType, Job, SeniorityLevel, WorkModel } from "../types.js";
import { TechClassifierService } from "./classifier.js";
import { LoggerService } from "./logger.js";
import { SupabaseSyncService } from "./supabase.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, "../../data");
const DATA_FILE = path.join(DATA_DIR, "jobs.json");

export class StorageService {
  private static jobsMap: Map<string, Job> = new Map();
  private static isInitialized = false;
  private static saveTimeout: NodeJS.Timeout | null = null;

  public static initialize(): void {
    if (this.isInitialized) return;

    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }

      if (fs.existsSync(DATA_FILE)) {
        const content = fs.readFileSync(DATA_FILE, "utf-8");
        const jobs: Job[] = JSON.parse(content);
        let hasMigrated = false;
        for (const job of jobs) {
          if (job.url && job.url.includes(".gupy.io/job/")) {
            job.url = job.url.replace("/job/", "/jobs/");
            hasMigrated = true;
          }
          this.jobsMap.set(job.id, job);
        }
        if (hasMigrated) {
          this.scheduleSave();
        }
        console.log(
          `[Storage] Carregadas ${this.jobsMap.size} vagas do armazenamento local.`,
        );
      }
    } catch (err) {
      console.error("[Storage] Erro ao carregar vagas:", err);
    }
    this.isInitialized = true;
  }

  public static generateJobId(
    source: string,
    url: string,
    title: string,
    company: string,
  ): string {
    const normalizedUrl =
      url && url.includes(".gupy.io/job/")
        ? url.replace("/job/", "/jobs/")
        : url;
    const raw = `${source.toLowerCase()}:${normalizedUrl.trim() || `${company}:${title}`}`;
    return crypto.createHash("md5").update(raw).digest("hex");
  }

  public static upsertJob(jobData: Omit<Job, "id">): {
    job: Job;
    isNew: boolean;
  } {
    this.initialize();

    if (jobData.url && jobData.url.includes(".gupy.io/job/")) {
      jobData.url = jobData.url.replace("/job/", "/jobs/");
    }

    const id = this.generateJobId(
      jobData.source,
      jobData.url,
      jobData.title,
      jobData.company,
    );
    const existing = this.jobsMap.get(id);

    const isTech =
      jobData.isTech !== undefined
        ? jobData.isTech
        : TechClassifierService.isTechSync(jobData.title);

    if (!isTech) {
      // Descarta vagas comprovadamente fora da área de Tecnologia/TI
      return {
        job: { ...jobData, id, isTech: false } as Job,
        isNew: false,
      };
    }

    const job: Job = {
      ...jobData,
      id,
      isTech: true,
      scrapedAt: existing ? existing.scrapedAt : new Date().toISOString(),
      notifiedAt: existing?.notifiedAt ?? null,
    };

    const isNew = !existing;
    this.jobsMap.set(id, job);

    // Salva em disco de forma assíncrona apenas se for uma vaga realmente nova
    if (isNew) {
      this.scheduleSave();
    }

    // Sincroniza a vaga tech com o Supabase de forma assíncrona e não bloqueante
    if (job.isTech) {
      SupabaseSyncService.syncJob(job).catch((err) => {
        console.warn(
          "[Storage] Erro silencioso ao sincronizar vaga com Supabase:",
          err,
        );
      });
    }

    return { job, isNew };
  }

  public static deleteJob(jobId: string): boolean {
    this.initialize();
    const existing = this.jobsMap.get(jobId);
    const deleted = this.jobsMap.delete(jobId);
    if (deleted) {
      this.scheduleSave();
      LoggerService.info(
        "STORAGE",
        "JOB_DELETED",
        `Vaga removida: "${existing?.title || jobId}"`,
        { jobId, title: existing?.title, company: existing?.company },
      );
    }
    return deleted;
  }

  public static updateJobTechStatus(
    jobId: string,
    isTech: boolean,
  ): { success: boolean; job?: Job } {
    this.initialize();
    const job = this.jobsMap.get(jobId);
    if (!job) return { success: false };

    job.isTech = isTech;
    TechClassifierService.recordUserFeedback(job.title, isTech);

    if (!isTech) {
      // Se o usuário marcou como Não-TI, remove do banco ativo
      this.jobsMap.delete(jobId);
    }

    this.scheduleSave();
    return { success: true, job };
  }

  public static purgeNonTechJobs(): {
    purgedCount: number;
    remainingCount: number;
    purgedTitles: string[];
    backupFile?: string;
  } {
    this.initialize();

    let backupFile: string | undefined;
    try {
      backupFile = path.join(DATA_DIR, `jobs.backup.${Date.now()}.json`);
      fs.writeFileSync(
        backupFile,
        JSON.stringify(Array.from(this.jobsMap.values()), null, 2),
        "utf-8",
      );
      console.log(
        `[Storage] 🛡️ Backup prévio criado com sucesso em: ${backupFile}`,
      );
    } catch (err) {
      console.error("[Storage] Aviso ao criar backup prévio do purge:", err);
    }

    const purgedTitles: string[] = [];
    for (const [id, job] of this.jobsMap.entries()) {
      const isTech = TechClassifierService.isTechSync(job.title);
      if (!isTech) {
        purgedTitles.push(`${job.title} @ ${job.company}`);
        this.jobsMap.delete(id);
      } else {
        job.isTech = true;
      }
    }

    this.saveToDiskSync();
    console.log(
      `[Storage] 🧹 Purge concluído: ${purgedTitles.length} vagas não-tech removidas. Restam ${this.jobsMap.size} vagas ativas de TI.`,
    );
    LoggerService.info(
      "STORAGE",
      "PURGE_EXECUTED",
      `Expurgo concluído: ${purgedTitles.length} vagas não-TI removidas. Restam ${this.jobsMap.size} vagas ativas.`,
      {
        purgedCount: purgedTitles.length,
        remainingCount: this.jobsMap.size,
        backupFile,
      },
    );

    return {
      purgedCount: purgedTitles.length,
      remainingCount: this.jobsMap.size,
      purgedTitles: purgedTitles.slice(0, 50),
      backupFile,
    };
  }

  public static saveToDiskSync(): void {
    try {
      const list = Array.from(this.jobsMap.values());
      fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2), "utf-8");
    } catch (err) {
      console.error(
        "[Storage] Erro ao gravar dados em disco sincronicamente:",
        err,
      );
    }
  }

  public static markAsNotified(jobId: string): void {
    this.initialize();
    const job = this.jobsMap.get(jobId);
    if (job) {
      job.notifiedAt = new Date().toISOString();
      this.scheduleSave();
    }
  }

  public static markAllExistingAsNotified(): void {
    this.initialize();
    let changed = false;
    const now = new Date().toISOString();
    for (const job of this.jobsMap.values()) {
      if (!job.notifiedAt) {
        job.notifiedAt = now;
        changed = true;
      }
    }
    if (changed) {
      this.scheduleSave(0);
      console.log(
        "[Storage] Cold Start: Todas as vagas pré-existentes foram marcadas como notificadas.",
      );
    }
  }

  public static toggleJobNotified(id: string, notified?: boolean): Job | null {
    this.initialize();
    const job = this.jobsMap.get(id);
    if (!job) return null;

    if (typeof notified === "boolean") {
      job.notifiedAt = notified
        ? job.notifiedAt || new Date().toISOString()
        : null;
    } else {
      job.notifiedAt = job.notifiedAt ? null : new Date().toISOString();
    }

    this.scheduleSave();
    return job;
  }

  public static getJobsByCategory(
    category?: string,
    unnotifiedOnly = false,
  ): Job[] {
    this.initialize();
    let jobs = Array.from(this.jobsMap.values());

    if (unnotifiedOnly) {
      jobs = jobs.filter((j) => !j.notifiedAt);
    }

    // Trava de segurança: garante que apenas vagas de TI sejam retornadas
    jobs = jobs.filter(
      (j) => j.isTech !== false && TechClassifierService.isTechSync(j.title),
    );

    if (category && category !== "TODAS" && category !== "ALL") {
      const catUpper = category.toUpperCase().trim();
      jobs = jobs.filter((j) => {
        // Checa senioridade (ESTAGIO, JUNIOR, PLENO, SENIOR)
        if (j.seniorityLevel && j.seniorityLevel.toUpperCase() === catUpper)
          return true;
        // Checa tipo de contrato (CLT, PJ, FREELANCER, ESTAGIO)
        if (j.contractType && j.contractType.toUpperCase() === catUpper)
          return true;
        // Checa título para palavras-chave (ex: "estágio", "estagio", "internship")
        if (
          catUpper === "ESTAGIO" &&
          (j.title.toLowerCase().includes("estág") ||
            j.title.toLowerCase().includes("estag") ||
            j.title.toLowerCase().includes("intern"))
        )
          return true;
        if (
          catUpper === "JUNIOR" &&
          (j.title.toLowerCase().includes("júnior") ||
            j.title.toLowerCase().includes("junior") ||
            j.title.toLowerCase().includes("jr"))
        )
          return true;
        return false;
      });
    }

    return jobs;
  }

  public static getUnnotifiedJobs(category?: string): Job[] {
    return this.getJobsByCategory(category, true);
  }

  public static upsertBatch(jobs: Array<Omit<Job, "id">>): {
    totalSaved: number;
    totalUpdated: number;
  } {
    let totalSaved = 0;
    let totalUpdated = 0;

    for (const j of jobs) {
      const { isNew } = this.upsertJob(j);
      if (isNew) totalSaved++;
      else totalUpdated++;
    }

    return { totalSaved, totalUpdated };
  }

  public static getJobs(filters?: {
    search?: string;
    source?: string;
    workModel?: WorkModel;
    seniority?: SeniorityLevel;
    contractType?: ContractType;
    notified?: "ALL" | "PENDING" | "NOTIFIED" | string;
    onlyTech?: boolean;
    page?: number;
    pageSize?: number;
  }): { jobs: Job[]; total: number; page: number; pageSize: number } {
    this.initialize();

    let all = Array.from(this.jobsMap.values());

    if (filters) {
      const {
        search,
        source,
        workModel,
        seniority,
        contractType,
        notified,
        onlyTech,
      } = filters;

      if (onlyTech) {
        all = all.filter(
          (j) =>
            j.isTech !== false && TechClassifierService.isTechSync(j.title),
        );
      }

      if (search && search.trim()) {
        const q = search.toLowerCase().trim();
        all = all.filter(
          (j) =>
            j.title.toLowerCase().includes(q) ||
            j.company.toLowerCase().includes(q) ||
            j.stack.some((s) => s.toLowerCase().includes(q)) ||
            (j.description && j.description.toLowerCase().includes(q)),
        );
      }

      if (source && source !== "ALL") {
        all = all.filter(
          (j) => j.source.toUpperCase() === source.toUpperCase(),
        );
      }

      if (workModel && workModel !== "ALL") {
        all = all.filter((j) => j.workModel === workModel);
      }

      if (seniority && seniority !== "ALL") {
        all = all.filter((j) => j.seniorityLevel === seniority);
      }

      if (contractType && contractType !== "ALL") {
        all = all.filter((j) => j.contractType === contractType);
      }

      if (notified === "PENDING") {
        all = all.filter((j) => !j.notifiedAt);
      } else if (notified === "NOTIFIED") {
        all = all.filter((j) => !!j.notifiedAt);
      }
    }

    // Ordena pelas mais recentes
    all.sort(
      (a, b) =>
        new Date(b.scrapedAt).getTime() - new Date(a.scrapedAt).getTime(),
    );

    const page = Math.max(1, filters?.page || 1);
    const pageSize = Math.max(1, filters?.pageSize || 20);
    const total = all.length;
    const startIndex = (page - 1) * pageSize;
    const paginated = all.slice(startIndex, startIndex + pageSize);

    return {
      jobs: paginated,
      total,
      page,
      pageSize,
    };
  }

  public static getStats() {
    this.initialize();
    const jobs = Array.from(this.jobsMap.values());

    const bySource: Record<string, number> = {};
    const byModel: Record<string, number> = {};
    const bySeniority: Record<string, number> = {};

    for (const j of jobs) {
      bySource[j.source] = (bySource[j.source] || 0) + 1;
      byModel[j.workModel] = (byModel[j.workModel] || 0) + 1;
      bySeniority[j.seniorityLevel] = (bySeniority[j.seniorityLevel] || 0) + 1;
    }

    return {
      totalJobs: jobs.length,
      bySource,
      byModel,
      bySeniority,
    };
  }

  public static clearAll(): void {
    this.jobsMap.clear();
    this.scheduleSave(0);
  }

  private static scheduleSave(delayMs = 3000): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }
    this.saveTimeout = setTimeout(() => {
      this.flushToDisk();
    }, delayMs);
  }

  public static flushToDisk(): void {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      const data = JSON.stringify(Array.from(this.jobsMap.values()), null, 2);
      fs.writeFileSync(DATA_FILE, data, "utf-8");
      console.log(
        `[Storage] Persistidas ${this.jobsMap.size} vagas em ${DATA_FILE}`,
      );
    } catch (err) {
      console.error("[Storage] Erro ao salvar arquivo JSON:", err);
    }
  }
}
