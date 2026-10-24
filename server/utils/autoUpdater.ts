import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigService } from "../services/config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "../..");
const DIST_DIR = path.join(ROOT_DIR, "dist");
const BUILD_SHA_FILE = path.join(DIST_DIR, ".build-sha");

const RUNTIME_PRESERVED_FILES = [
  "config/search.config.json",
  "data/jobs.json",
  "data/tech_dictionary.json",
];

export interface AutoUpdateStatus {
  currentSha: string;
  builtSha: string | null;
  remoteSha: string | null;
  hasUpdate: boolean;
  autoUpdateOnStart: boolean;
  lastCheckedAt: string | null;
}

export class AutoUpdaterService {
  private static lastRemoteSha: string | null = null;
  private static lastCheckedAt: string | null = null;

  private static runGit(args: string, timeoutMs = 15000): string {
    return execSync(`git ${args}`, {
      cwd: ROOT_DIR,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    }).trim();
  }

  public static ensureSafeDirectory(): void {
    try {
      this.runGit(`config --global --add safe.directory ${ROOT_DIR}`, 5000);
    } catch {
      // Ignora caso não tenha permissão global
    }
  }

  public static getCurrentSha(): string {
    try {
      this.ensureSafeDirectory();
      return this.runGit("rev-parse HEAD", 5000);
    } catch {
      return "unknown";
    }
  }

  public static getBuiltSha(): string | null {
    try {
      if (fs.existsSync(BUILD_SHA_FILE)) {
        return fs.readFileSync(BUILD_SHA_FILE, "utf-8").trim() || null;
      }
    } catch {
      // ignore
    }
    return null;
  }

  public static writeBuiltSha(sha: string): void {
    try {
      if (!fs.existsSync(DIST_DIR)) {
        fs.mkdirSync(DIST_DIR, { recursive: true });
      }
      fs.writeFileSync(BUILD_SHA_FILE, sha.trim(), "utf-8");
    } catch (err) {
      console.warn("[AutoUpdater] Não foi possível gravar dist/.build-sha:", err);
    }
  }

  public static isAutoUpdateEnabled(): boolean {
    if (process.env.AUTO_UPDATE_ON_START === "false" || process.env.AUTO_UPDATE_ON_START === "0") {
      return false;
    }
    const cfg = ConfigService.getConfig() as any;
    return cfg.autoUpdateOnStart !== false;
  }

  public static setAutoUpdateOnStart(enabled: boolean): boolean {
    const updated = ConfigService.updateConfig({
      autoUpdateOnStart: enabled,
    } as any) as any;
    return updated.autoUpdateOnStart !== false;
  }

  private static backupRuntimeFiles(): Map<string, Buffer> {
    const backups = new Map<string, Buffer>();
    for (const relPath of RUNTIME_PRESERVED_FILES) {
      const fullPath = path.join(ROOT_DIR, relPath);
      try {
        if (fs.existsSync(fullPath)) {
          backups.set(relPath, fs.readFileSync(fullPath));
        }
      } catch (err) {
        console.warn(`[AutoUpdater] Aviso ao fazer backup de ${relPath}:`, err);
      }
    }
    return backups;
  }

  private static restoreRuntimeFiles(backups: Map<string, Buffer>): void {
    for (const [relPath, content] of backups.entries()) {
      const fullPath = path.join(ROOT_DIR, relPath);
      try {
        const dir = path.dirname(fullPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(fullPath, content);
      } catch (err) {
        console.error(`[AutoUpdater] Erro ao restaurar ${relPath}:`, err);
      }
    }
  }

  public static buildFrontend(targetSha: string): boolean {
    try {
      console.log(
        `[AutoUpdater] 🏗️ Compilando frontend (npm run build) para o commit ${targetSha.slice(0, 7)}...`,
      );
      execSync("npm run build", {
        cwd: ROOT_DIR,
        stdio: "inherit",
        timeout: 180000,
      });
      this.writeBuiltSha(targetSha);
      console.log(
        `[AutoUpdater] ✅ Frontend compilado e sincronizado (${targetSha.slice(0, 7)}).`,
      );
      return true;
    } catch (err: any) {
      console.error(
        "[AutoUpdater] ❌ Falha ao compilar frontend:",
        err?.message || err,
      );
      return false;
    }
  }

  /**
   * Executado no boot do servidor (server/index.ts) antes de carregar o banco em memória.
   * 1) Se autoUpdateOnStart estiver ativo, faz fetch de origin/main; se houver novo commit,
   *    preserva arquivos de dados locais, aplica git reset --hard origin/main, compila o frontend e reinicia o processo.
   * 2) Mesmo se não houver commit novo (ex: entrypoint do container já deu pull), verifica se dist/.build-sha
   *    corresponde ao HEAD atual; se estiver defasado, compila o frontend automaticamente.
   */
  public static runStartupCheck(): void {
    if (
      process.env.NODE_ENV === "test" ||
      process.env.SKIP_STARTUP_AUTO_UPDATE === "1"
    ) {
      return;
    }

    if (!fs.existsSync(path.join(ROOT_DIR, ".git"))) {
      return;
    }

    this.ensureSafeDirectory();
    const enabled = this.isAutoUpdateEnabled();
    let currentSha = this.getCurrentSha();

    if (enabled) {
      try {
        console.log(
          "[AutoUpdater] 🔍 Verificando atualizações em origin/main na inicialização...",
        );
        this.runGit("fetch origin main", 20000);
        const remoteSha = this.runGit("rev-parse origin/main", 5000);
        this.lastRemoteSha = remoteSha;
        this.lastCheckedAt = new Date().toISOString();

        if (remoteSha && currentSha && remoteSha !== currentSha) {
          console.log(
            `[AutoUpdater] 🚀 Nova versão encontrada na main (${currentSha.slice(0, 7)} -> ${remoteSha.slice(0, 7)}). Atualizando automaticamente...`,
          );
          const backups = this.backupRuntimeFiles();
          this.runGit("reset --hard origin/main", 15000);
          this.restoreRuntimeFiles(backups);

          currentSha = this.getCurrentSha();
          this.buildFrontend(currentSha);

          console.log(
            `[AutoUpdater] 🔄 Código atualizado para ${currentSha.slice(0, 7)}. Reiniciando processo para carregar os novos módulos...`,
          );
          process.exit(0);
        } else {
          console.log(
            `[AutoUpdater] ✓ Código já está no commit mais recente (${currentSha.slice(0, 7)}).`,
          );
        }
      } catch (err: any) {
        console.warn(
          `[AutoUpdater] ⚠️ Não foi possível verificar origin/main no boot (${err?.message || err}). Seguindo inicialização normal.`,
        );
      }
    }

    // Garante que o bundle dist/ esteja sempre compilado para o commit HEAD atual
    const builtSha = this.getBuiltSha();
    const indexHtmlExists = fs.existsSync(path.join(DIST_DIR, "index.html"));
    if (currentSha !== "unknown" && (!indexHtmlExists || builtSha !== currentSha)) {
      console.log(
        `[AutoUpdater] 📦 Bundle dist/ (${builtSha ? builtSha.slice(0, 7) : "ausente"}) difere do HEAD (${currentSha.slice(0, 7)}). Recompilando automaticamente...`,
      );
      this.buildFrontend(currentSha);
    }
  }

  public static getStatus(checkRemote = false): AutoUpdateStatus {
    const currentSha = this.getCurrentSha();
    const builtSha = this.getBuiltSha();
    if (checkRemote) {
      try {
        this.runGit("fetch origin main", 10000);
        this.lastRemoteSha = this.runGit("rev-parse origin/main", 5000);
        this.lastCheckedAt = new Date().toISOString();
      } catch {
        // ignore network errors
      }
    }
    const remoteSha = this.lastRemoteSha;
    const hasUpdate = Boolean(
      remoteSha && currentSha !== "unknown" && remoteSha !== currentSha,
    );

    return {
      currentSha,
      builtSha,
      remoteSha,
      hasUpdate,
      autoUpdateOnStart: this.isAutoUpdateEnabled(),
      lastCheckedAt: this.lastCheckedAt,
    };
  }

  public static triggerUpdateAndRestart(): {
    updated: boolean;
    previousSha: string;
    newSha: string;
    message: string;
  } {
    this.ensureSafeDirectory();
    const previousSha = this.getCurrentSha();
    this.runGit("fetch origin main", 20000);
    const remoteSha = this.runGit("rev-parse origin/main", 5000);
    this.lastRemoteSha = remoteSha;
    this.lastCheckedAt = new Date().toISOString();

    const backups = this.backupRuntimeFiles();
    if (remoteSha !== previousSha) {
      this.runGit("reset --hard origin/main", 15000);
      this.restoreRuntimeFiles(backups);
    }

    const newSha = this.getCurrentSha();
    this.buildFrontend(newSha);

    // Agenda saída limpa após enviar a resposta HTTP para o Docker reiniciar o container
    setTimeout(() => {
      console.log(
        `[AutoUpdater] 🔄 Reiniciando container após update (${previousSha.slice(0, 7)} -> ${newSha.slice(0, 7)})...`,
      );
      process.exit(0);
    }, 600);

    return {
      updated: remoteSha !== previousSha,
      previousSha,
      newSha,
      message:
        remoteSha !== previousSha
          ? `Atualizado de ${previousSha.slice(0, 7)} para ${newSha.slice(0, 7)}! Reiniciando container...`
          : `Frontend recompilado no commit ${newSha.slice(0, 7)}! Reiniciando container...`,
    };
  }
}
