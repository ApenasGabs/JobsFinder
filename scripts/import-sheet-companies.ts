#!/usr/bin/env tsx
import path from "path";
import { fileURLToPath } from "url";
import { SheetImporterService } from "../server/services/sheet-importer.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(`
==========================================================================
🚀 JobsFinder - Importador Inteligente de Empresas por Planilhas
==========================================================================
Uso:
  npx tsx scripts/import-sheet-companies.ts <URL_OU_ARQUIVO> [opções]

Exemplos:
  # Importar todas as abas da planilha do Google Sheets (modo real)
  npm run import:sheet -- "https://docs.google.com/spreadsheets/d/1A1tjyeb_n5WuYfdA6GnNsFAFJwS95IWKRadz-Td9fQ0/edit?gid=1619215734"

  # Simular importação da planilha local (Dry-Run com Probing ativo)
  npm run import:sheet -- "/workspace/busca-vagas/empresas para conferir.xlsx" --dry-run --probe

Opções:
  --dry-run          Apenas simula a identificação e cadastro sem alterar o search.config.json
  --probe            Ativa a sondagem de APIs públicas e inspeção de websites para empresas sem link direto
  --no-probe         Desativa o probing ativo (processa apenas links diretos de ATS)
  --limit-tabs=<N>   Limita a quantidade de abas lidas (0 = todas)
  --out=<path>       Caminho para salvar o relatório JSON
`);
    process.exit(0);
  }

  const source = args.find((a) => !a.startsWith("--"));
  if (!source) {
    console.error("❌ Erro: informe a URL do Google Sheets ou o caminho do arquivo .xlsx.");
    process.exit(1);
  }

  const dryRun = args.includes("--dry-run");
  const enableProbing = !args.includes("--no-probe");

  let limitTabs: number | undefined;
  const maxTabsArg = args.find((a) => a.startsWith("--limit-tabs="));
  if (maxTabsArg) {
    limitTabs = parseInt(maxTabsArg.split("=")[1], 10) || undefined;
  }

  let reportPath: string | undefined;
  const outArg = args.find((a) => a.startsWith("--out="));
  if (outArg) {
    reportPath = outArg.split("=")[1];
  }

  console.log("==========================================================================");
  console.log("🚀 JobsFinder - Importador Inteligente de Empresas por Planilhas");
  console.log("==========================================================================");
  console.log(`📁 Fonte:        ${source}`);
  console.log(`🧪 Modo Dry-Run: ${dryRun ? "SIM (Nenhuma alteração será persistida)" : "NÃO (Cadastro real no search.config.json)"}`);
  console.log(`🔍 Probing:      ${enableProbing ? "ATIVADO (Sondagem de APIs e inspeção web)" : "DESATIVADO"}`);
  console.log(`📑 Limite Abas:  ${limitTabs ? limitTabs : "TODAS"}`);
  console.log("--------------------------------------------------------------------------");

  try {
    const report = await SheetImporterService.import({
      source,
      dryRun,
      probe: enableProbing,
      limitTabs,
      outputPath: reportPath,
    });

    console.log("\n==========================================================================");
    console.log("✅ Processamento Concluído com Sucesso!");
    console.log("==========================================================================");
    console.log(`📊 Linhas processadas:      ${report.totalRowsProcessed}`);
    console.log(`🏢 Empresas únicas:         ${report.totalUniqueCompanies}`);
    console.log(`🎯 ATSs identificadas:      ${report.matchedCount}`);
    console.log(`✨ Novas empresas:          ${report.newAddedCount}`);
    console.log(`🔁 Já cadastradas antes:    ${report.alreadyExistingCount}`);
    console.log(`⏳ Não resolvidas:          ${report.unresolvedCount}`);

    console.log("\n--- Distribuição por ATS ---");
    for (const [ats, stat] of Object.entries(report.byAts)) {
      if (stat.new > 0 || stat.existing > 0) {
        console.log(`- ${ats}: +${stat.new} novas | ${stat.existing} já existentes`);
      }
    }

    console.log("\n--- Exemplos de Novas Empresas Mapeadas ---");
    const sampleNew = report.companies.filter((m) => m.status === "new").slice(0, 10);
    if (sampleNew.length > 0) {
      for (const m of sampleNew) {
        console.log(`- [${m.atsMatch?.ats}] ${m.name} (${m.atsMatch?.slug}) -> ${m.atsMatch?.portalUrl} [${m.atsMatch?.source}]`);
      }
    } else {
      console.log("(Nenhuma empresa nova adicionada nesta execução)");
    }

    console.log(`\n📄 Relatório JSON salvo em: ${reportPath || "data/sheet_import_report.json"}`);
  } catch (err: any) {
    console.error(`\n❌ Falha na importação: ${err.message}`);
    process.exit(1);
  }
}

main();
