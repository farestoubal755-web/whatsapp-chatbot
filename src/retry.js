function defaultIsRetryable(err) {
  const status = err?.status ?? err?.code ?? err?.response?.status;
  if (status === 429) return true;
  if (typeof status === "number" && status >= 500) return true;
  return /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up/i.test(err?.message || "");
}

// Generic exponential-backoff retry wrapper shared by the Sheets, OpenAI and
// WhatsApp clients so transient network/rate-limit errors don't drop a
// customer message on the floor.
export async function withRetry(fn, { retries = 3, baseDelayMs = 300, label = "operation", isRetryable = defaultIsRetryable } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt > retries || !isRetryable(err)) throw err;
      const delay = Math.round(baseDelayMs * 2 ** (attempt - 1) + Math.random() * 100);
      console.warn(`[retry] ${label} failed (attempt ${attempt}/${retries}): ${err.message}. Retrying in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
