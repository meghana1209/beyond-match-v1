/* =========================================================
   GEMINI / LLM CLIENT  —  BeyondMatch
   ─────────────────────────────────────────────────────────
   Thin wrapper around the backend /llm endpoint.
   Kept named "callGemini" for backward compatibility.

   PER-FEATURE PROVIDER ROUTING
   ─────────────────────────────
   Pass an optional feature key as the second argument.
   The key maps to a `provider_hint` sent to the Lambda,
   which reorders its PROVIDERS list so the preferred one
   runs first and the rest serve as automatic fallbacks.

   FEATURE KEY → PREFERRED PROVIDER
   ──────────────────────────────────────────────────────
   "recommendations"    → groq         candidate.js  enrichMatchesWithLLM()
   "know_more"          → groq         candidate.js  openKnowMoreModal()
   "rec_summaries"      → groq         api.js        enrichCandidatesWithLLM()
   "candidate_analysis" → groq         api.js        openCandidateAnalysis()
   "draft_email"        → openrouter   api.js        aiDraftBtn handler
   "resume_analysis"    → openrouter   resume.html   runAnalysis()
   "jd_parse"           → openrouter   rec-postjob.html  aiParse()
   "cover_letter"       → openrouter   (future)
   (omitted / unknown)  → no hint      Lambda picks first available

   CALL SIGNATURES
   ───────────────
   // Existing call — unchanged, still works
   const text = await callGemini(prompt);

   // New: pass feature key as second argument
   const text = await callGemini(prompt, "draft_email");
   const text = await callGemini(prompt, "recommendations");

   LAMBDA CHANGE REQUIRED
   ───────────────────────
   Add ~8 lines to lambda_handler() — see the Python snippet
   in the project docs or the comment at the bottom of this file.
   ─────────────────────────────────────────────────────────
========================================================= */

const LLM_ENDPOINT = "https://2bcj60lax1.execute-api.eu-north-1.amazonaws.com/prod/llm";

/* ─── Feature → provider hint map ───────────────────────
   Values are matched case-insensitively against provider
   "name" fields in the Lambda PROVIDERS list.
   Add new features here without touching any call site.
   ──────────────────────────────────────────────────────── */
const FEATURE_PROVIDER_MAP = {
  // Speed-first → Groq  (real-time UI, high call volume)
  recommendations:      "groq",
  know_more:            "groq",
  rec_summaries:        "groq",
  candidate_analysis:   "groq",

  // Quality-first → OpenRouter / Gemini  (user reads the output carefully)
  draft_email:          "openrouter",
  resume_analysis:      "openrouter",
  cover_letter:         "openrouter",
  jd_parse:             "openrouter",
};

/* ─── In-memory prompt cache ─────────────────────────────
   Cache key includes feature so the same prompt sent via
   different features never collides. Cleared on page reload.
   ──────────────────────────────────────────────────────── */
const _promptCache = new Map();

function _hashPrompt(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

/**
 * Send a prompt to the LLM endpoint.
 * Retries once after 2 s on failure. Results are cached in-memory.
 *
 * @param {string} prompt        — The full prompt text.
 * @param {string} [feature=""]  — Optional feature key from FEATURE_PROVIDER_MAP.
 *                                 Determines which provider the Lambda tries first.
 *                                 Omit (or pass "") for backward-compatible default.
 * @returns {Promise<string>}    — Raw text response, or "" on failure.
 */
export async function callGemini(prompt, feature = "") {
  const providerHint = feature ? (FEATURE_PROVIDER_MAP[feature] || "") : "";
  const cacheKey     = _hashPrompt(feature + "|" + prompt);

  if (_promptCache.has(cacheKey)) return _promptCache.get(cacheKey);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const body = { prompt };
      if (providerHint) body.provider_hint = providerHint;

      const res = await fetch(LLM_ENDPOINT, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body)
      });

      if (res.ok) {
        const data   = await res.json();
        const result = data?.result || "";
        if (result) _promptCache.set(cacheKey, result);
        return result;
      }

      if (attempt === 0) await new Promise(r => setTimeout(r, 2000));
    } catch {
      if (attempt === 0) await new Promise(r => setTimeout(r, 2000));
    }
  }

  return "";
}

export function isGeminiAvailable() {
  return true;
}


/* =========================================================
   LAMBDA SETUP  (copy-paste into your Python handler)
   ─────────────────────────────────────────────────────────
   In lambda_handler(), after parsing the body and before
   the provider loop, add this block:

     provider_hint = body.get("provider_hint", "").lower()

     # Reorder so the hinted provider runs first;
     # the rest stay as fallbacks in their original order.
     if provider_hint:
         ordered = sorted(
             PROVIDERS,
             key=lambda p: 0 if provider_hint in p["name"].lower() else 1
         )
     else:
         ordered = PROVIDERS

     for provider in ordered:          # ← was: for provider in PROVIDERS:
         result = _call_provider(provider, prompt)
         if result:
             return {
                 "statusCode": 200,
                 "headers": {**CORS_HEADERS, "Content-Type": "application/json"},
                 "body": json.dumps({"result": result, "provider": provider["name"]}),
             }

   That's the only Lambda change needed. The fallback chain
   and CORS handling are unchanged.
========================================================= */