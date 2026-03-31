
const LLM_ENDPOINT = "https://2bcj60lax1.execute-api.eu-north-1.amazonaws.com/prod/llm";

/* ── Prompt cache (in-memory, cleared on page reload) ── */
const _promptCache = new Map();

function _hashPrompt(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

/* =========================================================
   PUBLIC: callGemini  (name kept for backward compat)
========================================================= */
// AFTER:
export async function callGemini(prompt) {
  const cacheKey = _hashPrompt(prompt);
  if (_promptCache.has(cacheKey)) {
    return _promptCache.get(cacheKey);
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(LLM_ENDPOINT, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ prompt })
      });

      if (res.ok) {
        const data = await res.json();
        const result = data?.result || "";
        if (result) _promptCache.set(cacheKey, result);
        return result;
      }

      // 504 or other server error — retry once after 2s
      if (attempt === 0) await new Promise(r => setTimeout(r, 2000));

    } catch {
      if (attempt === 0) await new Promise(r => setTimeout(r, 2000));
    }
  }

  return "";
}

/* =========================================================
   PUBLIC: isGeminiAvailable
========================================================= */
export function isGeminiAvailable() {
  return true;
}