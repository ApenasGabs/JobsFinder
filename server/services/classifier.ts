import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Job } from "../types.js";
import { canonicalizeTitle } from "../utils/normalizer.js";
import { LoggerService } from "./logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DICTIONARY_PATH = path.resolve(
  __dirname,
  "../../data/tech_dictionary.json",
);
const SEED_DICTIONARY_PATH = path.resolve(
  __dirname,
  "../../config/tech_dictionary.seed.json",
);

export type ClassificationSource = "USER" | "RULE" | "AI";

export interface TechEntry {
  isTech: boolean;
  source: ClassificationSource;
  updatedAt?: string;
}

export interface TechDictionaryData {
  version: number;
  updatedAt: string;
  exact_titles: Record<string, TechEntry>;
  keywords_whitelist: string[];
  keywords_blacklist: string[];
}

interface PendingJobItem {
  id: number;
  rawTitle: string;
  canonicalTitle: string;
  resolve: (isTech: boolean) => void;
  reject: (err: any) => void;
}

export class TechClassifierService {
  private static isInitialized = false;
  private static dictionaryMap = new Map<string, TechEntry>();
  private static whitelist: string[] = [];
  private static blacklist: string[] = [];
  private static saveTimeout: NodeJS.Timeout | null = null;

  // Fila de classificação em lote para a IA local
  private static batchQueue: PendingJobItem[] = [];
  private static batchTimer: NodeJS.Timeout | null = null;
  private static nextBatchId = 1;
  private static isProcessingBatch = false;

  // Circuit Breaker para o host servidor
  private static consecutiveAiFailures = 0;
  private static circuitBreakerUntil = 0;

  // Endpoint do host servidor configurável via env
  private static ollamaUrl =
    process.env.OLLAMA_HOST || "http://servidor.local:11434";
  private static aiModel = process.env.OLLAMA_MODEL || "llama3.2:3b";

  public static initialize(): void {
    if (this.isInitialized) return;

    try {
      let seedData: Partial<TechDictionaryData> = {};
      if (fs.existsSync(SEED_DICTIONARY_PATH)) {
        seedData = JSON.parse(fs.readFileSync(SEED_DICTIONARY_PATH, "utf-8"));
      }

      let runtimeData: Partial<TechDictionaryData> = {};
      if (fs.existsSync(DICTIONARY_PATH)) {
        runtimeData = JSON.parse(fs.readFileSync(DICTIONARY_PATH, "utf-8"));
      }

      const rawWhitelist =
        runtimeData.keywords_whitelist && runtimeData.keywords_whitelist.length > 0
          ? runtimeData.keywords_whitelist
          : seedData.keywords_whitelist || [];
      const rawBlacklist =
        runtimeData.keywords_blacklist && runtimeData.keywords_blacklist.length > 0
          ? runtimeData.keywords_blacklist
          : seedData.keywords_blacklist || [];

      this.whitelist = rawWhitelist.map((k) => k.toLowerCase().trim());
      this.blacklist = rawBlacklist.map((k) => k.toLowerCase().trim());

      const mergedTitles: Record<string, TechEntry> = {
        ...(seedData.exact_titles || {}),
        ...(runtimeData.exact_titles || {}),
      };

      for (const [title, entry] of Object.entries(mergedTitles)) {
        const canonical = canonicalizeTitle(title);
        this.dictionaryMap.set(canonical, entry);
      }

      if (this.dictionaryMap.size > 0 || this.whitelist.length > 0) {
        console.log(
          `[TechClassifier] ✅ Dicionário inicializado com ${this.dictionaryMap.size} títulos conhecidos, ${this.whitelist.length} termos na whitelist e ${this.blacklist.length} na blacklist.`,
        );
        if (!fs.existsSync(DICTIONARY_PATH) || !runtimeData.keywords_whitelist?.length) {
          this.saveToDiskSync();
        }
      } else {
        console.warn(
          `[TechClassifier] Arquivo ${DICTIONARY_PATH} não encontrado. Inicializando com mapa vazio.`,
        );
      }
    } catch (err) {
      console.error("[TechClassifier] Erro ao carregar dicionário:", err);
    }

    this.isInitialized = true;
  }

  /**
   * Classifica se uma vaga é de Tecnologia (TI, Software, Dados, Design Tech).
   * 1. Consulta RAM O(1) em < 0.001ms.
   * 2. Avalia Blacklist com soberania absoluta.
   * 3. Avalia Whitelist de alta confiança.
   * 4. Se ambígua, aciona inferência em lote via IA local no host servidor.
   */
  public static async isTech(jobOrTitle: Job | string): Promise<boolean> {
    this.initialize();

    const rawTitle =
      typeof jobOrTitle === "string" ? jobOrTitle : jobOrTitle.title;
    const canonical = canonicalizeTitle(rawTitle);

    if (!canonical) return false;

    // 1. Consulta em memória RAM (Match Exato Canônico)
    const cached = this.dictionaryMap.get(canonical);
    if (cached !== undefined) {
      return cached.isTech;
    }

    // 2. Precedência Absoluta da Blacklist (Regra Anti-Contaminação)
    // Se tiver termo não-tech funcional (vendedor, enfermagem, jurídico), descarta na hora!
    if (this.matchesBlacklist(rawTitle, canonical)) {
      this.learnDecision(canonical, false, "RULE");
      return false;
    }

    // 3. Whitelist de Alta Confiança
    if (this.matchesWhitelist(rawTitle, canonical)) {
      this.learnDecision(canonical, true, "RULE");
      return true;
    }

    // Se tiver stack de tecnologia detectada
    if (typeof jobOrTitle !== "string" && jobOrTitle.stack?.length > 0) {
      this.learnDecision(canonical, true, "RULE");
      return true;
    }

    // 4. Se for ambíguo/inédito, enfileira para a IA Local em lote
    return this.enqueueForAiClassification(rawTitle, canonical);
  }

  /**
   * Versão síncrona instantânea para caminhos críticos (ex: WhatsApp Bot).
   * Nunca aguarda chamadas assíncronas de rede.
   * Se for desconhecido, falha de forma segura (Fail-Safe: retorna false).
   */
  public static isTechSync(jobOrTitle: Job | string): boolean {
    this.initialize();

    const rawTitle =
      typeof jobOrTitle === "string" ? jobOrTitle : jobOrTitle.title;
    const canonical = canonicalizeTitle(rawTitle);

    if (!canonical) return false;

    // Cache em RAM
    const cached = this.dictionaryMap.get(canonical);
    if (cached !== undefined) {
      return cached.isTech;
    }

    // Blacklist soberana
    if (this.matchesBlacklist(rawTitle, canonical)) {
      this.learnDecision(canonical, false, "RULE");
      return false;
    }

    // Whitelist
    if (this.matchesWhitelist(rawTitle, canonical)) {
      this.learnDecision(canonical, true, "RULE");
      return true;
    }

    // Stack técnica detectada
    if (typeof jobOrTitle !== "string" && jobOrTitle.stack?.length > 0) {
      this.learnDecision(canonical, true, "RULE");
      return true;
    }

    // Em caso de dúvida, não envia para o WhatsApp
    return false;
  }

  /**
   * Curadoria humana manual através da interface web.
   * Tem autoridade máxima ("USER") e nunca pode ser sobrescrita pela IA.
   */
  public static recordUserFeedback(
    rawTitle: string,
    isTech: boolean,
  ): { title: string; canonical: string; isTech: boolean } {
    this.initialize();
    const canonical = canonicalizeTitle(rawTitle);
    this.learnDecision(canonical, isTech, "USER");
    console.log(
      `[TechClassifier] 👤 Decisão humana registrada: "${canonical}" -> ${isTech ? "TI" : "NÃO-TI"}`,
    );
    return { title: rawTitle, canonical, isTech };
  }

  public static getStats(): {
    totalEntries: number;
    techCount: number;
    nonTechCount: number;
    userCount: number;
    ruleCount: number;
    aiCount: number;
    whitelistTerms: number;
    blacklistTerms: number;
  } {
    this.initialize();
    let techCount = 0;
    let nonTechCount = 0;
    let userCount = 0;
    let ruleCount = 0;
    let aiCount = 0;

    for (const entry of this.dictionaryMap.values()) {
      if (entry.isTech) techCount++;
      else nonTechCount++;

      if (entry.source === "USER") userCount++;
      else if (entry.source === "RULE") ruleCount++;
      else if (entry.source === "AI") aiCount++;
    }

    return {
      totalEntries: this.dictionaryMap.size,
      techCount,
      nonTechCount,
      userCount,
      ruleCount,
      aiCount,
      whitelistTerms: this.whitelist.length,
      blacklistTerms: this.blacklist.length,
    };
  }

  private static matchesBlacklist(
    rawTitle: string,
    canonical: string,
  ): boolean {
    const rawLower = rawTitle.toLowerCase();
    for (const term of this.blacklist) {
      if (canonical.includes(term) || rawLower.includes(term)) {
        return true;
      }
    }
    return false;
  }

  private static matchesWhitelist(
    rawTitle: string,
    canonical: string,
  ): boolean {
    const rawLower = rawTitle.toLowerCase();
    for (const term of this.whitelist) {
      if (
        term === "ia" ||
        term === "ai" ||
        term === "ml" ||
        term === "bi" ||
        term === "qa" ||
        term === "ti"
      ) {
        const regex = new RegExp(`\\b${term}\\b`, "i");
        if (regex.test(rawTitle) || regex.test(canonical)) return true;
      } else {
        if (canonical.includes(term) || rawLower.includes(term)) {
          return true;
        }
      }
    }
    return false;
  }

  private static learnDecision(
    canonical: string,
    isTech: boolean,
    source: ClassificationSource,
  ): void {
    const existing = this.dictionaryMap.get(canonical);

    // Salvaguarda de Autoridade: Decisão USER nunca é sobrescrita por RULE ou AI!
    if (existing && existing.source === "USER" && source !== "USER") {
      return;
    }

    this.dictionaryMap.set(canonical, {
      isTech,
      source,
      updatedAt: new Date().toISOString(),
    });

    if (source === "USER") {
      LoggerService.info(
        "USER_ACTION",
        "CLASSIFIER_FEEDBACK",
        `Usuário classificou "${canonical}" como ${isTech ? "TI" : "NÃO-TI"}`,
        { canonical, isTech, source },
      );
    } else if (source === "AI") {
      LoggerService.info(
        "CLASSIFIER",
        isTech ? "JOB_ACCEPTED_AI" : "JOB_REJECTED_AI",
        `IA Local classificou "${canonical}" como ${isTech ? "TI" : "NÃO-TI"}`,
        { canonical, isTech, source },
      );
    }

    this.scheduleSave();
  }

  private static enqueueForAiClassification(
    rawTitle: string,
    canonical: string,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      // Se o circuit breaker estiver ativo (IA fora do ar), faz fallback heurístico seguro
      if (Date.now() < this.circuitBreakerUntil) {
        return resolve(this.heuristicFallback(rawTitle, canonical));
      }

      const item: PendingJobItem = {
        id: this.nextBatchId++,
        rawTitle,
        canonicalTitle: canonical,
        resolve,
        reject,
      };

      this.batchQueue.push(item);

      // Se atingir 20 itens no buffer, dispara imediatamente
      if (this.batchQueue.length >= 20) {
        if (this.batchTimer) {
          clearTimeout(this.batchTimer);
          this.batchTimer = null;
        }
        this.flushBatch();
      } else if (!this.batchTimer) {
        // Aguarda 100ms para acumular outros itens antes de despachar o lote
        this.batchTimer = setTimeout(() => {
          this.batchTimer = null;
          this.flushBatch();
        }, 100);
      }
    });
  }

  private static async flushBatch(): Promise<void> {
    if (this.isProcessingBatch || this.batchQueue.length === 0) return;
    this.isProcessingBatch = true;

    // Retira até 20 itens da fila
    const currentBatch = this.batchQueue.splice(0, 20);

    try {
      const promptLines = currentBatch.map(
        (item) => `${item.id}. ${item.rawTitle}`,
      );
      const promptText = [
        `Você é um classificador estrito de vagas de emprego.`,
        `Classifique cada vaga como Tecnologia/TI (true) ou Não-TI (false).`,
        `Considere TI: desenvolvimento de software, engenharia de dados, cloud, devops, qa, design tech (ui/ux), produto tech, cibersegurança e suporte técnico.`,
        `Considere NÃO-TI: vendas/comercial/sdr, jurídico/advocacia, enfermagem/saúde, recursos humanos/dp, cozinha, limpeza, logística e atendimento geral.`,
        `Responda EXCLUSIVAMENTE em formato JSON com o ID numérico e o valor booleano: {"1": true, "2": false}`,
        ``,
        ...promptLines,
      ].join("\n");

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3500); // Timeout de 3.5s

      const response = await fetch(`${this.ollamaUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.aiModel,
          prompt: promptText,
          format: "json",
          stream: false,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`Ollama retornou HTTP ${response.status}`);
      }

      const body: any = await response.json();
      const rawJson = (body.response || "").replace(/```json|```/g, "").trim();
      const parsed: Record<string, any> = JSON.parse(rawJson);

      // Sucesso: zera falhas consecutivas
      this.consecutiveAiFailures = 0;

      for (const item of currentBatch) {
        const val = parsed[String(item.id)] ?? parsed[item.id];
        let isTech = false;
        if (typeof val === "boolean") isTech = val;
        else if (typeof val === "string") {
          const s = val.toLowerCase().trim();
          isTech =
            s === "true" ||
            s === "ti" ||
            s === "tech" ||
            s === "yes" ||
            s === "sim";
        } else if (typeof val === "number") {
          isTech = val === 1;
        } else {
          // Se o modelo omitiu o ID, usa fallback heurístico seguro
          isTech = this.heuristicFallback(item.rawTitle, item.canonicalTitle);
        }

        // Aprende a decisão no dicionário em RAM
        this.learnDecision(item.canonicalTitle, isTech, "AI");
        item.resolve(isTech);
      }
    } catch (err: any) {
      console.warn(
        `[TechClassifier] Aviso: falha na classificação via IA local (${err?.message || err}). Acionando contingência heurística.`,
      );

      this.consecutiveAiFailures++;
      LoggerService.warn(
        "CLASSIFIER",
        "AI_BATCH_FAILED",
        `Falha na IA local: ${err?.message || err}`,
        { consecutiveFailures: this.consecutiveAiFailures },
      );

      // Se falhar 2 vezes seguidas, abre o Circuit Breaker por 30 segundos
      if (this.consecutiveAiFailures >= 2) {
        this.circuitBreakerUntil = Date.now() + 30000;
        console.warn(
          `[TechClassifier] ⚠️ Circuit Breaker ativado para IA local por 30s.`,
        );
        LoggerService.warn(
          "CLASSIFIER",
          "AI_CIRCUIT_BREAKER",
          "Circuit Breaker ativado para IA local por 30 segundos",
          { pauseMs: 30000 },
        );
      }

      // Resolve todos os itens do lote com fallback heurístico seguro sem quebrar o crawler
      for (const item of currentBatch) {
        const isTech = this.heuristicFallback(
          item.rawTitle,
          item.canonicalTitle,
        );
        this.learnDecision(item.canonicalTitle, isTech, "RULE");
        item.resolve(isTech);
      }
    } finally {
      this.isProcessingBatch = false;
      // Se ainda houver itens na fila, processa o próximo lote
      if (this.batchQueue.length > 0) {
        setImmediate(() => this.flushBatch());
      }
    }
  }

  private static heuristicFallback(
    rawTitle: string,
    canonical: string,
  ): boolean {
    if (this.matchesBlacklist(rawTitle, canonical)) return false;
    if (this.matchesWhitelist(rawTitle, canonical)) return true;
    return false;
  }

  /**
   * Persistência em disco com escrita atômica e debounce de 2 segundos.
   * Evita corrupção de arquivo e escritas repetitivas.
   */
  private static scheduleSave(): void {
    if (this.saveTimeout) return;

    this.saveTimeout = setTimeout(() => {
      this.saveTimeout = null;
      this.saveToDiskSync();
    }, 2000);
  }

  public static saveToDiskSync(): void {
    try {
      const exactObj: Record<string, TechEntry> = {};
      for (const [key, value] of this.dictionaryMap.entries()) {
        exactObj[key] = value;
      }

      const data: TechDictionaryData = {
        version: 1,
        updatedAt: new Date().toISOString(),
        exact_titles: exactObj,
        keywords_whitelist: this.whitelist,
        keywords_blacklist: this.blacklist,
      };

      const dir = path.dirname(DICTIONARY_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const tmpFile = `${DICTIONARY_PATH}.tmp`;
      fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), "utf-8");
      fs.renameSync(tmpFile, DICTIONARY_PATH);
    } catch (err) {
      console.error(
        "[TechClassifier] Falha ao persistir tech_dictionary.json:",
        err,
      );
    }
  }
}
