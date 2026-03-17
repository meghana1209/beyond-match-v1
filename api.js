import { analytics, auth, db } from "./auth.js";

import { logEvent } 
from "https://www.gstatic.com/firebasejs/10.7.1/firebase-analytics.js";

import { onAuthStateChanged } 
from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import {
  collection,
  getDocs,
  addDoc,
  query,
  where,
  doc,
  getDoc,
  updateDoc,      // ✅ FIX ADDED
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";


const API_BASE = "https://2bcj60lax1.execute-api.eu-north-1.amazonaws.com/prod";

import { callGemini } from "./gemini.js";

/* =========================================================
   THEMED TOAST NOTIFICATIONS
   Replaces all native alert() calls. Types: success | error | info | warning
========================================================= */
(function injectToastStyles() {
  if (document.getElementById("bm-toast-styles")) return;
  const s = document.createElement("style");
  s.id = "bm-toast-styles";
  s.textContent = `
    #bm-toast-container {
      position: fixed;
      bottom: 28px;
      right: 28px;
      z-index: 9999;
      display: flex;
      flex-direction: column;
      gap: 10px;
      pointer-events: none;
    }
    .bm-toast {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      min-width: 280px;
      max-width: 380px;
      padding: 14px 16px;
      border-radius: 12px;
      border: 1px solid transparent;
      background: #0f1220;
      box-shadow: 0 8px 32px rgba(0,0,0,0.55);
      font-family: 'DM Sans', sans-serif;
      font-size: 13.5px;
      line-height: 1.45;
      color: #e2e8f0;
      pointer-events: all;
      animation: bm-toast-in 0.28s cubic-bezier(.22,1,.36,1) both;
    }
    .bm-toast.bm-toast-out {
      animation: bm-toast-out 0.22s ease forwards;
    }
    .bm-toast-icon {
      font-size: 16px;
      flex-shrink: 0;
      margin-top: 1px;
    }
    .bm-toast-body { flex: 1; }
    .bm-toast-title {
      font-weight: 600;
      font-size: 13px;
      margin-bottom: 2px;
    }
    .bm-toast-msg { color: #9bb3ff; font-size: 12.5px; }
    .bm-toast-close {
      background: none; border: none; cursor: pointer;
      color: #4a5580; font-size: 16px; line-height: 1;
      padding: 0; flex-shrink: 0; margin-top: -1px;
      transition: color 0.15s;
    }
    .bm-toast-close:hover { color: #e2e8f0; }

    /* variants */
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
    container = document.createElement("div");
    container.id = "bm-toast-container";
    document.body.appendChild(container);
  }

  const icons = { success: "✓", error: "✕", warning: "⚠", info: "ℹ" };
  const titles = { success: title || "Success", error: title || "Error", warning: title || "Warning", info: title || "Info" };

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
   LLM ENRICHMENT — RECRUITER SIDE
   Generates recruiter summary + shortlist flags per candidate
========================================================= */
// Cache: job_id → enriched LLM results array
const llmCandidateCache = {};

async function enrichCandidatesWithLLM(matches, cacheKey) {

  if (cacheKey && llmCandidateCache[cacheKey]) {
    
    return llmCandidateCache[cacheKey];
  }

  const slim = matches.slice(0, 10).map(m => ({
    id: m.candidate_id,
    skills: (m.matched_skills || []).slice(0, 4),
    pct: m.match_percent
  }));

  const prompt = `Rank these candidates. Return ONLY a JSON array, no markdown.
Each: {"candidate_id":"<id>","recruiter_summary":"1 sentence max 12 words","shortlist_flag":true/false}
Top 2 get shortlist_flag true.
${JSON.stringify(slim)}`;

  try {

    const raw = await Promise.race([
  callGemini(prompt),
  new Promise(resolve => setTimeout(() => resolve(""), 25000))
]);
    if (!raw) {
      return matches.map(m => ({
        candidate_id: m.candidate_id,
        recruiter_summary: null,
        shortlist_flag: false
      }));
    }

    let clean = raw.replace(/```json|```/g, "").trim();

    // Repair truncated JSON: find last complete object and close the array
    if (!clean.endsWith("]")) {
      const lastComplete = clean.lastIndexOf("},");
      const lastObj      = clean.lastIndexOf("}");
      const cutAt        = lastComplete > -1 ? lastComplete + 1 : lastObj + 1;
      clean = clean.slice(0, cutAt) + "]";
    }

    const result = JSON.parse(clean);

    if (cacheKey) {
      llmCandidateCache[cacheKey] = result;
    }

    return result;

  } catch (err) {

    

    return matches.map(m => ({
      candidate_id: m.candidate_id,
      recruiter_summary: null,
      shortlist_flag: false
    }));
  }
}

export { apiFetch };


let selectedJobIdForCandidates = null;
export function normalizeApiResponse(res) {
  if (!res) return [];

  // If backend returned array directly
  if (Array.isArray(res)) return res;

  // If backend wrapped data inside body string
  if (res.body && typeof res.body === "string") {
    try {
      const parsed = JSON.parse(res.body);

      if (Array.isArray(parsed)) return parsed;
      if (parsed.matches) return parsed.matches;

      return [];
    } catch {
      return [];
    }
  }

  // If backend returned object with matches key
  if (res.matches) return res.matches;

  return [];
}
/* =========================================================
   GENERIC API FETCH
========================================================= */
async function apiFetch(path, options = {}) {

  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options
  });

  if (!res.ok) {
    
    return {};
  }

  const text = await res.text();
  if (!text) return {};
  
  const data = JSON.parse(text);
  
  // Handle AWS Lambda response format: {statusCode, headers, body: "..."}
  if (data.statusCode && data.body && typeof data.body === 'string') {
    try {
      return JSON.parse(data.body);
    } catch (e) {
      
      return data.body;
    }
  }
  
  return data;
}
window.apiFetch = apiFetch;

async function fetchJobs() {
  const res = await apiFetch("/jobs");
  return normalizeApiResponse(res);
}


window.fetchJobs = fetchJobs;
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

async function renderJobs() {
  const grid = document.getElementById("jobsGrid");
  if (!grid) return;

  showJobsSkeletonLoader(grid, 5);

 const res = await apiFetch("/jobs");
const jobs = normalizeApiResponse(res);


  if (!jobs.length) {
    grid.innerHTML = "No jobs available.";
    return;
  }

  grid.innerHTML = jobs.map(job => `
    <div class="job-card">
      <h3>${job.title || "Job Title"}</h3>
      <p class="company">${job.company || "Company not available"}</p>
      <p class="location">📍 ${job.location_display || "Location not specified"}</p>
      <p class="salary">
        💰 ${job.salary_min ? `₹${job.salary_min} - ₹${job.salary_max}` : "Salary not disclosed"}
      </p>
      <p class="summary">
        ${(job.description || "").slice(0, 140)}…
      </p>
      <small>Job ID: ${job.job_id}</small>
    </div>
  `).join("");
}
let selectedJobId = null;

async function populateJobDropdown() {
  const customSelect = document.getElementById("customJobSelect");
  const optionsContainer = document.getElementById("customJobOptions");
  if (!customSelect || !optionsContainer) return;

  const res = await apiFetch("/jobs");
const jobs = normalizeApiResponse(res);

  optionsContainer.innerHTML = "";

  jobs.forEach(job => {
    const option = document.createElement("div");
    option.className = "custom-option";
    option.dataset.value = job.job_id;
    option.textContent = `${job.title} — ${job.company || ""}`;
    option.onclick = () => selectJob(job.job_id, option.textContent);
    optionsContainer.appendChild(option);
  });
}

function selectJob(jobId, text) {
  selectedJobId = jobId;

  const customSelect = document.getElementById("customJobSelect");
  const triggerText = customSelect.querySelector(".custom-select-trigger span");

  // Update selected text
  triggerText.textContent = text;

  // Close dropdown
  customSelect.classList.remove("open");

  // 🔥 AUTO LOAD MATCHES
  loadMatches();
}

async function loadMatches() {
  if (!selectedJobId) {
    showToast("Please select a job first.", "warning");
    return;
  }

  const res = await apiFetch(`/matches?job_id=${selectedJobId}&top_n=5&offset=0`);
  const data = typeof res === "string" ? JSON.parse(res) : (res.body ? JSON.parse(res.body) : res);

  const grid = document.getElementById("matchesGrid");
  grid.innerHTML = "";

  if (!data.matches || data.matches.length === 0) {
    grid.innerHTML = `
      <div class="no-matches">
        No candidates matched this job
      </div>
    `;
    return;
  }

  if (data.matches && data.matches.length > 0) {
    logEvent(analytics, "match_generated", {
      job_id: selectedJobId,
      match_count: data.matches.length
    });
  }

  showCandidatesSkeletonLoader(grid, 3);
  const llmResults = await enrichCandidatesWithLLM(data.matches, selectedJobId);
  const llmMap = {};
  llmResults.forEach(s => { llmMap[s.candidate_id] = s; });

  grid.innerHTML = "";
  data.matches.forEach(match => {
    const name = match.name || "Candidate Name Not Available";
    const email = match.email || "Email not available";
    const percent = match.match_percent != null ? match.match_percent.toFixed(1) : "0.0";
    const confidence = match.confidence || "N/A";
    const reason = match.explanation?.top_reason || "No explanation provided";
    const llm = llmMap[match.candidate_id] || {};

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

let cachedJobs = null;

async function getStableJobs() {
  if (!cachedJobs) {
    cachedJobs = await fetchJobs();
  }
  return cachedJobs;
}

async function loadDashboardKPIs() {
  // Guard — don't run if KPI elements aren't on this page
  if (!document.getElementById("kpi-jds")) return;

  const jobs = await getStableJobs();

  // Just show job count immediately — no per-job match calls
  document.getElementById("kpi-jds").textContent = jobs.length;

  // Use a single matches call with a high top_n instead of looping every job
  if (jobs.length > 0) {
    const res = await apiFetch(`/matches?job_id=${jobs[0].job_id}&top_n=50&offset=0`);
    const data = res.body ? JSON.parse(res.body) : res;
    const matches = data.matches || [];

    document.getElementById("kpi-matches").textContent = matches.length;

    const scores = matches.map(m => m.score).filter(s => s != null);
    document.getElementById("kpi-accuracy").textContent =
      scores.length ? `${Math.round((scores.reduce((a,b) => a+b,0) / scores.length) * 100)}%` : "N/A";
  }
}
document.addEventListener("DOMContentLoaded", async () => {
  if (document.getElementById("jobsGrid")) {
    renderJobs();
  }

if (document.getElementById("customJobSelect")) {
  await populateJobDropdown();
  setupCustomDropdown();   // 🔥 MISSING LINE
  document
    .getElementById("loadMatchesBtn")
    ?.addEventListener("click", loadMatches);
}

});


function renderTopRoles(roleMap) {
  const list = document.getElementById("topRolesList");
  if (!list) return;

  const sorted = Object.entries(roleMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4);

  list.innerHTML = sorted
    .map(([role, count]) => `
      <li>${role} <span>${count} matches</span></li>
    `)
    .join("");
}

function setupCustomDropdown() {
  const customSelect = document.getElementById("customJobSelect");
  const trigger = customSelect.querySelector(".custom-select-trigger");
  
  // Toggle dropdown
  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    customSelect.classList.toggle("open");
  });

  // Close dropdown when clicking outside
  document.addEventListener("click", (e) => {
    if (!customSelect.contains(e.target)) {
      customSelect.classList.remove("open");
    }
  });
}

/* =========================================================
   RECRUITER JOBS PAGE LOGIC (rec-jobs.html)
========================================================= */

let recruiterOrg = null;
let allJobs = [];
let orgJobs = [];   // dedicated store, never overwritten by dashboard
let showAll = false;

async function initRecruiterJobsPage() {

  const titleEl = document.getElementById("jobsPageTitle");
  const tableEl = document.getElementById("jobsTable");

  if (!titleEl || !tableEl) return; // Not this page
  onAuthStateChanged(auth, async (user) => {
  if (!user) {
    titleEl.textContent = "Not authenticated";
    return;
  }

  const snap = await getDoc(doc(db, "users", user.uid));

  if (!snap.exists()) {
    titleEl.textContent = "Recruiter record not found";
    return;
  }

  recruiterOrg = snap.data().organisation_name;

  if (!recruiterOrg) {
    titleEl.textContent = "No organisation linked";
    return;
  }

  titleEl.textContent = recruiterOrg + " Jobs";

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
document.getElementById("locationFilter")
  ?.addEventListener("change", renderRecruiterJobs);
  document.getElementById("searchInput")
    ?.addEventListener("input", renderRecruiterJobs);

  document.getElementById("sortSelect")
    ?.addEventListener("change", renderRecruiterJobs);
}

// Normalise a string for comparison: lowercase, collapse all whitespace/unicode
function normaliseCompany(s) {
  return (s || "").normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
}

// ─── ORG JOB FETCH ──────────────────────────────────────────────────────────
// Calls /jobs?company= — Lambda does full internal scan and returns all matches.
// Single call, cached per company for the session.
const _jobsByCompanyCache = {};

async function fetchOrgJobs(companyName) {
  const cacheKey = normaliseCompany(companyName);
  if (_jobsByCompanyCache[cacheKey]) {
    
    return _jobsByCompanyCache[cacheKey];
  }

  const res = await apiFetch(`/jobs?company=${encodeURIComponent(companyName)}`);
  const jobs = res.jobs || [];

  
  _jobsByCompanyCache[cacheKey] = jobs;
  return jobs;
}

async function loadRecruiterJobs() {
  const tableEl = document.getElementById("jobsTable");
  if (tableEl) tableEl.innerHTML = `<p style="color:#aaa;padding:16px">Loading jobs for your organisation…</p>`;

  orgJobs = await fetchOrgJobs(recruiterOrg);

  // For "All Jobs" toggle: single page of unfiltered jobs (browse sample)
const allRes = await apiFetch(`/jobs`);
allJobs = allRes.jobs || normalizeApiResponse(allRes);

  

  renderRecruiterJobs();
  populateLocationFilter();
}

function formatSalary(job) {
  const min = job.salary_min;
  const max = job.salary_max;

  if (!min && !max) return "Salary not disclosed";

  if (min && max) {
    if (min === max) return `$${Math.round(min).toLocaleString()}`;
    return `$${Math.round(min).toLocaleString()} - $${Math.round(max).toLocaleString()}`;
  }

  if (min) return `From $${Math.round(min).toLocaleString()}`;
  if (max) return `Up to $${Math.round(max).toLocaleString()}`;

  return "Salary not disclosed";
}

function renderRecruiterJobs() {

  const tableEl = document.getElementById("jobsTable");
  if (!tableEl) return;

  // Show skeleton loaders while processing
  showJobsSkeletonLoader(tableEl, 5);

  let filtered = showAll ? [...allJobs] : [...orgJobs];

  
  

  /* SEARCH */
  const searchTerm =
    document.getElementById("searchInput")?.value.toLowerCase() || "";

  if (searchTerm) {
    filtered = filtered.filter(j =>
      j.title?.toLowerCase().includes(searchTerm)
    );
  }

  /* LOCATION */
  const location =
    document.getElementById("locationFilter")?.value?.toLowerCase().trim();

  if (location) {
    filtered = filtered.filter(j =>
      (getJobLocation(j) || "")
        .toLowerCase()
        .trim()
        .includes(location)
    );
  }

  /* SORT */
  const sortValue = document.getElementById("sortSelect")?.value;

  if (sortValue === "newest") {
    filtered.sort((a, b) =>
      new Date(b.created_at || 0) - new Date(a.created_at || 0)
    );
  } else if (sortValue === "oldest") {
    filtered.sort((a, b) =>
      new Date(a.created_at || 0) - new Date(b.created_at || 0)
    );
  } else if (sortValue === "title") {
    filtered.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
  }
  if (!filtered.length) {
    tableEl.innerHTML = "<p>No jobs found.</p>";
    return;
  }

  tableEl.innerHTML = filtered.map(job => `
  <div class="job-modern-card">
    <div class="job-modern-header">
      <h3>${job.title}</h3>
      <span class="job-pill">
${
  job.location_display ||
  job.location ||
  (job.city && job.country
    ? `${job.city}, ${job.country}`
    : job.country || "-")
}
</span>
    </div>

    <div class="job-modern-company">
      ${job.company || "-"}
    </div>

    <div class="job-modern-salary">
  ${formatSalary(job)}
</div>

    <div class="job-modern-actions">
      <button class="modern-view-btn"
        data-url="${job.apply_link || job.apply_url || ''}">
        View
      </button>
    </div>
  </div>
`).join("");

tableEl.querySelectorAll("button[data-url]").forEach(btn => {
  btn.addEventListener("click", () => {
    const url = btn.getAttribute("data-url");

    if (!url) {
      showToast("No application link available for this job.", "warning");
      return;
    }

    window.open(url, "_blank", "noopener,noreferrer");
  });
});
}

function getJobLocation(job) {
  return (
    job.location_display ||
    job.location ||
    (job.city && job.country
      ? `${job.city}, ${job.country}`
      : job.country || null)
  );
}

function populateLocationFilter() {
  const select = document.getElementById("locationFilter");
  if (!select) return;

  const sourceJobs = showAll ? allJobs : orgJobs;
  const locations = [...new Set(sourceJobs.map(getJobLocation).filter(Boolean))];

  select.innerHTML = `
    <option value="">All Locations</option>
    ${locations.map(loc =>
      `<option value="${loc}">${loc}</option>`
    ).join("")}
  `;
}

document.addEventListener("DOMContentLoaded", initRecruiterJobsPage);

/* =========================================================
   CANDIDATE MATCHES PAGE (AUTO ORG + AUTO ROLE SELECT)
========================================================= */

let allCandidates = [];
let recruiterOrgRoleList = [];

async function initCandidateMatchesPage() {

  const container = document.getElementById("candMatchesTable");
  const roleDropdown = document.getElementById("roleDropdown");
  

  if (!container || !roleDropdown) return;

  onAuthStateChanged(auth, async (user) => {

    if (!user) {
      container.innerHTML = "User not authenticated.";
      return;
    }

    const snap = await getDoc(doc(db, "users", user.uid));

    if (!snap.exists()) {
      container.innerHTML = "User record not found.";
      return;
    }

    recruiterOrg = snap.data().organisation_name;

    if (!recruiterOrg) {
      container.innerHTML = "No organisation linked to this recruiter.";
      return;
    }

    // Use fetchOrgJobs — single company-filtered call, cached for session
    orgJobs = await fetchOrgJobs(recruiterOrg);

    

    if (!orgJobs.length) {
      container.innerHTML = "No jobs found for your organisation.";
      return;
    }

    // ── Fetch match counts for all jobs in parallel, then sort by most matches ──
    roleDropdown.innerHTML = `<option value="">Sorting by matches…</option>`;

    const matchCounts = await Promise.all(
      orgJobs.map(async j => {
        try {
          const res = await apiFetch(`/matches?job_id=${j.job_id}&top_n=1&offset=0`);
          const total = res.total_matches ?? (res.matches?.length ?? 0);
          return { job_id: j.job_id, count: total };
        } catch {
          return { job_id: j.job_id, count: 0 };
        }
      })
    );

    // Build a quick lookup: job_id → match count
    const countMap = {};
    matchCounts.forEach(m => { countMap[m.job_id] = m.count; });

    // Sort orgJobs by match count descending
    const sortedJobs = [...orgJobs].sort(
      (a, b) => (countMap[b.job_id] || 0) - (countMap[a.job_id] || 0)
    );

    // Populate dropdown — show count badge in label
    roleDropdown.innerHTML = sortedJobs
      .map(j => {
        const loc   = j.city || j.location || "";
        const count = countMap[j.job_id] || 0;
        const label = `${j.title}${loc ? ` — ${loc}` : ""} (${count} match${count !== 1 ? "es" : ""})`;
        return `<option value="${j.job_id}">${label}</option>`;
      })
      .join("");

    // Default-select the first job (most matches)
    const defaultJobId = sortedJobs[0].job_id;
    roleDropdown.value = defaultJobId;

    await loadCandidatesForRole(defaultJobId);

    roleDropdown.addEventListener("change", async () => {
   
      await loadCandidatesForRole(roleDropdown.value);
    });

    
// 🔥 SEARCH LISTENER
document
  .getElementById("candSearchInput")
  ?.addEventListener("input", renderCandidateMatches);

// 🔥 SORT LISTENER
document
  .getElementById("candSortSelect")
  ?.addEventListener("change", renderCandidateMatches);
  });

}

async function loadCandidatesForRole(jobId) {
  const container = document.getElementById("candMatchesTable");
  if (!container) return;

  showCandidatesSkeletonLoader(container, 5);

  const selectedJob = orgJobs.find(j => j.job_id === jobId);  // exact match by ID
  if (!selectedJob) {
    container.innerHTML = "No job found.";
    return;
  }

  selectedJobIdForCandidates = selectedJob.job_id;
  let res;

try {
  res = await apiFetch(
    `/matches?job_id=${selectedJob.job_id}&top_n=50&offset=0`
  );
} catch(e) {
  
  container.innerHTML = "Match service temporarily unavailable.";
  return;
}

  // apiFetch already unwraps Lambda body → res is {matches:[...], total_matches:N}
  const data = res.matches || normalizeApiResponse(res);

if (!data.length) {
  container.innerHTML = "No matching candidates found.";
  return;
}

// 🔥 Enrich candidates with Firestore data
const enriched = [];

for (const match of data) {
  const snap = await getDoc(doc(db, "candidates", match.candidate_id));
  const candidateData = snap.exists() ? snap.data() : {};

  enriched.push({
    ...match,
    name: candidateData.name || match.name || match.email || "",
    email: candidateData.email || match.email || "",
    resume_text: candidateData.resume_text || ""
  });
}

allCandidates = enriched;
renderCandidateMatches();
}

async function renderCandidateMatches() {

  const container = document.getElementById("candMatchesTable");
  if (!container) return;

  let filtered = [...allCandidates];

  const search = document.getElementById("candSearchInput")?.value.toLowerCase() || "";
  if (search) {
    filtered = filtered.filter(c =>
      c.name?.toLowerCase().includes(search) ||
      c.email?.toLowerCase().includes(search)
    );
  }

  const sortValue = document.getElementById("candSortSelect")?.value;
  if (sortValue === "name") {
    filtered.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  }
  if (sortValue === "newest") {
    filtered.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  }
  if (sortValue === "oldest") {
    filtered.sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
  }

  if (!filtered.length) {
    container.innerHTML = "No matching candidates found.";
    return;
  }

  // Show skeleton while LLM runs (skipped if cache hit — will be instant)
  showCandidatesSkeletonLoader(container, filtered.length);

  // 🤖 LLM enrichment — cached by selectedJobIdForCandidates so switching
  // back to a role you already viewed never calls Groq again
  const llmResults = await enrichCandidatesWithLLM(filtered, selectedJobIdForCandidates);
  const llmMap = {};
  llmResults.forEach(r => { llmMap[r.candidate_id] = r; });

  const cards = filtered.map((match) => {

    const percent = match.match_percent != null ? match.match_percent.toFixed(1) : "0";

    const skills =
      match.matched_skills ||        // ✅ API returns this directly
      match.explanation?.skill_overlap ||
      match.explanation?.top_skills ||
      match.skills ||
      (
        match.explanation?.top_reason
          ? match.explanation.top_reason
              .replace("Strong match in:", "")
              .split(",")
              .map(s => s.trim())
          : []
      );

    const llm = llmMap[match.candidate_id] || {};

   return `
<div class="cand-card ${llm.shortlist_flag ? "ai-shortlist" : ""}">

  ${llm.shortlist_flag ? `<div class="ai-top-badge">⭐ AI Recommended</div>` : ""}

  <div class="cand-header">
    <div class="cand-main">
      <div class="cand-title">${(match.name && match.name !== match.email) ? match.name : (match.email?.split("@")[0] || "Candidate")}</div>
      <div class="cand-email">${match.email || "-"}</div>
    </div>
    <div class="cand-score">
      <span class="match-pill">${percent}%</span>
    </div>
  </div>

  ${(llm.inferred_level || match.level)
    ? `<div class="cand-level"><span class="skill-pill subtle">${llm.inferred_level || match.level}</span></div>`
    : ""}

  <div class="cand-skills">
    ${
      llm.key_strengths && llm.key_strengths.length
        ? llm.key_strengths.map(s => `<span class="skill-pill">${s}</span>`).join("")
        : (match.matched_skills || []).slice(0,4).map(s => `<span class="skill-pill">${s}</span>`).join("")
        || `<span class="skill-pill subtle">No skills listed</span>`
    }
  </div>

  <div class="ai-insight">
    ${llm.recruiter_summary
      ? `✨ ${llm.recruiter_summary}`
      : match.explanation?.top_reason
        ? `✨ ${match.explanation.top_reason}`
        : `<span style="opacity:0.4;font-style:italic">No summary available</span>`}
  </div>

  <div class="cand-actions" style="display:flex;gap:8px;">
    <a href="rec-actions.html?id=${match.candidate_id}&job=${selectedJobIdForCandidates}" class="view-btn" style="flex:1;text-align:center;">
      View Profile →
    </a>
    <button
      class="view-btn"
      style="flex:1;background:rgba(122,162,255,0.08);border:1px solid rgba(122,162,255,0.2);cursor:pointer;"
      onclick="openCandidateAnalysis('${match.candidate_id}', '${(match.name||'').replace(/'/g,'')}', '${selectedJobIdForCandidates}')">
      🔍 Analyse
    </button>
  </div>

</div>
`;
  });

  container.innerHTML = cards.join("");
}

document.addEventListener("DOMContentLoaded", initCandidateMatchesPage);

/* =========================================================
   RECRUITER ACTIONS PAGE LOGIC
========================================================= */

async function initRecruiterActionsPage() {

  const container = document.getElementById("actionsContainer");
  if (!container) return;

  // Wait for Firebase auth to resolve before touching Firestore
  onAuthStateChanged(auth, async (user) => {

    if (!user) {
      container.innerHTML = "Not authenticated.";
      return;
    }

  const urlParams = new URLSearchParams(window.location.search);
  const candidateId = urlParams.get("id");
  const jobId = urlParams.get("job");

  // If no candidateId, show contacted profiles list
  if (!candidateId) {
    showCandidatesSkeletonLoader(container, 4);

    const recruiter = user;

const q = query(
  collection(db, "recruiter_actions"),
  where("recruiter_id", "==", recruiter.uid)
);
    const snap = await getDocs(q);

    if (snap.empty) {
      container.innerHTML = "No contacted candidates yet.";
      return;
    }

    const cards = [];

    for (const docSnap of snap.docs) {
      const data = docSnap.data();

      const candSnap = await getDoc(doc(db, "candidates", data.candidate_id));
      const candidate = candSnap.exists() ? candSnap.data() : {};

      function formatStatus(status = "") {
        return status
          .replace(/_/g, " ")
          .replace(/\b\w/g, l => l.toUpperCase());
      }

      cards.push(`
        <div class="cand-card action-card">

          <div class="action-header">
            <div class="action-name">
              ${candidate.name || "Candidate"}
            </div>

            <span class="action-status ${data.status}">
              ${formatStatus(data.status)}
            </span>
          </div>

          <div class="action-footer">
            <a href="rec-actions.html?id=${data.candidate_id}&job=${data.job_id}" 
               class="view-btn">
               View
            </a>
          </div>

        </div>
      `);
    }

    container.innerHTML = cards.join("");
    return;
  }

  // If candidateId exists, show candidate profile
  const snap = await getDoc(doc(db, "candidates", candidateId));
  const candidate = snap.exists() ? snap.data() : {};

  container.classList.remove("actions-grid");
container.innerHTML = `
  <div class="profile-wrapper">

      <div class="profile-left card">

        <h2 class="section-title">Candidate Overview</h2>

        <div class="profile-info">
          <div class="info-row">
            <span class="label">Name</span>
            <span class="value">${candidate.name || "-"}</span>
          </div>

          <div class="info-row">
            <span class="label">Email</span>
            <span class="value">${candidate.email || "-"}</span>
          </div>

          <div class="info-row">
            <span class="label">Phone</span>
            <span class="value">${candidate.phone || "-"}</span>
          </div>
        </div>

        ${candidate.resume_url ? `
          <button id="viewResumeBtn" class="btn">
            View Resume
          </button>
        ` : ``}

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

  // 🔥 Load existing status — scoped to this recruiter
  const q = query(
    collection(db, "recruiter_actions"),
    where("candidate_id", "==", candidateId),
    where("job_id", "==", jobId),
    where("recruiter_id", "==", user.uid)
  );

  const snapActions = await getDocs(q);

  if (!snapActions.empty) {
    const data = snapActions.docs[0].data();

    document.getElementById("statusSelect").value = data.status || "contacted";
    document.getElementById("notesInput").value = data.notes || "";
  }

  document.getElementById("saveActionBtn").onclick = async () => {

    const status = document.getElementById("statusSelect").value;
    const notes = document.getElementById("notesInput").value;

    const saveQ = query(
      collection(db, "recruiter_actions"),
      where("candidate_id", "==", candidateId),
      where("job_id", "==", jobId),
      where("recruiter_id", "==", user.uid)
    );

    const existing = await getDocs(saveQ);

    if (!existing.empty) {
      const docRef = existing.docs[0].ref;

      await updateDoc(docRef, {
        status,
        notes,
        updated_at: serverTimestamp()
      });

    } else {

      await addDoc(collection(db, "recruiter_actions"), {
        candidate_id: candidateId,
        job_id: jobId,
        recruiter_id: user.uid,
        status,
        notes,
        created_at: serverTimestamp()
      });

    }

    showToast("Action saved successfully.", "success");
  };

  document.getElementById("sendEmailBtn").onclick = () => {
    if (!candidate.email) {
      showToast("No email address on file for this candidate.", "warning");
      return;
    }

    const subject = encodeURIComponent("Regarding Your Application");
    const body = encodeURIComponent("Hi " + (candidate.name || "") + ",\n\nWe would like to proceed further.");

    window.location.href = `mailto:${candidate.email}?subject=${subject}&body=${body}`;
  };

  // ── AI EMAIL DRAFTER (cached by candidateId + status) ──
  const emailDraftCache = {};

  document.getElementById("aiDraftBtn").onclick = async () => {
    const btn = document.getElementById("aiDraftBtn");
    const box = document.getElementById("aiEmailBox");
    const output = document.getElementById("aiEmailOutput");

    const status = document.getElementById("statusSelect").value;
    const notes = document.getElementById("notesInput").value;

    // Return instantly if same candidate + status was already drafted
    const cacheKey = `${candidateId}:${status}`;
    if (emailDraftCache[cacheKey]) {
      
      output.value = emailDraftCache[cacheKey];
      box.style.display = "block";
      return;
    }

    btn.disabled = true;
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
      output.value = draft;
      box.style.display = "block";
    } catch (err) {
      
      showToast("AI draft failed. Please try again.", "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "✨ Draft with AI";
    }
  };

  document.getElementById("sendAiEmailBtn").onclick = () => {
    const draft = document.getElementById("aiEmailOutput").value;
    if (!candidate.email) { showToast("No email address on file for this candidate.", "warning"); return; }
    const subject = encodeURIComponent("Regarding Your Application – BeyondMatch");
    window.location.href = `mailto:${candidate.email}?subject=${subject}&body=${encodeURIComponent(draft)}`;
  };

  }); // end onAuthStateChanged
}

document.addEventListener("DOMContentLoaded", initRecruiterActionsPage);
/* =========================================================
   RECRUITER CANDIDATE ANALYSIS MODAL
   Mirrors candidate-side "Know More" but reversed:
   recruiter sees resume vs JD comparison
========================================================= */
const _recAnalysisCache = {};

window.openCandidateAnalysis = async function(candidateId, candidateName, jobId) {

  // ── Inject modal once ──
  if (!document.getElementById("recAnalysisOverlay")) {
    const overlay = document.createElement("div");
    overlay.id = "recAnalysisOverlay";
    overlay.style.cssText = `
      position:fixed;inset:0;background:rgba(0,0,0,0.78);
      backdrop-filter:blur(6px);z-index:1000;
      display:flex;align-items:center;justify-content:center;
      padding:20px;box-sizing:border-box;
    `;
    overlay.innerHTML = `
      <div id="recAnalysisModal" style="
        background:#0f1220;border:1px solid rgba(122,162,255,0.15);
        border-radius:16px;width:100%;max-width:700px;
        max-height:88vh;overflow-y:auto;
        padding:32px;box-sizing:border-box;
        position:relative;color:#e2e8f0;font-family:inherit;
      ">
        <button id="recAnalysisClose" style="
          position:absolute;top:16px;right:18px;
          background:none;border:none;color:#6b7fa8;
          font-size:22px;cursor:pointer;line-height:1;
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

  // ── Spinner while loading ──
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

  // ── Fetch resume + JD ──
  let resumeText = "";
  let jobData    = orgJobs.find(j => j.job_id === jobId) || {};

  try {
    const { getDoc, doc } = await import("https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js");
    const snap = await getDoc(doc(window.db, "candidates", candidateId));
    if (snap.exists()) resumeText = (snap.data().resume_text || "").slice(0, 1200);
  } catch(e) {}

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
    const raw   = await callGemini(prompt);
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    _recAnalysisCache[cacheKey] = parsed;
    renderCandidateAnalysis(content, candidateName, parsed, jobData);
  } catch(err) {
    
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
      <div style="font-weight:600;font-size:13px;color:#e2e8f0;margin-bottom:4px;">Q${i+1}. ${q.q}</div>
      <div style="font-size:12px;color:#6b7fa8;font-style:italic;">→ ${q.why}</div>
    </div>`).join("");

  const recColor = (data.hire_recommendation || "").toLowerCase().startsWith("strong yes") ? "#4ade80"
    : (data.hire_recommendation || "").toLowerCase().startsWith("yes") ? "#7aa2ff"
    : (data.hire_recommendation || "").toLowerCase().startsWith("maybe") ? "#fbbf24"
    : "#f87171";

  content.innerHTML = `
    <!-- Header -->
    <div style="margin-bottom:22px;">
      <div style="font-size:11px;color:#7aa2ff;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px;">Candidate Analysis</div>
      <h2 style="margin:0 0 4px;font-size:20px;color:#e2e8f0;">${candidateName}</h2>
      ${jobData.title ? `<p style="margin:0;color:#6b7fa8;font-size:13px;">vs. ${jobData.title}</p>` : ""}
    </div>

    <div style="height:1px;background:rgba(122,162,255,0.1);margin-bottom:20px;"></div>

    <!-- Match Summary -->
    <div style="margin-bottom:20px;">
      <div style="font-size:11px;color:#6b7280;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:8px;">Overall Fit</div>
      <p style="color:#d1d5db;font-size:14px;line-height:1.6;margin:0;">${data.match_summary || ""}</p>
    </div>

    <!-- Strengths + Gaps side by side -->
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

    <!-- Interview Questions -->
    ${questionsHTML ? `
    <div style="margin-bottom:22px;">
      <div style="font-size:11px;color:#7aa2ff;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:12px;">💬 Suggested Interview Questions</div>
      ${questionsHTML}
    </div>` : ""}

    <div style="height:1px;background:rgba(122,162,255,0.1);margin-bottom:20px;"></div>

    <!-- Hire Recommendation -->
    <div style="display:flex;align-items:center;gap:12px;padding:14px 16px;background:#0b0e16;border-radius:10px;border:1px solid ${recColor}33;">
      <div style="font-size:11px;color:#6b7280;font-weight:700;letter-spacing:1px;text-transform:uppercase;white-space:nowrap;">Recommendation</div>
      <div style="color:${recColor};font-size:14px;font-weight:600;">${data.hire_recommendation || "—"}</div>
    </div>
  `;
}