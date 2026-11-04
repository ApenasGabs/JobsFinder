#!/usr/bin/env tsx
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ConfigService } from "../server/services/config.js";
import {
  SupabaseCompanyRow,
  SupabaseSyncService,
} from "../server/services/supabase.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_CONFIG_PATH = path.resolve(
  __dirname,
  "../config/search.config.json",
);

if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile();
  } catch {
    try {
      process.loadEnvFile("/app/.env");
    } catch {
      // Ignore
    }
  }
}

export type SyncDirection = "push" | "pull" | "bidirectional";

export interface SyncCompaniesCliOptions {
  direction: SyncDirection;
  dryRun: boolean;
  configPath?: string;
  batchSize?: number;
}

export interface SyncCompaniesCliResult {
  direction: SyncDirection;
  dryRun: boolean;
  localCount: number;
  remoteCount: number;
  pushedCount: number;
  pulledCount: number;
  failedBatches: number;
}

export async function runCompaniesSync(
  options: SyncCompaniesCliOptions,
): Promise<SyncCompaniesCliResult> {
  const configPath = options.configPath || DEFAULT_CONFIG_PATH;
  const batchSize = options.batchSize || 200;

  if (!fs.existsSync(configPath)) {
    throw new Error(`Arquivo de configuração não encontrado: ${configPath}`);
  }

  ConfigService.setConfigFilePath(configPath);
  ConfigService.resetCache();

  const localRows = ConfigService.extractAllCompaniesAsRows();
  let remoteRows: SupabaseCompanyRow[] = [];
  let pushedCount = 0;
  let pulledCount = 0;
  let failedBatches = 0;

  if (options.dryRun) {
    return {
      direction: options.direction,
      dryRun: true,
      localCount: localRows.length,
      remoteCount: 0,
      pushedCount:
        options.direction === "push" || options.direction === "bidirectional"
          ? localRows.length
          : 0,
      pulledCount: 0,
      failedBatches: 0,
    };
  }

  if (!SupabaseSyncService.isConfigured()) {
    throw new Error(
      "Supabase não configurado! Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.",
    );
  }

  // 1. Se pull ou bidirectional, consulta o estado remoto primeiro
  if (
    options.direction === "pull" ||
    options.direction === "bidirectional"
  ) {
    const fetched = await SupabaseSyncService.fetchCompanies();
    if (!fetched.success) {
      throw new Error(
        `Falha ao consultar public.companies no Supabase: ${fetched.error}`,
      );
    }
    remoteRows = fetched.rows;
  }

  // 2. Se bidirectional, preserva telemetria remota (failure_count, health_status, last_scraped_at) nas linhas locais antes do push
  const remoteMap = new Map<string, SupabaseCompanyRow>();
  for (const r of remoteRows) {
    remoteMap.set(`${r.ats.toUpperCase()}:${r.slug.toLowerCase()}`, r);
  }

  if (
    options.direction === "push" ||
    options.direction === "bidirectional"
  ) {
    const rowsToPush: SupabaseCompanyRow[] = localRows.map((local) => {
      const key = `${local.ats.toUpperCase()}:${local.slug.toLowerCase()}`;
      const remote = remoteMap.get(key);
      if (!remote) return local;

      return {
        ...local,
        id: remote.id || local.id,
        health_status: remote.health_status || local.health_status,
        failure_count:
          typeof remote.failure_count === "number"
            ? remote.failure_count
            : local.failure_count,
        last_scraped_at: remote.last_scraped_at ?? local.last_scraped_at,
        last_audited_at: remote.last_audited_at ?? local.last_audited_at,
        last_audit_status: remote.last_audit_status ?? local.last_audit_status,
        last_audit_error: remote.last_audit_error ?? local.last_audit_error,
      };
    });

    for (let i = 0; i < rowsToPush.length; i += batchSize) {
      const batch = rowsToPush.slice(i, i + batchSize);
      const res = await SupabaseSyncService.syncCompaniesBatch(batch);
      if (res.success) {
        pushedCount += res.count;
      } else {
        failedBatches++;
        console.error(
          `[SyncCompanies] Falha no lote ${Math.floor(i / batchSize) + 1}: ${res.error}`,
        );
      }
    }
  }

  // 3. Se pull ou bidirectional, atualiza o Hot Cache e o search.config.json local com a união consolidada
  if (
    options.direction === "pull" ||
    options.direction === "bidirectional"
  ) {
    const finalFetch =
      options.direction === "bidirectional" && pushedCount > 0
        ? await SupabaseSyncService.fetchCompanies()
        : { success: true, rows: remoteRows };

    if (finalFetch.success && finalFetch.rows.length > 0) {
      ConfigService.applyRowsToHotCache(finalFetch.rows, true);
      pulledCount = finalFetch.rows.length;
      remoteRows = finalFetch.rows;
    }
  }

  return {
    direction: options.direction,
    dryRun: false,
    localCount: localRows.length,
    remoteCount: remoteRows.length,
    pushedCount,
    pulledCount,
    failedBatches,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
==========================================================================
🏢 JobsFinder - Sincronizador Bidirecional de Empresas (Supabase <-> JSON)
==========================================================================
Uso:
  npx tsx scripts/sync-companies.ts [opções]

Opções:
  --push             Envia empresas do search.config.json para public.companies (Seed)
  --pull             Baixa empresas de public.companies para o search.config.json local
  --bidirectional    Sincroniza ambos os lados preservando telemetria (Padrão)
  --dry-run          Valida e exibe estatísticas sem alterar banco ou disco
`);
    process.exit(0);
  }

  const isDryRun = args.includes("--dry-run");
  let direction: SyncDirection = "bidirectional";
  if (args.includes("--push")) direction = "push";
  else if (args.includes("--pull")) direction = "pull";

  console.log("==========================================================================");
  console.log("🏢 JobsFinder - Sincronização de Empresas Monitoradas (Supabase)");
  console.log("==========================================================================");
  console.log(`🔄 Direção:  ${direction.toUpperCase()}`);
  console.log(`🧪 Dry-Run:  ${isDryRun ? "SIM" : "NÃO"}`);

  const statsBefore = ConfigService.getCacheStats();
  console.log(`📁 Empresas locais (search.config.json): ${statsBefore.totalCompanies}`);

  const result = await runCompaniesSync({
    direction,
    dryRun: isDryRun,
  });

  if (isDryRun) {
    const sample = ConfigService.extractAllCompaniesAsRows().slice(0, 3);
    console.log("\nExemplo das primeiras linhas mapeadas para public.companies:");
    console.log(JSON.stringify(sample, null, 2));
  }

  console.log("\n==========================================================================");
  console.log("📊 Resumo da Sincronização:");
  console.log(`  - Empresas no JSON local:     ${result.localCount}`);
  console.log(`  - Empresas no Supabase:       ${result.remoteCount}`);
  console.log(`  - Enviadas (Upsert/Seed):     ${result.pushedCount}`);
  console.log(`  - Baixadas para Cache/JSON:   ${result.pulledCount}`);
  console.log(`  - Lotes com falha:            ${result.failedBatches}`);
  console.log("==========================================================================");

  if (result.failedBatches > 0) {
    process.exit(1);
  }
}

const isDirectExecution =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(__filename);

if (isDirectExecution) {
  main().catch((err) => {
    console.error(
      "❌ Erro fatal na sincronização de empresas:",
      err instanceof Error ? err.message : String(err),
    );
    process.exit(1);
  });
}
