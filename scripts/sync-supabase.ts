import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { SupabaseSyncService } from "../server/services/supabase.js";
import type { Job } from "../server/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_FILE = path.resolve(__dirname, "../data/jobs.json");

const BATCH_SIZE = 100;
const isDryRun = process.argv.includes("--dry-run");

async function main() {
  console.log("==========================================================");
  console.log("🚀 Sincronizador de Vagas para Supabase (JobsFinder)");
  console.log("==========================================================");

  if (!fs.existsSync(DATA_FILE)) {
    console.error(`❌ Arquivo de dados não encontrado: ${DATA_FILE}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(DATA_FILE, "utf-8");
  const allJobs: Job[] = JSON.parse(raw);
  const techJobs = allJobs.filter((j) => j.isTech !== false);

  console.log(`📁 Total de vagas no arquivo local: ${allJobs.length}`);
  console.log(`💻 Vagas filtradas como Tech/TI:   ${techJobs.length}`);

  if (isDryRun) {
    console.log("\n🧪 [MODO SECO / DRY-RUN ATIVADO]");
    console.log("Nenhuma requisição externa será disparada.");

    const sample = techJobs.slice(0, 3).map((j) => SupabaseSyncService.mapJobToRow(j));
    console.log("\nExemplo das primeiras linhas que seriam enviadas:");
    console.log(JSON.stringify(sample, null, 2));

    console.log(`\n✅ Validação concluída: ${techJobs.length} vagas prontas para envio em ${Math.ceil(techJobs.length / BATCH_SIZE)} lotes.`);
    return;
  }

  if (!SupabaseSyncService.isConfigured()) {
    console.error("\n❌ Supabase não configurado!");
    console.error("Defina as variáveis no ambiente ou em seu arquivo .env:");
    console.error("  export SUPABASE_URL=\"https://xyz.supabase.co\"");
    console.error("  export SUPABASE_SERVICE_ROLE_KEY=\"sua-chave-service-role\"");
    console.error("\nPara testar a validação sem credenciais, rode:");
    console.error("  yarn sync:supabase --dry-run");
    process.exit(1);
  }

  console.log(`\n🔄 Iniciando envio em lotes de ${BATCH_SIZE}...`);
  let synced = 0;
  let failed = 0;

  const totalBatches = Math.ceil(techJobs.length / BATCH_SIZE);

  for (let i = 0; i < techJobs.length; i += BATCH_SIZE) {
    const batch = techJobs.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;

    process.stdout.write(`⏳ Lote ${batchNum}/${totalBatches} (${batch.length} vagas)... `);

    const result = await SupabaseSyncService.syncBatch(batch);

    if (result.success) {
      synced += result.count;
      console.log(`✅ OK (+${result.count} sincronizadas)`);
    } else {
      failed += batch.length;
      console.log(`❌ Falha: ${result.error}`);
    }

    // Pequena pausa entre lotes para não sobrecarregar
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  console.log("\n==========================================================");
  console.log("📊 Resumo da Sincronização:");
  console.log(`  - Total processado:    ${techJobs.length}`);
  console.log(`  - Sucessos:            ${synced}`);
  console.log(`  - Falhas:              ${failed}`);
  console.log("==========================================================");
}

main().catch((err) => {
  console.error("❌ Erro fatal durante a sincronização:", err);
  process.exit(1);
});

