/* =========================================================
   FIREBASE IMPORTS
========================================================= */
import {
  collection,
  getDocs,
  getDoc,
  setDoc,
  deleteDoc,
  doc,
  query,
  where,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

import { analytics }       from "./auth.js";
import { logEvent }        from "https://www.gstatic.com/firebasejs/10.7.1/firebase-analytics.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { callGemini, isGeminiAvailable } from "./gemini.js";

// These are intentionally read lazily so that if auth.js sets window.db /
// window.auth slightly after this module parses (both are type=module and
// execute in order, but async Firebase init can still race), all downstream
// code picks up the live values rather than an undefined snapshot.
let db   = window.db   || null;
let auth = window.auth || null;
// Refresh once the DOM is ready — by then auth.js has definitely run
document.addEventListener("DOMContentLoaded", () => {
  if (!db)   db   = window.db   || db;
  if (!auth) auth = window.auth || auth;
}, { once: true });

const API_BASE = "https://2bcj60lax1.execute-api.eu-north-1.amazonaws.com/prod";


/* =========================================================
   ROLE INFERENCE
   Detects a candidate's likely role from resume keywords.
========================================================= */
function inferRoleFromResume(text = "") {
  const t = text.toLowerCase();

  const ROLE_KEYWORDS = {
    "Backend Developer":    ["backend", "node", "django", "flask", "api", "database", "express"],
    "Frontend Developer":   ["frontend", "html", "css", "react", "ui"],
    "Full Stack Developer":  ["full stack", "mern", "frontend", "backend"],
    "Software Engineer":    ["software engineer", "java", "javascript"],
    "Data Scientist":       ["machine learning", "deep learning", "statistics", "model"],
    "Data Analyst":         ["data analyst", "power bi", "tableau", "excel", "analytics"],
    "DevOps Engineer":      ["docker", "kubernetes", "aws", "ci/cd"],
    "AI Engineer":          ["nlp", "computer vision", "llm"]
  };

  let bestRole = "General", maxScore = 0;
  for (const role in ROLE_KEYWORDS) {
    const score = ROLE_KEYWORDS[role].filter(k => t.includes(k)).length;
    if (score > maxScore) { maxScore = score; bestRole = role; }
  }
  return bestRole;
}


/* =========================================================
   UPLOAD CANDIDATE
   Posts candidate to backend then writes metadata to Firestore.
========================================================= */
async function uploadCandidate(name, email, resumeText) {
  const res = await apiFetch("/candidates", {
    method: "POST",
    body:   JSON.stringify({ name, email, resume_text: resumeText || "" })
  });

  const backendCandidateId =
    res?.candidate_id ||
    (typeof res?.body === "string" && JSON.parse(res.body)?.candidate_id);

  if (!backendCandidateId) throw new Error("Backend did not return candidate_id");

  const inferredRole = inferRoleFromResume(resumeText);

  await setDoc(doc(db, "candidates", backendCandidateId), {
    candidate_id: backendCandidateId,
    name,
    email,
    user_id:      auth.currentUser.uid,
    applied_role: inferredRole,
    createdAt:    serverTimestamp()
  });

  logEvent(analytics, "candidate_created", {
    recruiter_id:  auth.currentUser.uid,
    role_detected: inferredRole
  });

  return res;
}

window.uploadCandidate = uploadCandidate;


/* =========================================================
   LOAD USER'S RESUMES
   Populates the candidate select with only resumes uploaded
   by the current user, with the latest resume pre-selected.
========================================================= */
async function loadUserCandidatesOnly() {
  const select = document.getElementById("candidateSelect");
  if (!select) return;

  const user = auth.currentUser;
  if (!user) return;

  select.innerHTML = `<option value="">Select your resume</option>`;

  const [snapshot, userSnap] = await Promise.all([
    getDocs(query(collection(db, "candidates"), where("user_id", "==", user.uid))),
    getDoc(doc(db, "users", user.uid)).catch(() => null)
  ]);

  const latestId = userSnap?.exists?.() ? (userSnap.data().latest_candidate_id || null) : null;

  // Deduplicate and sort newest first
  const seenIds = new Set();
  const userDocs = [];
  snapshot.forEach(docSnap => {
    if (seenIds.has(docSnap.id)) return;
    seenIds.add(docSnap.id);
    userDocs.push({ id: docSnap.id, ...docSnap.data() });
  });
  userDocs.sort((a, b) => (b.createdAt?.seconds ?? 0) - (a.createdAt?.seconds ?? 0));

  const latestDocId = latestId || (userDocs[0]?.id ?? null);
  const ordered     = [
    ...userDocs.filter(d => d.id === latestDocId),
    ...userDocs.filter(d => d.id !== latestDocId)
  ];

  ordered.forEach(data => {
    const isLatest = data.id === latestDocId;
    const role     = data.applied_role || "General";
    const dateStr  = data.createdAt?.toDate
      ? data.createdAt.toDate().toLocaleDateString("en-GB", { day: "2-digit", month: "short" })
      : "";

    const option       = document.createElement("option");
    option.value       = data.id;
    option.textContent = isLatest
      ? `★ ${data.name} – ${role}${dateStr ? ` (${dateStr})` : ""} [Latest]`
      : `${data.name} – ${role}${dateStr ? ` (${dateStr})` : ""}`;
    if (isLatest) option.selected = true;

    select.appendChild(option);
  });
}


/* =========================================================
   LOAD ALL CANDIDATES  (admin / recruiter view)
========================================================= */
async function loadCandidates() {
  const select = document.getElementById("candidateSelect");
  if (!select) return;

  select.innerHTML = `<option value="">Loading candidates...</option>`;

  const snapshot = await getDocs(collection(db, "candidates"));
  select.innerHTML = `<option value="">Select candidate</option>`;

  snapshot.forEach(docSnap => {
    const data = docSnap.data();
    if (docSnap.id !== data.candidate_id) return; // skip duplicates

    const option       = document.createElement("option");
    option.value       = docSnap.id;
    option.textContent = data.name;
    select.appendChild(option);
  });
}


/* =========================================================
   LLM ENRICHMENT — CANDIDATE SIDE
   Re-ranks matches and adds a "why this fits you" insight.
   Cached in sessionStorage so it survives page re-renders.
========================================================= */
const llmMatchCache = {
  _key: k => `llmCache_v3_${k}`,
  get(k) {
    if (!k) return null;
    try {
      const raw = sessionStorage.getItem(this._key(k));
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  },
  set(k, v) {
    if (!k) return;
    try { sessionStorage.setItem(this._key(k), JSON.stringify(v)); } catch { /* storage full */ }
  }
};

async function enrichMatchesWithLLM(matches, allJobs, cacheKey) {
  if (cacheKey) {
    const cached = llmMatchCache.get(cacheKey);
    // Skip cache if it's a stale failed run where every insight is null
    if (cached && cached.some(r => r.ai_insight !== null)) return cached;
  }

  const top10 = matches.slice(0, 10);
  const slim  = top10.map((m, i) => {
    const job = allJobs.find(j => j.job_id === m.job_id) || {};
    return {
      index:         i,
      job_id:        m.job_id,
      title:         m.title || job.title || "Unknown",
      jd_snippet:    (job.description || m.description || m.jd || "").slice(0, 200),
      match_percent: m.match_percent
    };
  });

  const prompt = `You are a career advisor helping a candidate understand their job matches.
For each job write ONE short sentence (max 14 words) telling the candidate something specific about why this role could suit them.
Rules:
- Read jd_snippet carefully — mention what the role actually involves
- If jd_snippet is empty, infer from the job title
- NEVER use: "high match", "great fit", "strong match", "relevant experience", "aligns with your background"
- Each sentence must be unique and specific to that job
- NEVER return null for ai_insight — always write something based on the title if nothing else
- Re-rank by match_percent descending (higher % = ai_rank 1)
Return ONLY a raw JSON array, no markdown:
[{"index":<n>,"job_id":"...","ai_rank":<n>,"ai_insight":"<one specific sentence about this role>"}]

Jobs:
${JSON.stringify(slim)}`;

  try {
    const raw = await Promise.race([
      callGemini(prompt),
      new Promise(resolve => setTimeout(() => resolve(""), 12000))
    ]);

    if (!raw) return matches.map((m, i) => {
      const job = allJobs.find(j => j.job_id === m.job_id) || {};
      const title = m.title || job.title || "this role";
      return { job_id: m.job_id, ai_rank: i + 1, ai_insight: `Focuses on ${title.toLowerCase()} responsibilities and related skills.` };
    });

    const clean   = raw.replace(/```json|```/g, "").trim();
    const jsonStr = clean.match(/\[[\s\S]*\]/)?.[0] || clean;
    const parsed  = JSON.parse(jsonStr);

    const byJobId = {}, byIndex = {};
    parsed.forEach(r => {
      if (r.job_id)        byJobId[r.job_id] = r;
      if (r.index != null) byIndex[r.index]  = r;
    });

    const result = matches.map((m, i) => {
      const r = byJobId[m.job_id] || byIndex[i] || {};
      return { job_id: m.job_id, ai_rank: r.ai_rank ?? (i + 1), ai_insight: r.ai_insight || null };
    });

    if (cacheKey) llmMatchCache.set(cacheKey, result);
    return result;

  } catch {
    return matches.map((m, i) => {
      const job = allJobs.find(j => j.job_id === m.job_id) || {};
      const title = m.title || job.title || "this role";
      return { job_id: m.job_id, ai_rank: i + 1, ai_insight: `Focuses on ${title.toLowerCase()} responsibilities and related skills.` };
    });
  }
}


/* =========================================================
   RESOLVE LOCAL ID → BACKEND ID
   If signup failed to reach the backend, the candidate has a
   "local_<uid>" placeholder ID. This function registers them
   and migrates their Firestore documents to the real ID.
========================================================= */
async function resolveToBackendId(localId) {
  if (!localId.startsWith("local_")) return localId;

  const snap = await getDoc(doc(db, "candidates", localId));
  if (!snap.exists()) return localId;

  const data       = snap.data();
  const resumeText = data.resume_text || "";
  if (!resumeText.trim()) return localId; // nothing to register without a resume

  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 8000);

    const res = await fetch(`${API_BASE}/candidates`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      signal:  controller.signal,
      body:    JSON.stringify({
        name:        data.name || data.email?.split("@")[0] || "candidate",
        email:       data.email,
        resume_text: resumeText
      })
    });

    let parsed = {};
    try { parsed = JSON.parse(await res.text()); } catch { }

    const backendId =
      parsed?.candidate_id ||
      (typeof parsed?.body === "string"
        ? (() => { try { return JSON.parse(parsed.body)?.candidate_id; } catch { return null; } })()
        : null);

    if (!backendId) return localId;

    // Migrate to real ID
    const user = auth.currentUser;
    await setDoc(doc(db, "candidates", backendId), { ...data, candidate_id: backendId, is_latest: true, createdAt: serverTimestamp() });
    if (user) {
      await setDoc(doc(db, "users", user.uid), { candidate_id: backendId, latest_candidate_id: backendId }, { merge: true });
    }
    try { await deleteDoc(doc(db, "candidates", localId)); } catch { }

    return backendId;

  } catch (err) {
    console.warn(err.name === "AbortError" ? "Backend timed out" : "Backend failed:", err.message);
    return localId;
  }
}


/* =========================================================
   JOB MATCH SKELETON LOADERS
========================================================= */
function _jobMatchSkeleton() {
  return `
    <div class="skeleton-card">
      <div class="skel-row">
        <div style="flex:1;">
          <div class="skel skel-h20" style="width:160px;margin-bottom:6px;"></div>
          <div class="skel skel-h14" style="width:100px;"></div>
        </div>
        <div class="skel skel-circle"></div>
      </div>
      <div class="skel-row" style="gap:6px;">
        <div class="skel skel-h10" style="width:80px;border-radius:5px;"></div>
        <div class="skel skel-h10" style="width:90px;border-radius:5px;"></div>
      </div>
      <div class="skel skel-h14" style="width:60%;"></div>
      <div class="skel skel-h10" style="width:80%;"></div>
      <div class="skel skel-h10" style="width:60%;"></div>
      <div class="skel-row" style="gap:5px;margin-top:2px;">
        <div class="skel skel-h10" style="width:50px;border-radius:5px;"></div>
        <div class="skel skel-h10" style="width:60px;border-radius:5px;"></div>
        <div class="skel skel-h10" style="width:44px;border-radius:5px;"></div>
      </div>
      <div class="skel-row" style="gap:8px;margin-top:4px;">
        <div class="skel skel-h34" style="flex:1;"></div>
        <div class="skel skel-h34" style="flex:1;"></div>
        <div class="skel skel-h34" style="flex:1;"></div>
      </div>
    </div>`;
}

function _showJobMatchSkeletons(grid, count = 8) {
  if (!grid) return;
  grid.innerHTML = Array(count).fill(null).map(_jobMatchSkeleton).join("");
}


/* =========================================================
   LOAD JOB MATCHES
   Fetches raw matches, enriches via Gemini, then renders.
   Also caches matched job IDs for LocateHire to consume.
========================================================= */
async function loadCandidateJobMatches() {
  const select      = document.getElementById("candidateSelect");
  const candidateId = select?.value;
  const grid        = document.getElementById("matchesGrid");

  if (!candidateId) {
    if (window.showToast) window.showToast("Please select a resume first.", "warning");
    return;
  }

  _showJobMatchSkeletons(grid, 8);

  // Ensure local placeholder ID is migrated to a real backend ID before matching
  const resolvedId = await resolveToBackendId(candidateId);
  if (resolvedId !== candidateId) {
    const opt = select.querySelector(`option[value="${candidateId}"]`);
    if (opt) opt.value = resolvedId;
    select.value = resolvedId;
  }

  if (resolvedId.startsWith("local_")) {
    grid.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
          </svg>
        </div>
        <h4>Resume not yet uploaded</h4>
        <p>Go to <a href="resume.html" style="color:#7aa2ff;">Resume Analysis</a> and upload your resume first to enable job matching.</p>
      </div>`;
    return;
  }

  // Fetch matches and all jobs in parallel — cuts load time ~50%
  const [res, jobsRes] = await Promise.all([
    apiFetch(`/matches?candidate_id=${resolvedId}&top_n=50&offset=0`),
    apiFetch("/jobs")
  ]);

  let data    = typeof res?.body === "string" ? JSON.parse(res.body) : res;
  const matches = Array.isArray(data) ? data : (data.matches || []);

  if (!matches.length) {
    grid.innerHTML = `
      <div class="empty-state">
        <h4>No matches found</h4>
        <p>We couldn't find any suitable jobs for this candidate right now.</p>
      </div>`;
    return;
  }

  // Share matched job IDs with LocateHire (avoids a second API call there)
  try {
    sessionStorage.setItem("bm_matched_job_ids", JSON.stringify(matches.map(m => String(m.job_id))));
  } catch { }

  // /jobs returns either a bare array  OR  { jobs: [...], next_key }
  // Handle all three shapes: array, wrapped object, or stringified body.
  let allJobs = (() => {
    if (Array.isArray(jobsRes)) return jobsRes;
    if (Array.isArray(jobsRes?.jobs)) return jobsRes.jobs;
    try {
      const parsed = JSON.parse(jobsRes?.body || "[]");
      return Array.isArray(parsed) ? parsed : (parsed?.jobs || []);
    } catch { return []; }
  })();

  const llmResults = await enrichMatchesWithLLM(matches, allJobs, candidateId);
  const llmMap     = {};
  llmResults.forEach(r => { llmMap[r.job_id] = r; });

  // Sort by AI rank
  const ranked = [...matches].sort((a, b) => {
    const ra = llmMap[a.job_id]?.ai_rank ?? 999;
    const rb = llmMap[b.job_id]?.ai_rank ?? 999;
    return ra - rb;
  });

  // FIX: Build cards into an array and set innerHTML once at the end.
  // The original code used `grid.innerHTML +=` inside a loop which destroys
  // and recreates ALL existing DOM nodes on every iteration — this breaks
  // any event listeners already attached and is O(n²) for large lists.
  const cardFragments = [];
  window.__jobCardData = window.__jobCardData || {};

  ranked.forEach((match, idx) => {
    const job      = allJobs.find(j => j.job_id === match.job_id) || match || {};
    const location = job.location_display || job.location ||
      (job.city && job.country ? `${job.city}, ${job.country}` : job.city || job.country || "Not specified");
    const company  = job.company || match.company || "Company not available";

    let salary = "Salary not disclosed";
    if (job.salary_min && job.salary_max) {
      salary = `$${Math.round(job.salary_min).toLocaleString()} – $${Math.round(job.salary_max).toLocaleString()}`;
    } else if (job.salary_min) {
      salary = `From $${Math.round(job.salary_min).toLocaleString()}`;
    } else if (job.salary_max) {
      salary = `Up to $${Math.round(job.salary_max).toLocaleString()}`;
    }

    const percent   = match.match_percent != null ? match.match_percent.toFixed(1) : "0.0";
    const aiInsight = llmMap[match.job_id]?.ai_insight;
    const isTopPick = idx === 0;

    const cardData = {
      job_id:       job.job_id || match.job_id,
      // FIX: Store the Firestore doc id separately so applyToJob() receives it
      // correctly; job.job_id is the backend numeric/string id, which can differ
      // from the Firestore document id.
      firestore_id: job.id || job.firestore_id || job.job_id || match.job_id,
      title:        match.title || job.title || "Job Title",
      company,
      location,
      salary,
      percent,
      description:  job.description || "",
      apply_url:    job.apply_url || match.apply_url || "",
      // FIX: Normalise source to lowercase so "BeyondMatch", "beyondmatch",
      // "beyond_match" etc. all route correctly to applyToJob().
      // The original strict equality check `=== "beyondmatch"` missed any
      // variation in casing, silently sending internal jobs down the external
      // link path and skipping applyToJob() entirely.
      source:       (job.source || match.source || "").toLowerCase(),
      recruiter_id: job.recruiter_id || match.recruiter_id || ""
    };

    // Store job data in a global map keyed by job_id.
    // FIX: The original code used JSON.stringify(job) inside the onclick
    // attribute string, which broke whenever title or description contained
    // single quotes or double quotes — the HTML attribute would terminate
    // early and the JS parser would throw. Reading from __jobCardData via
    // data-savejobid avoids all quoting issues entirely.
    window.__jobCardData[cardData.job_id] = { ...cardData, candidateId };

    // Match ring geometry (SVG circle, r=18, circumference≈113)
    const pct      = parseFloat(percent);
    const circ     = 113;
    const offset   = circ - (pct / 100) * circ;
    const ringColor = pct >= 80 ? "#4ade80" : pct >= 60 ? "#7aa2ff" : pct >= 40 ? "#fbbf24" : "#f87171";

    cardFragments.push(`
      <div class="match-card ${isTopPick ? "top-pick" : ""}"
           style="animation-delay:${idx * 60}ms"
           data-location="${location}"
           data-match="${percent}"
           data-salary="${job.salary_min || 0}"
           data-jobid="${cardData.job_id}">

        ${isTopPick ? `<span class="top-pick-badge">★ AI Top Pick</span>` : ""}

        <div class="match-card-header">
          <div class="match-card-titles">
            <div class="match-card-title">${cardData.title}</div>
            <div class="match-card-company">${company}</div>
          </div>
          <div class="match-pct">
            <div class="match-ring">
              <svg viewBox="0 0 40 40">
                <circle class="ring-bg"   cx="20" cy="20" r="18"/>
                <circle class="ring-fill"
                  cx="20" cy="20" r="18"
                  stroke="${ringColor}"
                  stroke-dasharray="${circ}"
                  stroke-dashoffset="${offset}"
                  fill="none" stroke-width="3.5" stroke-linecap="round"
                  style="transform:rotate(-90deg);transform-origin:center"/>
              </svg>
              <div class="match-ring-label">${Math.round(pct)}%</div>
            </div>
          </div>
        </div>

        <div class="match-meta">
          <span class="meta-chip">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>
            </svg>
            ${location}
          </span>
        </div>

        <div class="match-salary">${salary}</div>

        ${aiInsight ? `<div class="match-insight">✦ ${aiInsight}</div>` : ""}

        <div class="match-actions">
          ${(cardData.source === "beyondmatch" || (!cardData.source && !!cardData.recruiter_id))
            // FIX: Also treat jobs with a recruiter_id but no source as internal.
            // If the backend omits the source field entirely, the original strict
            // equality check failed and the external-link button was rendered —
            // that button has no data-apply-job attribute, so _applyClick()
            // couldn't resolve jobId and logged "APPLY CLICKED undefined".
            ? `<button class="match-btn apply"
  data-apply-job="${cardData.job_id || cardData.id}"
  data-job-title="${cardData.title.replace(/"/g, '&quot;')}"
  data-recruiter-id="${cardData.recruiter_id || ''}"
  data-firestore-id="${cardData.firestore_id || cardData.job_id || cardData.id}"
  data-candidate-id="${candidateId}"
  onclick="window._applyClick(this)">
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
    <polyline points="15 3 21 3 21 9"/>
    <line x1="10" y1="14" x2="21" y2="3"/>
  </svg>
  Apply
</button>`
            : `<button class="match-btn apply"
                 data-apply-url="${(cardData.apply_url || '#').replace(/"/g, '&quot;')}"
                 onclick="openApplyLink(this.dataset.applyUrl)">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
                </svg>
                Apply
              </button>`
          }
          <button class="match-btn save"
                  data-savejobid="${cardData.job_id}"
                  data-candidate-id="${candidateId}"
                  onclick="handleSaveJob(this, window.__jobCardData[this.dataset.savejobid], this.dataset.candidateId)">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
            </svg>
            Save
          </button>
          <button class="match-btn know know-more-btn" data-jobid="${cardData.job_id}">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            Know More
          </button>
        </div>
      </div>
    `);
  });

  // Write all cards in one shot — avoids the O(n²) innerHTML += loop
  grid.innerHTML = cardFragments.join("");

  setupMatchFilters();
  setupKnowMoreButtons(candidateId);

  // Mark any jobs the candidate has already applied to (greys out button)
  if (typeof window.markApplyButtons === "function") {
    window.markApplyButtons(ranked.map(m => ({
      job_id:       m.job_id,
      recruiter_id: (allJobs.find(j => j.job_id === m.job_id) || m).recruiter_id || ""
    })));
  }
}


/* =========================================================
   MATCH FILTERS
   Filters visible job cards by location and minimum match
   percentage; sorts by salary.
========================================================= */
function setupMatchFilters() {
  const locationFilter = document.getElementById("locationFilter");
  const matchFilter    = document.getElementById("matchFilter");
  const salarySort     = document.getElementById("salarySort");
  if (!locationFilter) return;

  const cards = () => document.querySelectorAll(".match-card");

  // Populate location dropdown from card data
  const locations = new Set();
  cards().forEach(c => locations.add(c.dataset.location));
  locationFilter.innerHTML =
    `<option value="">All Locations</option>` +
    [...locations].map(l => `<option value="${l}">${l}</option>`).join("");

  function applyFilters() {
    const loc      = locationFilter.value;
    const minMatch = matchFilter.value;

    cards().forEach(card => {
      const visible =
        (!loc      || card.dataset.location === loc) &&
        (!minMatch || Number(card.dataset.match) >= Number(minMatch));
      card.style.display = visible ? "block" : "none";
    });

    if (salarySort.value) {
      const grid   = document.getElementById("matchesGrid");
      const sorted = [...cards()].sort((a, b) => {
        const diff = Number(a.dataset.salary) - Number(b.dataset.salary);
        return salarySort.value === "high" ? -diff : diff;
      });
      sorted.forEach(card => grid.appendChild(card));
    }
  }

  locationFilter.onchange = applyFilters;
  matchFilter.onchange    = applyFilters;
  salarySort.onchange     = applyFilters;
}

window.loadCandidateJobMatches = loadCandidateJobMatches;


/* =========================================================
   AUTH LISTENER
   Loads the user's resumes once they are authenticated.
========================================================= */
// Use window.auth directly here (not the cached `auth` const) so it's
// guaranteed to be the live Firebase Auth instance even on first load.
onAuthStateChanged(window.auth, (user) => {
  if (!user) return;
  const select = document.getElementById("candidateSelect");
  if (!select) return;
  loadUserCandidatesOnly();
});


/* =========================================================
   SAVE JOB
   Persists a shortlisted job to Firestore and tracks the
   interaction with the backend analytics endpoint.
========================================================= */
async function saveJobToFirebase(job, candidateId) {
  const user = auth.currentUser;
  if (!user) return;

  if (!job?.job_id) {
    if (window.showToast) window.showToast("Job data is missing. Please try again.", "error");
    return;
  }

  const docId = `${user.uid}_${candidateId}_${job.job_id}`;

  await setDoc(doc(db, "saved_jobs", docId), {
    user_id:      user.uid,
    candidate_id: candidateId,
    job_id:       job.job_id,
    title:        job.title    || "Untitled Job",
    company:      job.company  || "Company not available",
    location:
      job.location_display || job.location ||
      (job.city && job.country ? `${job.city}, ${job.country}` : "Location not specified"),
    salary_min:   job.salary_min ?? null,
    salary_max:   job.salary_max ?? null,
    description:  job.description || "",
    apply_url:    job.apply_url || "#",
    savedAt:      serverTimestamp()
  });

  trackInteraction({ job_id: job.job_id, candidate_id: candidateId, action: "shortlist" });

  if (window.showToast) window.showToast("Job saved to your list.", "success");
}


/* =========================================================
   INTERACTION TRACKING
   Sends candidate interaction events to the backend.
========================================================= */
async function trackInteraction({ job_id, candidate_id, action }) {
  try {
    await fetch(`${API_BASE}/trackInteraction`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ job_id, candidate_id, action })
    });
  } catch (err) {
    console.warn("Interaction tracking failed:", err);
  }
}


/* =========================================================
   OPEN APPLY LINK
========================================================= */
function openApplyLink(url) {
  if (!url || url === "#" || url.trim() === "") {
    if (window.showToast) window.showToast("No application link available for this job.", "warning");
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}


/* =========================================================
   HANDLE APPLY — BEYONDMATCH JOBS
   Called when the Apply button is clicked on a BeyondMatch-
   posted job. Delegates to applyToJob() from apply-job.js,
   then updates the button state on success.
   For external jobs the old openApplyLink() path is unchanged.
========================================================= */
async function handleApplyBeyondMatch(btn, jobId, jobTitle, recruiterId, candidateId, jobFirestoreId) {
  if (btn.disabled) return;                          // already applied
  btn.disabled      = true;
  btn.style.opacity = "0.7";
  btn.textContent   = "Applying…";

  let success = false;
  try {
    // applyToJob is loaded from apply-job.js (type=module, same page)
    if (typeof window.applyToJob !== "function") {
      throw new Error("applyToJob not loaded — make sure apply-job.js is included.");
    }
    // FIX: Pass jobFirestoreId as the 4th argument.
    // The original caller omitted this arg, so job_firestore_id in every
    // application document was always set to jobId instead of the real
    // Firestore document id.
    success = await window.applyToJob(jobId, jobTitle, recruiterId, jobFirestoreId);
  } catch (err) {
    console.error("handleApplyBeyondMatch:", err);
    if (window.showToast) window.showToast("Application failed. Please try again.", "error");
  }

  if (success) {
    btn.innerHTML = `
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
      Applied`;
    btn.style.opacity = "0.6";
    btn.style.cursor  = "default";
    // Track the interaction with the backend analytics endpoint
    trackInteraction({ job_id: jobId, candidate_id: candidateId, action: "apply" });
  } else {
    // Re-enable so they can retry (unless already-applied toast was shown)
    btn.disabled      = false;
    btn.style.opacity = "1";
    btn.innerHTML = `
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
      </svg>
      Apply`;
  }
}

window.handleApplyBeyondMatch = handleApplyBeyondMatch;

/* ─────────────────────────────────────────────────
   _applyClick
   FIX: Reads all apply params from data-* attributes instead of
   embedding them as inline function arguments. The old approach used
   JSON.stringify(job) directly in the onclick="..." string, which
   broke whenever job titles or descriptions contained quotes — the
   HTML attribute terminated early and the JS parser threw a SyntaxError.
   ───────────────────────────────────────────────── */
window._applyClick = async function (btn) {
  // FIX: dataset.jobId maps to data-job-id (hyphenated), but the card uses
  // data-jobid (no hyphen) which maps to dataset.jobid (all lowercase).
  // The original `dataset.jobId` fallback always returned undefined.
  const jobId =
    btn.dataset.applyJob ||
    btn.getAttribute("data-apply-job") ||
    btn.closest(".match-card")?.dataset.jobid;   // ← lowercase 'jobid'

  const jobTitle =
    btn.dataset.jobTitle ||
    btn.closest(".match-card")?.querySelector(".match-card-title")?.textContent?.trim() ||
    "Job";

  const recruiterId =
    btn.dataset.recruiterId ||
    btn.closest(".match-card")?.dataset.recruiterId ||
    "";

  const firestoreId = btn.dataset.firestoreId;

  console.log("APPLY CLICKED", jobId);

  // FIX: Guard — if jobId is still undefined here don't proceed.
  // Passing undefined to Firestore where() throws:
  // "Unsupported field value: undefined"
  if (!jobId) {
    console.error("_applyClick: could not resolve jobId from button", btn);
    if (typeof window.showToast === "function") {
      window.showToast("Could not identify the job. Please refresh and try again.", "error");
    }
    return;
  }

  if (typeof window.applyToJob !== "function") {
    console.error("applyToJob not loaded");
    return;
  }

  // Open the inline apply modal (defined in jobmatches.html) so the
  // candidate can add a cover note before submitting.
  if (typeof window.openApplyModal === "function") {
    window.openApplyModal(jobId, jobTitle, recruiterId, firestoreId);
    return;
  }

  // Fallback: direct apply without modal (e.g. on candidate-dashboard.html)
  btn.disabled  = true;
  btn.innerText = "Applying...";

  const success = await window.applyToJob(jobId, jobTitle, recruiterId, firestoreId);

  if (success) {
    btn.innerText         = "Applied ✓";
    btn.style.opacity     = "0.6";
    btn.style.cursor      = "default";
  } else {
    btn.disabled  = false;
    btn.innerText = "Apply";
  }

  return false;
};

/* =========================================================
   SAVE BUTTON HANDLER
   Provides visual feedback after saving — no alert.
========================================================= */
async function handleSaveJob(btn, job, candidateId) {
  if (btn.dataset.saved) return;
  try {
    await saveJobToFirebase(job, candidateId);
    btn.dataset.saved = "1";
    btn.classList.add("saved");
    btn.innerHTML = `
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
      Saved`;
  } catch (e) {
    console.error("Save failed:", e);
  }
}

window.handleSaveJob = handleSaveJob;


/* =========================================================
   GLOBAL EXPORTS
========================================================= */
window.loadCandidateJobMatches = loadCandidateJobMatches;
window.saveJobToFirebase       = saveJobToFirebase;
window.openApplyLink           = openApplyLink;


/* =========================================================
   KNOW MORE MODAL
   Shows an AI-generated breakdown of the job — summary,
   responsibilities, and personalised prep tips.
   Triggered by "Know More" buttons on match cards.
========================================================= */
const knowMoreCache = {}; // job_id → parsed LLM result

function setupKnowMoreButtons(candidateId) {
  document.querySelectorAll(".know-more-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const jobId  = btn.getAttribute("data-jobid");
      const jobData = window.__jobCardData?.[jobId];
      if (!jobData) return;
      openKnowMoreModal(jobData, candidateId);
    });
  });
}

async function openKnowMoreModal(jobData, candidateId) {

  // Inject modal once
  if (!document.getElementById("knowMoreOverlay")) {
    const overlay = document.createElement("div");
    overlay.id    = "knowMoreOverlay";
    overlay.style.cssText = `
      position:fixed; inset:0; background:rgba(0,0,0,0.75);
      backdrop-filter:blur(6px); z-index:1000;
      display:flex; align-items:center; justify-content:center;
      padding:20px; box-sizing:border-box;
    `;
    overlay.innerHTML = `
      <div id="knowMoreModal" style="
        background:#111827; border:1px solid #1f2937;
        border-radius:16px; width:100%; max-width:680px;
        max-height:85vh; overflow-y:auto;
        padding:32px; box-sizing:border-box;
        position:relative; color:#f9fafb; font-family:inherit;
      ">
        <button id="knowMoreClose" style="
          position:absolute; top:16px; right:18px;
          background:none; border:none; color:#9ca3af;
          font-size:22px; cursor:pointer; line-height:1;
        ">&#x2715;</button>
        <div id="knowMoreContent"></div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", e => { if (e.target === overlay) overlay.style.display = "none"; });
    document.getElementById("knowMoreClose").addEventListener("click", () => { overlay.style.display = "none"; });
  }

  const overlay = document.getElementById("knowMoreOverlay");
  const content = document.getElementById("knowMoreContent");
  overlay.style.display = "flex";

  // Show spinner while loading
  content.innerHTML = `
    <div style="margin-bottom:20px;">
      <div style="font-size:11px;color:#a78bfa;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px;">Job Breakdown</div>
      <h2 style="margin:0 0 4px;font-size:20px;color:#f9fafb;">${jobData.title}</h2>
      <p style="margin:0;color:#9ca3af;font-size:14px;">${jobData.company} &nbsp;·&nbsp; ${jobData.location} &nbsp;·&nbsp; ${jobData.salary}</p>
    </div>
    <div style="display:flex;align-items:center;gap:10px;color:#6b7280;font-size:14px;padding:20px 0;">
      <div style="
        width:20px;height:20px;border-radius:50%;
        border:2px solid #a78bfa;border-top-color:transparent;
        animation:spin 0.8s linear infinite;flex-shrink:0;
      "></div>
      Analysing job description…
    </div>
    <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
  `;

  if (knowMoreCache[jobData.job_id]) {
    renderKnowMoreResult(content, jobData, knowMoreCache[jobData.job_id]);
    return;
  }

  // Fetch candidate resume for personalised tips
  let resumeSnippet = "";
  try {
    const { getDoc, doc } = await import("https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js");
    const snap = await getDoc(doc(window.db, "candidates", candidateId));
    if (snap.exists()) resumeSnippet = (snap.data().resume_text || "").slice(0, 800);
  } catch { }

  const prompt = `You are a career coach helping a candidate understand a job and prepare for it.

Job Title: ${jobData.title}
Company: ${jobData.company}
Location: ${jobData.location}
Salary: ${jobData.salary}
Job Description:
${(jobData.description || "").slice(0, 1200)}

${resumeSnippet ? `Candidate Resume Snippet:\n${resumeSnippet}` : ""}

Return ONLY a raw JSON object, no markdown, no backticks:
{
  "summary": "2-3 sentence plain-English description of the role and what the company is looking for",
  "what_youll_do": ["bullet 1 (max 12 words)", "bullet 2", "bullet 3"],
  "tips": [
    { "title": "short tip title", "detail": "1 sentence personalised advice based on the resume" },
    { "title": "short tip title", "detail": "1 sentence advice" },
    { "title": "short tip title", "detail": "1 sentence advice" }
  ]
}`;

  try {
    const { callGemini } = await import("./gemini.js");
    let parsed = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await callGemini(prompt);
        if (!raw?.trim()) throw new Error("Empty LLM response");
        const clean   = raw.replace(/```json|```/g, "").trim();
        const jsonStr = clean.match(/\{[\s\S]*\}/)?.[0] || clean;
        parsed = JSON.parse(jsonStr);
        break;
      } catch {
        if (attempt === 0) {
          const note = document.createElement("p");
          note.id         = "kmRetryNote";
          note.style.cssText = "color:#9ca3af;font-size:12px;margin-top:8px;";
          note.textContent   = "Taking longer than usual, retrying…";
          content.appendChild(note);
          await new Promise(r => setTimeout(r, 1500));
          document.getElementById("kmRetryNote")?.remove();
        } else {
          throw new Error("Both LLM attempts failed");
        }
      }
    }

    knowMoreCache[jobData.job_id] = parsed;
    renderKnowMoreResult(content, jobData, parsed);
  } catch {
    content.innerHTML += `
      <p style="color:#ef4444;font-size:13px;margin-top:12px;">
        Analysis failed — please close and try again.
      </p>`;
  }
}

function renderKnowMoreResult(content, jobData, data) {
  const tipsHTML = (data.tips || []).map((t, i) => `
    <div style="
      display:flex; gap:14px; align-items:flex-start;
      padding:12px 14px; background:#0d1117;
      border-radius:10px; border:1px solid #1f2937;
    ">
      <div style="
        min-width:26px; height:26px; border-radius:50%;
        background:linear-gradient(135deg,#4f46e5,#a78bfa);
        display:flex; align-items:center; justify-content:center;
        font-size:12px; font-weight:700; color:#fff; flex-shrink:0;
      ">${i + 1}</div>
      <div>
        <div style="font-weight:600;font-size:13px;color:#f9fafb;margin-bottom:3px;">${t.title}</div>
        <div style="font-size:13px;color:#9ca3af;line-height:1.5;">${t.detail}</div>
      </div>
    </div>
  `).join("");

  const doHTML = (data.what_youll_do || []).map(d => `
    <li style="color:#d1d5db;font-size:13px;margin-bottom:6px;line-height:1.5;">${d}</li>
  `).join("");

  content.innerHTML = `
    <div style="margin-bottom:22px;">
      <div style="font-size:11px;color:#a78bfa;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px;">Job Breakdown</div>
      <h2 style="margin:0 0 4px;font-size:20px;color:#f9fafb;">${jobData.title}</h2>
      <p style="margin:0;color:#9ca3af;font-size:14px;">${jobData.company} &nbsp;·&nbsp; ${jobData.location} &nbsp;·&nbsp; ${jobData.salary}</p>
    </div>

    <div style="height:1px;background:#1f2937;margin-bottom:20px;"></div>

    <div style="margin-bottom:20px;">
      <div style="font-size:11px;color:#6b7280;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:10px;">About the Role</div>
      <p style="color:#d1d5db;font-size:14px;line-height:1.6;margin:0;">${data.summary || ""}</p>
    </div>

    ${doHTML ? `
    <div style="margin-bottom:22px;">
      <div style="font-size:11px;color:#6b7280;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:10px;">What You'll Do</div>
      <ul style="margin:0;padding-left:18px;">${doHTML}</ul>
    </div>` : ""}

    <div style="height:1px;background:#1f2937;margin-bottom:20px;"></div>

    <div style="margin-bottom:24px;">
      <div style="font-size:11px;color:#a78bfa;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:12px;">✨ How to Prepare</div>
      <div style="display:flex;flex-direction:column;gap:10px;">${tipsHTML}</div>
    </div>

    ${jobData.apply_url ? `
    <a href="${jobData.apply_url}" target="_blank" rel="noopener noreferrer" style="
      display:block; text-align:center;
      background:linear-gradient(135deg,#4f46e5,#a78bfa);
      color:#fff; font-weight:600; font-size:14px;
      padding:13px 24px; border-radius:10px;
      text-decoration:none; margin-top:4px;
    ">Apply for this Role →</a>` : ""}
  `;
}

window.setupKnowMoreButtons = setupKnowMoreButtons;
window.openKnowMoreModal    = openKnowMoreModal;