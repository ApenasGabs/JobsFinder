#!/usr/bin/env bash
set -e

echo "=========================================================================="
echo "🐳 Executando Importador de Planilhas via Docker Seguro (ZimaOS Homelab)"
echo "   Host Mount: /DATA/Projetos/busca-vagas"
echo "   Limites: CPU=0.75 core | RAM=384MB | Node Heap=256MB"
echo "=========================================================================="

docker run --rm \
  --name jobsfinder-sheet-importer \
  --cpus="0.75" \
  --memory="384m" \
  --memory-swap="384m" \
  -e NODE_OPTIONS="--max-old-space-size=256" \
  -v /DATA/Projetos/busca-vagas:/workspace/busca-vagas \
  -w /workspace/busca-vagas/JobsFinder \
  node:22 \
  ./node_modules/.bin/tsx scripts/import-sheet-companies.ts "$@"
