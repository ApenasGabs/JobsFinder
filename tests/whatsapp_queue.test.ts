import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import { WhatsAppBot } from "../server/bot/whatsapp.js";
import { Job } from "../server/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, "../data");
const QUEUE_FILE = path.join(DATA_DIR, "whatsapp_queue.json");

describe("WhatsApp Bot Queue, Backoff and Cold Start", () => {
  let backupQueueContent: string | null = null;

  beforeEach(() => {
    // Faz backup de eventual fila existente para não interferir em dados reais
    if (fs.existsSync(QUEUE_FILE)) {
      backupQueueContent = fs.readFileSync(QUEUE_FILE, "utf-8");
    } else {
      backupQueueContent = null;
    }
    WhatsAppBot.clearQueue();
  });

  afterEach(() => {
    // Restaura o arquivo de fila original
    if (backupQueueContent !== null) {
      fs.writeFileSync(QUEUE_FILE, backupQueueContent, "utf-8");
    } else if (fs.existsSync(QUEUE_FILE)) {
      try {
        fs.unlinkSync(QUEUE_FILE);
      } catch {}
    }
    WhatsAppBot.clearQueue();
  });

  it("deve calcular backoff exponencial progressivo até o teto com jitter", () => {
    const delay0 = WhatsAppBot.calculateReconnectDelay(0, 0);
    const delay1 = WhatsAppBot.calculateReconnectDelay(1, 0);
    const delay2 = WhatsAppBot.calculateReconnectDelay(2, 0);
    const delay3 = WhatsAppBot.calculateReconnectDelay(3, 0);
    const delayMax = WhatsAppBot.calculateReconnectDelay(20, 0);

    assert.equal(delay0, 5000, "Tentativa 0 deve ser 5000ms");
    assert.equal(delay1, 7500, "Tentativa 1 deve ser 7500ms");
    assert.equal(delay2, 11250, "Tentativa 2 deve ser 11250ms");
    assert.equal(delay3, 16875, "Tentativa 3 deve ser 16875ms");
    assert.ok(delay2 > delay1, "O atraso deve crescer a cada tentativa");
    assert.ok(delayMax <= 300000, "O atraso máximo nunca deve ultrapassar 5 minutos (300.000ms)");

    const delayWithJitter = WhatsAppBot.calculateReconnectDelay(1, 1200);
    assert.equal(delayWithJitter, 8700, "Deve somar o jitter ao atraso calculado");
  });

  it("deve persistir vagas enfileiradas em disco e recuperá-las ao recarregar a fila", () => {
    const sampleJob: Job = {
      id: `test-queue-${Date.now()}`,
      title: "Desenvolvedor Backend Node.js Senior",
      company: "Empresa Teste",
      location: "Remoto",
      workModel: "REMOTO",
      contractType: "PJ",
      seniorityLevel: "SENIOR",
      url: "https://example.com/job/123",
      source: "TEST",
      stack: ["Node.js", "TypeScript"],
      isTech: true,
      scrapedAt: new Date().toISOString(),
    };

    const added = WhatsAppBot.enqueueJobs([sampleJob]);
    assert.equal(added, 1, "Deve enfileirar a vaga de tecnologia");
    assert.ok(fs.existsSync(QUEUE_FILE), "O arquivo whatsapp_queue.json deve ter sido criado no disco");

    const fileContent = JSON.parse(fs.readFileSync(QUEUE_FILE, "utf-8"));
    assert.ok(Array.isArray(fileContent));
    assert.equal(fileContent.length, 1);
    assert.equal(fileContent[0].id, sampleJob.id);

    // Simula reinício de processo limpando o array em memória sem apagar o arquivo do disco
    WhatsAppBot.loadQueueFromDisk();
    const restoredQueue = WhatsAppBot.getQueue();
    assert.equal(restoredQueue.length, 1);
    assert.equal(restoredQueue[0].id, sampleJob.id);
  });

  it("deve ignorar e não enfileirar vagas que não sejam de tecnologia", () => {
    const nonTechJob: Job = {
      id: `non-tech-${Date.now()}`,
      title: "Enfermeiro Chefe de UTI",
      company: "Hospital Central",
      location: "São Paulo, SP",
      workModel: "PRESENCIAL",
      contractType: "CLT",
      seniorityLevel: "PLENO",
      url: "https://example.com/job/enf",
      source: "TEST",
      stack: ["Saúde"],
      isTech: false,
      scrapedAt: new Date().toISOString(),
    };

    const added = WhatsAppBot.enqueueJobs([nonTechJob]);
    assert.equal(added, 0, "Não deve enfileirar vaga de enfermagem/não-tech");
    assert.equal(WhatsAppBot.getQueue().length, 0);
  });

  it("deve manter controle de execução única do Cold Start", () => {
    WhatsAppBot.resetColdStart();
    assert.equal(WhatsAppBot.isColdStartExecuted(), false, "Inicialmente o cold start não foi executado");
  });

  it("deve executar triggerQueueProcessing com segurança mesmo com fila vazia ou bot desconectado", () => {
    assert.doesNotThrow(() => {
      WhatsAppBot.triggerQueueProcessing();
    });
  });

  it("deve persistir e reter envelope de digest na fila", () => {
    WhatsAppBot.clearQueue();
    WhatsAppBot.enqueueDigestEnvelope({
      id: "test-digest-retention",
      kind: "entry",
      slotKey: "entry:test",
      text: "Vagas de teste",
      includedIds: ["id-1", "id-2"],
      expiredIds: [],
      createdAt: new Date().toISOString(),
    });

    const queue = WhatsAppBot.getDigestQueue();
    assert.equal(queue.length, 1);
    assert.equal(queue[0].id, "test-digest-retention");
    assert.equal(queue[0].kind, "entry");
  });
});
