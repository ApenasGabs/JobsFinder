export interface ResilientFetchOptions extends RequestInit {
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  backoffFactor?: number;
  source?: string;
}

/**
 * Utilitário de requisição HTTP resiliente para scrapers e serviços externos:
 * - Timeout configurável (padrão 10.000 ms) via AbortController.
 * - Retentativas automáticas (padrão 1 retry) com backoff exponencial para timeouts ou 5xx.
 * - Não retenta respostas determinísticas de cliente (ex: 400, 401, 403, 404, 429).
 */
export async function resilientFetch(
  url: string,
  options: ResilientFetchOptions = {},
): Promise<Response> {
  const {
    timeoutMs = 10000,
    maxRetries = 1,
    retryDelayMs = 1000,
    backoffFactor = 2,
    source = "HTTP",
    headers,
    ...fetchOpts
  } = options;

  let lastError: any = null;
  let delay = retryDelayMs;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...fetchOpts,
        headers,
        signal: controller.signal,
      });
      clearTimeout(timer);

      // Se for 5xx (erro temporário do servidor remoto) e ainda houver tentativas, aplica retry com backoff
      if (response.status >= 500 && attempt < maxRetries) {
        console.warn(
          `[ResilientFetch][${source}] Resposta HTTP ${response.status} de ${url}. Tentando novamente em ${delay}ms...`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= backoffFactor;
        continue;
      }

      return response;
    } catch (err: any) {
      clearTimeout(timer);
      lastError = err;
      const isTimeout =
        err?.name === "AbortError" || err?.message?.includes("aborted");

      if (attempt < maxRetries) {
        const reason = isTimeout
          ? `Timeout (${timeoutMs}ms)`
          : err?.message || String(err);
        console.warn(
          `[ResilientFetch][${source}] Falha na requisição para ${url} (${reason}). Tentando novamente em ${delay}ms (tentativa ${attempt + 1}/${maxRetries})...`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= backoffFactor;
      }
    }
  }

  throw lastError;
}
