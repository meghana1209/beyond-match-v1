import { analytics, auth, db } from "./auth.js";
import { logEvent }  from "https://www.gstatic.com/firebasejs/10.7.1/firebase-analytics.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
  collection,
  getDocs,
  addDoc,
  query,
  where,
  doc,
  getDoc,
  updateDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

import { callGemini } from "./gemini.js";

const API_BASE = "https://2bcj60lax1.execute-api.eu-north-1.amazonaws.com/prod";


/* =========================================================
   TOAST NOTIFICATIONS
   Replaces all native alert() calls.
   Types: "success" | "error" | "info" | "warning"
========================================================= */
(function injectToastStyles() {
  if (document.getElementById("bm-toast-styles")) return;
  const s   = document.createElement("style");
  s.id      = "bm-toast-styles";
  s.textContent = `
    #bm-toast-container {
      position: fixed; bottom: 28px; right: 28px; z-index: 9999;
      display: flex; flex-direction: column; gap: 10px; pointer-events: none;
    }
    .bm-toast {
      display: flex; align-items: flex-start; gap: 12px;
      min-width: 280px; max-width: 380px; padding: 14px 16px;
      border-radius: 12px; border: 1px solid transparent;
      background: #0f1220; box-shadow: 0 8px 32px rgba(0,0,0,0.55);
      font-family: 'DM Sans', sans-serif; font-size: 13.5px;
      line-height: 1.45; color: #e2e8f0; pointer-events: all;
      animation: bm-toast-in 0.28s cubic-bezier(.22,1,.36,1) both;
    }
    .bm-toast.bm-toast-out { animation: bm-toast-out 0.22s ease forwards; }
    .bm-toast-icon  { font-size: 16px; flex-shrink: 0; margin-top: 1px; }
    .bm-toast-body  { flex: 1; }
    .bm-toast-title { font-weight: 600; font-size: 13px; margin-bottom: 2px; }
    .bm-toast-msg   { color: #9bb3ff; font-size: 12.5px; }
    .bm-toast-close {
      background: none; border: none; cursor: pointer;
      color: #4a5580; font-size: 16px; line-height: 1;
      padding: 0; flex-shrink: 0; margin-top: -1px; transition: color 0.15s;
    }
    .bm-toast-close:hover { color: #e2e8f0; }
    .bm-toast.success { border-color: rgba(74,222,128,0.22); }
    .bm-toast.success .bm-toast-title { color: #4ade80; }
    .bm-toast.error   { border-color: rgba(248,113,113,0.22); }
    .bm-toast.error   .bm-toast-title { color: #f87171; }
    .bm-toast.warning { border-color: rgba(251,191,36,0.22); }
    .bm-toast.warning .bm-toast-title { color: #fbbf24; }
    .bm-toast.info    { border-color: rgba(122,162,255,0.22); }
    .bm-toast.info    .bm-toast-title { color: #7aa2ff; }
    @keyframes bm-toast-in  { from { opacity:0; transform:translateY(14px) scale(.97); } to { opacity:1; transform:none; } }
    @keyframes bm-toast-out { from { opacity:1; transform:none; } to { opacity:0; transform:translateY(6px); } }
  `;
  document.head.appendChild(s);
})();

function showToast(message, type = "info", title = "") {
  let container = document.getElementById("bm-toast-container");
  if (!container) {
    container    = document.createElement("div");
    container.id = "bm-toast-container";
    document.body.appendChild(container);
  }

  const icons  = { success: "✓", error: "✕", warning: "⚠", info: "ℹ" };
  const titles = {
    success: title || "Success",
    error:   title || "Error",
    warning: title || "Warning",
    info:    title || "Info"
  };

  const toast = document.createElement("div");
  toast.className = `bm-toast ${type}`;
  toast.innerHTML = `
    <span class="bm-toast-icon">${icons[type] || icons.info}</span>
    <div class="bm-toast-body">
      <div class="bm-toast-title">${titles[type]}</div>
      <div class="bm-toast-msg">${message}</div>
    </div>
    <button class="bm-toast-close" aria-label="Dismiss">&#x2715;</button>
  `;

  const dismiss = () => {
    toast.classList.add("bm-toast-out");
    toast.addEventListener("animationend", () => toast.remove(), { once: true });
  };

  toast.querySelector(".bm-toast-close").addEventListener("click", dismiss);
  container.appendChild(toast);
  setTimeout(dismiss, type === "error" ? 6000 : 4000);
}

// Make globally available for auth.js and candidate.js
window.showToast = showToast;


/* =========================================================
   GENERIC API FETCH
   Handles AWS Lambda's {statusCode, body} envelope automatically.
========================================================= */
async function apiFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options
  });

  if (!res.ok) return {};

  const text = await res.text();
  if (!text) return {};

  const data = JSON.parse(text);

  // Unwrap AWS Lambda envelope: { statusCode, headers, body: "..." }
  if (data.statusCode && data.body && typeof data.body === "string") {
    try { return JSON.parse(data.body); } catch { return data.body; }
  }

  return data;
}

window.apiFetch = apiFetch;
export { apiFetch };


/* =========================================================
   RESPONSE NORMALISATION
   Accepts any shape the backend might return and gives back
   a plain array.
========================================================= */
export function normalizeApiResponse(res) {
  if (!res) return [];
  if (Array.isArray(res)) return res;

  if (res.body && typeof res.body === "string") {
    try {
      const parsed = JSON.parse(res.body);
      if (Array.isArray(parsed)) return parsed;
      if (parsed.matches) return parsed.matches;
      return [];
    } catch { return []; }
  }

  if (res.matches) return res.matches;
  return [];
}


/* =========================================================
   JOB FETCHING
========================================================= */
async function fetchJobs() {
  const res = await apiFetch("/jobs");
  return normalizeApiResponse(res);
}

window.fetchJobs = fetchJobs;

// Single cached copy so multiple page sections share one request
let cachedJobs = null;

async function getStableJobs() {
  if (!cachedJobs) cachedJobs = await fetchJobs();
  return cachedJobs;
}


/* =========================================================
   SKELETON LOADERS
========================================================= */
function showJobsSkeletonLoader(container, count = 5) {
  container.innerHTML = Array.from({ length: count }).map(() => `
    <div class="job-card skeleton-card" aria-hidden="true">
      <div class="skeleton skeleton-title"></div>
      <div class="skeleton skeleton-line"></div>
      <div class="skeleton skeleton-line short"></div>
      <div class="skeleton skeleton-line"></div>
      <div class="skeleton skeleton-btn"></div>
    </div>
  `).join("");
}

function showCandidatesSkeletonLoader(container, count = 4) {
  container.innerHTML = Array.from({ length: count }).map(() => `
    <div class="cand-card skeleton-card" aria-hidden="true">
      <div class="skeleton skeleton-title"></div>
      <div class="skeleton skeleton-line"></div>
      <div class="skeleton skeleton-line short"></div>
      <div class="skeleton skeleton-btn"></div>
    </div>
  `).join("");
}


/* =========================================================
   JOB LISTING PAGE — renderJobs / populateJobDropdown
========================================================= */
async function renderJobs() {
  const grid = document.getElementById("jobsGrid");
  if (!grid) return;

  showJobsSkeletonLoader(grid, 5);

  const res  = await apiFetch("/jobs");
  const jobs = normalizeApiResponse(res);

  if (!jobs.length) { grid.innerHTML = "No jobs available."; return; }

  grid.innerHTML = jobs.map(job => `
    <div class="job-card">
      <h3>${job.title || "Job Title"}</h3>
      <p class="company">${job.company || "Company not available"}</p>
      <p class="location">📍 ${job.location_display || "Location not specified"}</p>
      <p class="salary">
        💰 ${job.salary_min ? `₹${job.salary_min} - ₹${job.salary_max}` : "Salary not disclosed"}
      </p>
      <p class="summary">${(job.description || "").slice(0, 140)}…</p>
      <small>Job ID: ${job.job_id}</small>
    </div>
  `).join("");
}

let selectedJobId = null;

async function populateJobDropdown() {
  const customSelect     = document.getElementById("customJobSelect");
  const optionsContainer = document.getElementById("customJobOptions");
  if (!customSelect || !optionsContainer) return;

  const res  = await apiFetch("/jobs");
  const jobs = normalizeApiResponse(res);

  optionsContainer.innerHTML = "";
  jobs.forEach(job => {
    const option       = document.createElement("div");
    option.className   = "custom-option";
    option.dataset.value = job.job_id;
    option.textContent = `${job.title} — ${job.company || ""}`;
    option.onclick     = () => selectJob(job.job_id, option.textContent);
    optionsContainer.appendChild(option);
  });
}

function selectJob(jobId, text) {
  selectedJobId = jobId;
  const customSelect = document.getElementById("customJobSelect");
  customSelect.querySelector(".custom-select-trigger span").textContent = text;
  customSelect.classList.remove("open");
  loadMatches();
}

function setupCustomDropdown() {
  const customSelect = document.getElementById("customJobSelect");
  const trigger      = customSelect.querySelector(".custom-select-trigger");

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    customSelect.classList.toggle("open");
  });

  document.addEventListener("click", (e) => {
    if (!customSelect.contains(e.target)) customSelect.classList.remove("open");
  });
}


/* =========================================================
   LLM ENRICHMENT — RECRUITER SIDE
   Generates a one-sentence recruiter summary and shortlist
   flags for the top 5 candidates of a given job.
   Results are cached per job_id.
========================================================= */
const llmCandidateCache = {}; // job_id → enriched LLM results array

async function enrichCandidatesWithLLM(matches, cacheKey, selectedJob) {
  if (cacheKey && llmCandidateCache[cacheKey]) return llmCandidateCache[cacheKey];

  const jobTitle  = selectedJob?.title || "this role";
  const jdSnippet = (selectedJob?.description || selectedJob?.jd || "").slice(0, 300);
  const top5      = matches.slice(0, 5);

  const slim = top5.map(m => ({
    candidate_id: m.candidate_id,
    level:  m.level || "",
    skills: (m.matched_skills || []).slice(0, 5),
    pct:    Math.round(m.match_percent || 0)
  }));

  const prompt = `Recruiter is hiring for: "${jobTitle}".
${jdSnippet ? `Role needs: ${jdSnippet}` : ""}

For each candidate write ONE sentence (max 14 words) explaining why they stand out for this role.
Rules:
- Be specific — mention their skill level or what they bring
- Do NOT repeat skill tag names literally — speak about what those skills enable
- Top 2 by pct get shortlist_flag true, rest false
Return ONLY JSON array, no markdown:
[{"candidate_id":"<id>","recruiter_summary":"<one sentence>","shortlist_flag":true/false}]

Candidates: ${JSON.stringify(slim)}`;

  // Initialise with null summaries — UI shows fallback CTA for those without one
  const result = matches.map(m => ({
    candidate_id:      m.candidate_id,
    recruiter_summary: null,
    shortlist_flag:    false
  }));

  try {
    const raw = await Promise.race([
      callGemini(prompt),
      new Promise(resolve => setTimeout(() => resolve(""), 7000))
    ]);

    if (raw) {
      let clean = raw.replace(/```json|```/g, "").trim();
      if (!clean.endsWith("]")) {
        const cut = clean.lastIndexOf("}");
        if (cut > -1) clean = clean.slice(0, cut + 1) + "]";
      }
      const llmMap = {};
      JSON.parse(clean).forEach(r => { llmMap[r.candidate_id] = r; });

      result.forEach(r => {
        const l = llmMap[r.candidate_id];
        if (l) {
          r.recruiter_summary = l.recruiter_summary || null;
          r.shortlist_flag    = !!l.shortlist_flag;
        }
      });
    }
  } catch { /* silent — fallback CTA shown in UI */ }

  if (cacheKey) llmCandidateCache[cacheKey] = result;
  return result;
}


/* =========================================================
   MATCH LOADING — RECRUITER DASHBOARD
========================================================= */
let selectedJobIdForCandidates = null;

async function loadMatches() {
  if (!selectedJobId) { showToast("Please select a job first.", "warning"); return; }

  const res  = await apiFetch(`/matches?job_id=${selectedJobId}&top_n=5&offset=0`);
  const data = typeof res === "string" ? JSON.parse(res) : (res.body ? JSON.parse(res.body) : res);
  const grid = document.getElementById("matchesGrid");

  grid.innerHTML = "";

  if (!data.matches?.length) {
    grid.innerHTML = `<div class="no-matches">No candidates matched this job</div>`;
    return;
  }

  logEvent(analytics, "match_generated", {
    job_id:      selectedJobId,
    match_count: data.matches.length
  });

  showCandidatesSkeletonLoader(grid, 3);

  // Pass the full job object so the LLM has title + description context for
  // AI Recommended badges and recruiter_summary. Previously undefined was passed.
  const selectedJob = orgJobs.find(j => j.job_id === selectedJobId) || null;
  const llmResults = await enrichCandidatesWithLLM(data.matches, selectedJobId, selectedJob);
  const llmMap     = {};
  llmResults.forEach(s => { llmMap[s.candidate_id] = s; });

  grid.innerHTML = "";
  data.matches.forEach(match => {
    const name       = match.name || "Candidate Name Not Available";
    const email      = match.email || "Email not available";
    const percent    = match.match_percent != null ? match.match_percent.toFixed(1) : "0.0";
    const confidence = match.confidence || "N/A";
    const reason     = match.explanation?.top_reason || "No explanation provided";
    const llm        = llmMap[match.candidate_id] || {};

    grid.innerHTML += `
      <div class="match-card ${llm.shortlist_flag ? "ai-shortlist" : ""}">
        ${llm.shortlist_flag ? `<div class="ai-top-badge">⭐ AI Recommended</div>` : ""}
        <h3>${name}</h3>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Match:</strong> ${percent}%</p>
        <p><strong>Confidence:</strong> ${confidence}</p>
        <p class="reason">${reason}</p>
        ${llm.recruiter_summary ? `<p class="ai-insight">🤖 ${llm.recruiter_summary}</p>` : ""}
      </div>
    `;
  });
}


/* =========================================================
   DASHBOARD KPIs
========================================================= */
async function loadDashboardKPIs() {
  if (!document.getElementById("kpi-jds")) return;

  const jobs = await getStableJobs();
  document.getElementById("kpi-jds").textContent = jobs.length;

  if (!jobs.length) return;

  const res     = await apiFetch(`/matches?job_id=${jobs[0].job_id}&top_n=50&offset=0`);
  const data    = res.body ? JSON.parse(res.body) : res;
  const matches = data.matches || [];

  document.getElementById("kpi-matches").textContent = matches.length;

  const scores = matches.map(m => m.score).filter(s => s != null);
  document.getElementById("kpi-accuracy").textContent = scores.length
    ? `${Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100)}%`
    : "N/A";
}


/* =========================================================
   PAGE INIT — JOBS GRID + JOB DROPDOWN
========================================================= */
document.addEventListener("DOMContentLoaded", async () => {
  if (document.getElementById("jobsGrid")) {
    renderJobs();
  }

  if (document.getElementById("customJobSelect")) {
    await populateJobDropdown();
    setupCustomDropdown();
    document.getElementById("loadMatchesBtn")?.addEventListener("click", loadMatches);
  }
});


/* =========================================================
   RECRUITER JOBS PAGE  (rec-jobs.html)
========================================================= */
let recruiterOrg = null;
let allJobs      = [];
let orgJobs      = [];
let showAll      = false;

// Normalise company name for consistent comparison
function normaliseCompany(s) {
  return (s || "").normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
}

// Cache per company name, for the session
const _jobsByCompanyCache = {};

async function fetchOrgJobs(companyName) {
  const cacheKey = normaliseCompany(companyName);
  if (_jobsByCompanyCache[cacheKey]) return _jobsByCompanyCache[cacheKey];

  const res  = await apiFetch(`/jobs?company=${encodeURIComponent(companyName)}`);
  let   jobs = res.jobs || res.matches || normalizeApiResponse(res);

  // Fallback: filter client-side if the endpoint doesn't support ?company=
  if (!jobs.length) {
    const allRes   = await apiFetch("/jobs");
    const all      = allRes.jobs || normalizeApiResponse(allRes);
    const normTarget = normaliseCompany(companyName);
    jobs = all.filter(j => normaliseCompany(j.company) === normTarget);
  }

  _jobsByCompanyCache[cacheKey] = jobs;
  return jobs;
}

async function loadRecruiterJobs() {
  const [fetchedOrgJobs, allRes] = await Promise.all([
    fetchOrgJobs(recruiterOrg),
    apiFetch("/jobs")
  ]);
  orgJobs = fetchedOrgJobs;
  allJobs = allRes.jobs || normalizeApiResponse(allRes);

  renderRecruiterJobs();
  populateLocationFilter();
}

function getJobLocation(job) {
  return (
    job.location_display ||
    job.location ||
    (job.city && job.country ? `${job.city}, ${job.country}` : job.country || null)
  );
}

function formatSalary(job) {
  const min = job.salary_min;
  const max = job.salary_max;
  if (!min && !max) return "Salary not disclosed";
  if (min && max)   return min === max
    ? `$${Math.round(min).toLocaleString()}`
    : `$${Math.round(min).toLocaleString()} - $${Math.round(max).toLocaleString()}`;
  if (min) return `From $${Math.round(min).toLocaleString()}`;
  if (max) return `Up to $${Math.round(max).toLocaleString()}`;
  return "Salary not disclosed";
}

function renderRecruiterJobs() {
  const tableEl = document.getElementById("jobsTable");
  if (!tableEl) return;

  let filtered = showAll ? [...allJobs] : [...orgJobs];

  const searchTerm = document.getElementById("searchInput")?.value.toLowerCase() || "";
  if (searchTerm) {
    filtered = filtered.filter(j => j.title?.toLowerCase().includes(searchTerm));
  }

  const location = document.getElementById("locationFilter")?.value?.toLowerCase().trim();
  if (location) {
    filtered = filtered.filter(j => (getJobLocation(j) || "").toLowerCase().trim().includes(location));
  }

  const sortValue = document.getElementById("sortSelect")?.value;
  if (sortValue === "newest") {
    filtered.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  } else if (sortValue === "oldest") {
    filtered.sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
  } else if (sortValue === "title") {
    filtered.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
  }

  if (!filtered.length) { tableEl.innerHTML = "<p>No jobs found.</p>"; return; }

  tableEl.innerHTML = filtered.map(job => {
    // Recruiters see "View Matches" → cand-matches.html pre-selecting this job
    // and "Post Similar" → rec-postjob.html. No apply link for recruiters.
    const matchesHref   = `cand-matches.html?job=${encodeURIComponent(job.job_id)}`;
    const postJobHref   = `rec-postjob.html`;

    return `
    <div class="job-modern-card">
      <div class="job-modern-header">
        <h3>${job.title}</h3>
        <span class="job-pill">${getJobLocation(job) || "-"}</span>
      </div>
      <div class="job-modern-company">${job.company || "-"}</div>
      <div class="job-modern-salary">${formatSalary(job)}</div>
      <div class="job-modern-actions">
        <a class="modern-view-btn"
           href="${matchesHref}"
           data-job-id="${job.job_id}">
          View Matches →
        </a>
        <a class="modern-view-btn"
           href="${postJobHref}"
           style="background:rgba(192,132,252,.10);border-color:rgba(192,132,252,.25);color:#c084fc;">
          + Post Similar
        </a>
      </div>
    </div>`;
  }).join("");

  // No more click handler opening external URLs —
  // the <a href> redirect handles everything now.
}

function populateLocationFilter() {
  const select = document.getElementById("locationFilter");
  if (!select) return;

  const sourceJobs = showAll ? allJobs : orgJobs;
  const locations  = [...new Set(sourceJobs.map(getJobLocation).filter(Boolean))];

  select.innerHTML = `
    <option value="">All Locations</option>
    ${locations.map(loc => `<option value="${loc}">${loc}</option>`).join("")}
  `;
}

async function initRecruiterJobsPage() {
  const titleEl = document.getElementById("jobsPageTitle");
  const tableEl = document.getElementById("jobsTable");
  if (!titleEl || !tableEl) return;

  onAuthStateChanged(auth, async (user) => {
    if (!user) { titleEl.textContent = "Not authenticated"; return; }

    const snap = await getDoc(doc(db, "users", user.uid));
    if (!snap.exists()) { titleEl.textContent = "Recruiter record not found"; return; }

    recruiterOrg = snap.data().organisation_name;
    if (!recruiterOrg) { titleEl.textContent = "No organisation linked"; return; }

    titleEl.textContent = `${recruiterOrg} Jobs`;
    await loadRecruiterJobs();
  });

  document.getElementById("myOrgBtn")?.addEventListener("click", () => {
    showAll = false;
    document.getElementById("myOrgBtn").classList.add("active");
    document.getElementById("allJobsBtn").classList.remove("active");
    populateLocationFilter();
    renderRecruiterJobs();
  });

  document.getElementById("allJobsBtn")?.addEventListener("click", () => {
    showAll = true;
    document.getElementById("allJobsBtn").classList.add("active");
    document.getElementById("myOrgBtn").classList.remove("active");
    populateLocationFilter();
    renderRecruiterJobs();
  });

  document.getElementById("locationFilter")?.addEventListener("change", renderRecruiterJobs);
  document.getElementById("searchInput")?.addEventListener("input", renderRecruiterJobs);
  document.getElementById("sortSelect")?.addEventListener("change", renderRecruiterJobs);
}

document.addEventListener("DOMContentLoaded", initRecruiterJobsPage);


/* =========================================================
   CANDIDATE MATCHES PAGE  (cand-matches.html)
   Auto-detects the recruiter's org, fetches its jobs sorted
   by match count, and loads the top role by default.
========================================================= */
let allCandidates       = [];
let currentLlmMap       = {};

async function initCandidateMatchesPage() {
  const container    = document.getElementById("candMatchesTable");
  const roleDropdown = document.getElementById("roleDropdown");
  if (!container || !roleDropdown) return;

  onAuthStateChanged(auth, async (user) => {
    if (!user) { container.innerHTML = "User not authenticated."; return; }

    const snap = await getDoc(doc(db, "users", user.uid));
    if (!snap.exists()) { container.innerHTML = "User record not found."; return; }

    recruiterOrg = snap.data().organisation_name;
    if (!recruiterOrg) { container.innerHTML = "No organisation linked to this recruiter."; return; }

    orgJobs = await fetchOrgJobs(recruiterOrg);
    if (!orgJobs.length) { container.innerHTML = "No jobs found for your organisation."; return; }

    roleDropdown.innerHTML = `<option value="">Sorting by matches…</option>`;

    // Fetch match counts for all jobs in parallel (top_n=1 minimises payload)
    const matchCounts = await Promise.all(
      orgJobs.map(async j => {
        try {
          const res = await apiFetch(`/matches?job_id=${j.job_id}&top_n=1&offset=0`);
          return { job_id: j.job_id, count: res.total_matches ?? (res.matches?.length ?? 0) };
        } catch { return { job_id: j.job_id, count: 0 }; }
      })
    );

    const countMap = {};
    matchCounts.forEach(m => { countMap[m.job_id] = m.count; });

    const sortedJobs = [...orgJobs].sort((a, b) => (countMap[b.job_id] || 0) - (countMap[a.job_id] || 0));

    roleDropdown.innerHTML = sortedJobs.map(j => {
      const loc   = j.city || j.location || "";
      const count = countMap[j.job_id] || 0;
      const label = `${j.title}${loc ? ` — ${loc}` : ""} (${count} match${count !== 1 ? "es" : ""})`;
      return `<option value="${j.job_id}">${label}</option>`;
    }).join("");

    const defaultJobId = sortedJobs[0].job_id;
    roleDropdown.value  = defaultJobId;

    // Auto-load the highest-match role
    if (typeof window.triggerLoadCandidates === "function") {
      window.triggerLoadCandidates();
    } else {
      await loadCandidatesForRole(defaultJobId);
    }

    roleDropdown.addEventListener("change", async () => {
      if (typeof window.triggerLoadCandidates === "function") {
        window.triggerLoadCandidates();
      } else {
        await loadCandidatesForRole(roleDropdown.value);
      }
    });

    document.getElementById("candSearchInput")
      ?.addEventListener("input", () => renderCandidateMatches(currentLlmMap));
    document.getElementById("candSortSelect")
      ?.addEventListener("change", () => renderCandidateMatches(currentLlmMap));
  });
}

async function loadCandidatesForRole(jobId) {
  const container = document.getElementById("candMatchesTable");
  const selectedJob = orgJobs.find(j => j.job_id === jobId);

  if (!selectedJob) { if (container) container.innerHTML = "No job found."; return; }

  selectedJobIdForCandidates = selectedJob.job_id;

  let res;
  try {
    res = await apiFetch(`/matches?job_id=${selectedJob.job_id}&top_n=50&offset=0`);
  } catch {
    if (container) container.innerHTML = "Match service temporarily unavailable.";
    return;
  }

  const data = res.matches || normalizeApiResponse(res);
  if (!data.length) {
    if (container) container.innerHTML = `
      <div class="empty-state">
        <h4>No candidates found</h4>
        <p>No matches for this job yet.</p>
      </div>`;
    return;
  }

  // Enrich with Firestore candidate data in parallel
  const enriched = await Promise.all(data.map(async match => {
    try {
      const snap = await getDoc(doc(db, "candidates", match.candidate_id));
      const cd   = snap.exists() ? snap.data() : {};
      return {
        ...match,
        name:         cd.name         || match.name  || match.email || "",
        email:        cd.email        || match.email || "",
        resume_text:  (cd.resume_text || "").slice(0, 600),
        applied_role: cd.applied_role || ""
      };
    } catch { return match; }
  }));

  allCandidates = enriched;
  currentLlmMap = {};

  // Phase 1: render immediately with match data
  if (typeof window.renderCandidateCards === "function") {
    window.renderCandidateCards(enriched, {});
  }

  // Phase 2: LLM enrichment in background — silently patches rendered cards
  enrichCandidatesWithLLM(enriched, selectedJobIdForCandidates, selectedJob)
    .then(llmResults => {
      const llmMap = {};
      llmResults.forEach(r => { llmMap[r.candidate_id] = r; });
      currentLlmMap = llmMap;
      if (typeof window.patchCandidateLlm === "function") {
        window.patchCandidateLlm(llmMap);
      }
    })
    .catch(() => {});
}

window.loadCandidatesForRole = loadCandidatesForRole;

// Kept for legacy callers
async function renderCandidateMatches(llmMap) {
  if (typeof window.renderCandidateCards === "function") {
    window.renderCandidateCards(allCandidates, llmMap || currentLlmMap || {});
  }
}


/* =========================================================
   RECRUITER ACTIONS PAGE  (rec-actions.html)
   Two modes:
   - No ?id param → list all contacted candidates
   - ?id=<candidateId>&job=<jobId> → candidate profile + status editor
========================================================= */
async function initRecruiterActionsPage() {
  const container = document.getElementById("actionsContainer");
  if (!container) return;
  // The new rec-actions module sets data-managed="true" on the container
  // as its very first act, so we can detect it and bail immediately,
  // preventing the old _renderContactedList from painting stale cards.
  if (container.dataset.managed === "true") return;

  onAuthStateChanged(auth, async (user) => {
    if (!user) { container.innerHTML = "Not authenticated."; return; }

    const urlParams   = new URLSearchParams(window.location.search);
    const candidateId = urlParams.get("id");
    const jobId       = urlParams.get("job");

    if (!candidateId) {
      await _renderContactedList(container, user);
    } else {
      await _renderCandidateProfile(container, user, candidateId, jobId);
    }
  });
}

async function _renderContactedList(container, user) {
  showCandidatesSkeletonLoader(container, 4);

  const q    = query(collection(db, "recruiter_actions"), where("recruiter_id", "==", user.uid));
  const snap = await getDocs(q);

  if (snap.empty) { container.innerHTML = "No contacted candidates yet."; return; }

  function formatStatus(status = "") {
    return status.replace(/_/g, " ").replace(/\b\w/g, l => l.toUpperCase());
  }

  const cards = await Promise.all(snap.docs.map(async docSnap => {
    const data      = docSnap.data();
    const candSnap  = await getDoc(doc(db, "candidates", data.candidate_id));
    const candidate = candSnap.exists() ? candSnap.data() : {};

    return `
      <div class="cand-card action-card">
        <div class="action-header">
          <div class="action-name">${candidate.name || "Candidate"}</div>
          <span class="action-status ${data.status}">${formatStatus(data.status)}</span>
        </div>
        <div class="action-footer">
          <a href="rec-actions.html?id=${data.candidate_id}&job=${data.job_id}" class="view-btn">View</a>
        </div>
      </div>
    `;
  }));

  container.innerHTML = cards.join("");
}

async function _renderCandidateProfile(container, user, candidateId, jobId) {
  const snap      = await getDoc(doc(db, "candidates", candidateId));
  const candidate = snap.exists() ? snap.data() : {};

  container.classList.remove("actions-grid");
  container.innerHTML = `
    <div class="profile-wrapper">
      <div class="profile-left card">
        <h2 class="section-title">Candidate Overview</h2>
        <div class="profile-info">
          <div class="info-row"><span class="label">Name</span><span class="value">${candidate.name || "-"}</span></div>
          <div class="info-row"><span class="label">Email</span><span class="value">${candidate.email || "-"}</span></div>
          <div class="info-row"><span class="label">Phone</span><span class="value">${candidate.phone || "-"}</span></div>
        </div>
        ${candidate.resume_url ? `<button id="viewResumeBtn" class="btn">View Resume</button>` : ""}
      </div>

      <div class="profile-right card">
        <h2 class="section-title">Recruitment Status</h2>
        <label class="label">Status</label>
        <select id="statusSelect" class="input">
          <option value="contacted">Contacted</option>
          <option value="interview_scheduled">Interview Scheduled</option>
          <option value="interview_completed">Interview Completed</option>
          <option value="offered">Offered</option>
          <option value="rejected">Rejected</option>
        </select>
        <label class="label">Notes</label>
        <textarea id="notesInput" class="input" placeholder="Add notes..."></textarea>
        <div class="status-actions">
          <button id="saveActionBtn" class="btn">Save Action</button>
          <button id="sendEmailBtn" class="btn">Send Email</button>
          <button id="aiDraftBtn" class="btn btn-ai">✨ Draft with AI</button>
        </div>
        <div id="aiEmailBox" style="display:none; margin-top:14px;">
          <label class="label">AI-Drafted Email</label>
          <textarea id="aiEmailOutput" class="input" rows="8" style="font-size:13px;"></textarea>
          <button id="sendAiEmailBtn" class="btn" style="margin-top:8px;">Send This Email</button>
        </div>
      </div>
    </div>
  `;

  // Load existing recruiter action for this candidate + job
  const q           = query(
    collection(db, "recruiter_actions"),
    where("candidate_id", "==", candidateId),
    where("job_id",        "==", jobId),
    where("recruiter_id",  "==", user.uid)
  );
  const snapActions = await getDocs(q);
  if (!snapActions.empty) {
    const data = snapActions.docs[0].data();
    document.getElementById("statusSelect").value = data.status || "contacted";
    document.getElementById("notesInput").value   = data.notes  || "";
  }

  // Save action
  document.getElementById("saveActionBtn").onclick = async () => {
    const status = document.getElementById("statusSelect").value;
    const notes  = document.getElementById("notesInput").value;

    const saveQ    = query(
      collection(db, "recruiter_actions"),
      where("candidate_id", "==", candidateId),
      where("job_id",        "==", jobId),
      where("recruiter_id",  "==", user.uid)
    );
    const existing = await getDocs(saveQ);

    if (!existing.empty) {
      await updateDoc(existing.docs[0].ref, { status, notes, updated_at: serverTimestamp() });
    } else {
      await addDoc(collection(db, "recruiter_actions"), {
        candidate_id: candidateId,
        job_id:       jobId,
        recruiter_id: user.uid,
        status,
        notes,
        created_at:   serverTimestamp()
      });
    }

    showToast("Action saved successfully.", "success");
  };

  // Send plain email
  document.getElementById("sendEmailBtn").onclick = () => {
    if (!candidate.email) { showToast("No email address on file for this candidate.", "warning"); return; }
    const subject = encodeURIComponent("Regarding Your Application");
    const body    = encodeURIComponent(`Hi ${candidate.name || ""},\n\nWe would like to proceed further.`);
    window.location.href = `mailto:${candidate.email}?subject=${subject}&body=${body}`;
  };

  // AI email drafter — cached per candidate + status
  const emailDraftCache = {};

  document.getElementById("aiDraftBtn").onclick = async () => {
    const btn    = document.getElementById("aiDraftBtn");
    const box    = document.getElementById("aiEmailBox");
    const output = document.getElementById("aiEmailOutput");
    const status = document.getElementById("statusSelect").value;
    const notes  = document.getElementById("notesInput").value;
    const cacheKey = `${candidateId}:${status}`;

    if (emailDraftCache[cacheKey]) {
      output.value     = emailDraftCache[cacheKey];
      box.style.display = "block";
      return;
    }

    btn.disabled    = true;
    btn.textContent = "✨ Drafting…";

    const prompt = `You are a professional recruiter drafting a personalised outreach email.

Candidate name: ${candidate.name || "the candidate"}
Current recruitment status: ${status.replace(/_/g, " ")}
Recruiter notes: ${notes || "none"}

Write a warm, professional email (3–4 short paragraphs) appropriate for the status:
- contacted: introduce the opportunity, invite them to learn more.
- interview_scheduled: confirm details and set expectations.
- offered: congratulate and outline next steps.
- rejected: decline respectfully with encouragement.

Return ONLY the email body text, no subject line, no JSON.`;

    try {
      const draft = await callGemini(prompt);
      emailDraftCache[cacheKey] = draft;
      output.value      = draft;
      box.style.display = "block";
    } catch {
      showToast("AI draft failed. Please try again.", "error");
    } finally {
      btn.disabled    = false;
      btn.textContent = "✨ Draft with AI";
    }
  };

  // Send the AI-drafted email
  document.getElementById("sendAiEmailBtn").onclick = () => {
    const draft = document.getElementById("aiEmailOutput").value;
    if (!candidate.email) { showToast("No email address on file for this candidate.", "warning"); return; }
    const subject = encodeURIComponent("Regarding Your Application – BeyondMatch");
    window.location.href = `mailto:${candidate.email}?subject=${subject}&body=${encodeURIComponent(draft)}`;
  };
}

document.addEventListener("DOMContentLoaded", initRecruiterActionsPage);
document.addEventListener("DOMContentLoaded", initCandidateMatchesPage);


/* =========================================================
   CANDIDATE ANALYSIS MODAL — RECRUITER SIDE
   Shows resume-vs-JD comparison: strengths, gaps, interview
   questions, and a hire recommendation. Triggered by
   window.openCandidateAnalysis(candidateId, name, jobId).
========================================================= */
const _recAnalysisCache = {};

window.openCandidateAnalysis = async function (candidateId, candidateName, jobId) {

  // Inject modal once
  if (!document.getElementById("recAnalysisOverlay")) {
    const overlay = document.createElement("div");
    overlay.id    = "recAnalysisOverlay";
    overlay.style.cssText = `
      position:fixed; inset:0; background:rgba(0,0,0,0.78);
      backdrop-filter:blur(6px); z-index:1000;
      display:flex; align-items:center; justify-content:center;
      padding:20px; box-sizing:border-box;
    `;
    overlay.innerHTML = `
      <div id="recAnalysisModal" style="
        background:#0f1220; border:1px solid rgba(122,162,255,0.15);
        border-radius:16px; width:100%; max-width:700px;
        max-height:88vh; overflow-y:auto;
        padding:32px; box-sizing:border-box;
        position:relative; color:#e2e8f0; font-family:inherit;
      ">
        <button id="recAnalysisClose" style="
          position:absolute; top:16px; right:18px;
          background:none; border:none; color:#6b7fa8;
          font-size:22px; cursor:pointer; line-height:1;
        ">&#x2715;</button>
        <div id="recAnalysisContent"></div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", e => { if (e.target === overlay) overlay.style.display = "none"; });
    document.getElementById("recAnalysisClose").addEventListener("click", () => {
      document.getElementById("recAnalysisOverlay").style.display = "none";
    });
  }

  const overlay = document.getElementById("recAnalysisOverlay");
  const content = document.getElementById("recAnalysisContent");
  overlay.style.display = "flex";

  content.innerHTML = `
    <div style="margin-bottom:20px;">
      <div style="font-size:11px;color:#7aa2ff;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px;">Candidate Analysis</div>
      <h2 style="margin:0;font-size:20px;color:#e2e8f0;">${candidateName || candidateId}</h2>
    </div>
    <div style="display:flex;align-items:center;gap:10px;color:#6b7280;font-size:14px;padding:24px 0;">
      <div style="width:20px;height:20px;border-radius:50%;border:2px solid #7aa2ff;border-top-color:transparent;animation:recSpin 0.8s linear infinite;flex-shrink:0;"></div>
      Comparing resume against job description…
    </div>
    <style>@keyframes recSpin{to{transform:rotate(360deg)}}</style>
  `;

  const cacheKey = `${candidateId}__${jobId}`;
  if (_recAnalysisCache[cacheKey]) {
    renderCandidateAnalysis(content, candidateName, _recAnalysisCache[cacheKey]);
    return;
  }

  let resumeText = "";
  const jobData  = orgJobs.find(j => j.job_id === jobId) || {};

  try {
    const { getDoc, doc } = await import("https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js");
    const snap = await getDoc(doc(window.db, "candidates", candidateId));
    if (snap.exists()) resumeText = (snap.data().resume_text || "").slice(0, 1200);
  } catch { }

  const jdText = (jobData.description || jobData.jd || "").slice(0, 1000);

  const prompt = `You are a recruiter assistant reviewing a candidate for a role.

Job Title: ${jobData.title || "Unknown Role"}
Job Description: ${jdText || "Not provided"}

Candidate Resume:
${resumeText || "Not provided"}

Return ONLY a raw JSON object, no markdown, no backticks:
{
  "match_summary": "2-3 sentences: how well this candidate fits the role and why",
  "strengths": ["specific strength from their resume relevant to this JD", "strength 2", "strength 3"],
  "gaps": ["skill or experience missing vs JD", "gap 2"],
  "interview_questions": [
    {"q": "specific question to probe a strength or gap", "why": "what this reveals"},
    {"q": "question 2", "why": "reason"},
    {"q": "question 3", "why": "reason"}
  ],
  "hire_recommendation": "Strong Yes / Yes / Maybe / No — 1 sentence reason"
}`;

  try {
    const { callGemini } = await import("./gemini.js");
    const raw    = await callGemini(prompt);
    const clean  = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    _recAnalysisCache[cacheKey] = parsed;
    renderCandidateAnalysis(content, candidateName, parsed, jobData);
  } catch {
    content.innerHTML += `<p style="color:#f87171;font-size:13px;margin-top:16px;">Analysis failed. Please try again.</p>`;
  }
};

function renderCandidateAnalysis(content, candidateName, data, jobData = {}) {
  const strengthsHTML = (data.strengths || []).map(s => `
    <div style="display:flex;gap:10px;align-items:flex-start;margin-bottom:8px;">
      <span style="color:#4ade80;font-size:14px;flex-shrink:0;">✓</span>
      <span style="color:#d1d5db;font-size:13px;line-height:1.5;">${s}</span>
    </div>`).join("");

  const gapsHTML = (data.gaps || []).map(g => `
    <div style="display:flex;gap:10px;align-items:flex-start;margin-bottom:8px;">
      <span style="color:#fbbf24;font-size:14px;flex-shrink:0;">△</span>
      <span style="color:#d1d5db;font-size:13px;line-height:1.5;">${g}</span>
    </div>`).join("");

  const questionsHTML = (data.interview_questions || []).map((q, i) => `
    <div style="padding:12px 14px;background:#0b0e16;border-radius:10px;border:1px solid rgba(122,162,255,0.1);margin-bottom:8px;">
      <div style="font-weight:600;font-size:13px;color:#e2e8f0;margin-bottom:4px;">Q${i + 1}. ${q.q}</div>
      <div style="font-size:12px;color:#6b7fa8;font-style:italic;">→ ${q.why}</div>
    </div>`).join("");

  const rec      = (data.hire_recommendation || "").toLowerCase();
  const recColor = rec.startsWith("strong yes") ? "#4ade80"
    : rec.startsWith("yes")   ? "#7aa2ff"
    : rec.startsWith("maybe") ? "#fbbf24"
    : "#f87171";

  content.innerHTML = `
    <div style="margin-bottom:22px;">
      <div style="font-size:11px;color:#7aa2ff;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px;">Candidate Analysis</div>
      <h2 style="margin:0 0 4px;font-size:20px;color:#e2e8f0;">${candidateName}</h2>
      ${jobData.title ? `<p style="margin:0;color:#6b7fa8;font-size:13px;">vs. ${jobData.title}</p>` : ""}
    </div>

    <div style="height:1px;background:rgba(122,162,255,0.1);margin-bottom:20px;"></div>

    <div style="margin-bottom:20px;">
      <div style="font-size:11px;color:#6b7280;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:8px;">Overall Fit</div>
      <p style="color:#d1d5db;font-size:14px;line-height:1.6;margin:0;">${data.match_summary || ""}</p>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:22px;">
      <div style="background:#0b0e16;border-radius:10px;padding:14px;border:1px solid rgba(74,222,128,0.12);">
        <div style="font-size:11px;color:#4ade80;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:10px;">✓ Strengths</div>
        ${strengthsHTML || '<p style="color:#6b7280;font-size:13px;">None identified</p>'}
      </div>
      <div style="background:#0b0e16;border-radius:10px;padding:14px;border:1px solid rgba(251,191,36,0.12);">
        <div style="font-size:11px;color:#fbbf24;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:10px;">△ Gaps</div>
        ${gapsHTML || '<p style="color:#6b7280;font-size:13px;">None identified</p>'}
      </div>
    </div>

    <div style="height:1px;background:rgba(122,162,255,0.1);margin-bottom:20px;"></div>

    ${questionsHTML ? `
    <div style="margin-bottom:22px;">
      <div style="font-size:11px;color:#7aa2ff;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:12px;">💬 Suggested Interview Questions</div>
      ${questionsHTML}
    </div>` : ""}

    <div style="height:1px;background:rgba(122,162,255,0.1);margin-bottom:20px;"></div>

    <div style="display:flex;align-items:center;gap:12px;padding:14px 16px;background:#0b0e16;border-radius:10px;border:1px solid ${recColor}33;">
      <div style="font-size:11px;color:#6b7280;font-weight:700;letter-spacing:1px;text-transform:uppercase;white-space:nowrap;">Recommendation</div>
      <div style="color:${recColor};font-size:14px;font-weight:600;">${data.hire_recommendation || "—"}</div>
    </div>
  `;
}