/* =========================================================
   FIREBASE IMPORTS
   Firestore operations used for candidate and job handling
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

import { analytics } from "./auth.js";
import { logEvent } 
from "https://www.gstatic.com/firebasejs/10.7.1/firebase-analytics.js";

const db = window.db;
const auth = window.auth;

import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";


/* =========================================================
   ROLE INFERENCE
   Detects candidate role using resume keywords
========================================================= */
function inferRoleFromResume(text = "") {
  const t = text.toLowerCase();

  const ROLE_KEYWORDS = {
    "Backend Developer": ["backend", "node", "django", "flask", "api", "database", "express"],
    "Frontend Developer": ["frontend", "html", "css", "react", "ui"],
    "Full Stack Developer": ["full stack", "mern", "frontend", "backend"],
    "Software Engineer": ["software engineer", "java", "javascript"],
    "Data Scientist": ["machine learning", "deep learning", "statistics", "model"],
    "Data Analyst": ["data analyst", "power bi", "tableau", "excel", "analytics"],
    "DevOps Engineer": ["docker", "kubernetes", "aws", "ci/cd"],
    "AI Engineer": ["nlp", "computer vision", "llm"]
  };

  let bestRole = "General";
  let maxScore = 0;

  for (const role in ROLE_KEYWORDS) {
    let score = 0;
    ROLE_KEYWORDS[role].forEach(k => {
      if (t.includes(k)) score++;
    });

    if (score > maxScore) {
      maxScore = score;
      bestRole = role;
    }
  }

  return bestRole;
}


/* =========================================================
   UPLOAD CANDIDATE
   Sends candidate to backend and stores metadata in Firestore
========================================================= */
async function uploadCandidate(name, email, resumeText) {
  const res = await apiFetch("/candidates", {
    method: "POST",
    body: JSON.stringify({
      name,
      email,
      resume_text: resumeText || ""
    })
  });

  const backendCandidateId =
    res?.candidate_id ||
    (typeof res?.body === "string" && JSON.parse(res.body)?.candidate_id);

  if (!backendCandidateId) {
    throw new Error("Backend did not return candidate_id");
  }

  const inferredRole = inferRoleFromResume(resumeText);

  await setDoc(doc(db, "candidates", backendCandidateId), {
    candidate_id: backendCandidateId,
    name,
    email,
    user_id: auth.currentUser.uid,
    applied_role: inferredRole,
    createdAt: serverTimestamp()
  });

  logEvent(analytics, "candidate_created", {
    recruiter_id: auth.currentUser.uid,
    role_detected: inferredRole
  });

  return res;
}

window.uploadCandidate = uploadCandidate;


/* =========================================================
   LOAD USER CANDIDATES
   Loads only resumes uploaded by current user
========================================================= */
async function loadUserCandidatesOnly() {
  const select = document.getElementById("candidateSelect");
  if (!select) return;

  const user = auth.currentUser;
  if (!user) return;

  select.innerHTML = `<option value="">Select your resume</option>`;

  /* Collect all candidate docs belonging to this user */
  const snapshot = await getDocs(collection(db, "candidates"));
  const userDocs = [];

  snapshot.forEach(docSnap => {
    const data = docSnap.data();
    if (data.user_id && data.user_id !== user.uid) return;
    if (!data.user_id && data.email !== user.email) return;
    userDocs.push({ id: docSnap.id, ...data });
  });

  /* Sort: most recent first (is_latest top, then by createdAt desc) */
  userDocs.sort((a, b) => {
    if (a.is_latest && !b.is_latest) return -1;
    if (!a.is_latest && b.is_latest) return  1;
    const ta = a.createdAt?.seconds || 0;
    const tb = b.createdAt?.seconds || 0;
    return tb - ta;
  });

  /* Also check users doc for latest_candidate_id as tiebreaker */
  let latestId = null;
  try {
    const { getDoc, doc } = await import("https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js");
    const userSnap = await getDoc(doc(db, "users", user.uid));
    if (userSnap.exists()) latestId = userSnap.data().latest_candidate_id || null;
  } catch(e) {}

  userDocs.forEach((data, idx) => {
    const option    = document.createElement("option");
    option.value    = data.id;

    const isLatest  = data.is_latest || data.id === latestId || idx === 0;
    const role      = data.applied_role || "General";
    const dateStr   = data.createdAt?.toDate
      ? data.createdAt.toDate().toLocaleDateString("en-GB", { day:"2-digit", month:"short" })
      : "";

    option.textContent = isLatest
      ? `★ ${data.name} – ${role}${dateStr ? " (" + dateStr + ")" : ""} [Latest]`
      : `${data.name} – ${role}${dateStr ? " (" + dateStr + ")" : ""}`;

    /* Auto-select the latest */
    if (isLatest) option.selected = true;

    select.appendChild(option);
  });

  /* Auto-load matches for the pre-selected latest resume */
  if (userDocs.length > 0) {
    const autoSelect = select.value;
    if (autoSelect && typeof loadCandidateJobMatches === "function") {
      loadCandidateJobMatches();
    }
  }
}


/* =========================================================
   LOAD ALL CANDIDATES
   Populates candidate dropdown from Firestore
========================================================= */
async function loadCandidates() {
  const select = document.getElementById("candidateSelect");
  if (!select) return;

  select.innerHTML = `<option value="">Loading candidates...</option>`;

  const snapshot = await getDocs(collection(db, "candidates"));

  select.innerHTML = `<option value="">Select candidate</option>`;

  snapshot.forEach(docSnap => {
    const data = docSnap.data();

    if (docSnap.id !== data.candidate_id) return;

    const option = document.createElement("option");
    option.value = docSnap.id;
    option.textContent = data.name;
    select.appendChild(option);
  });
}


import { callGemini, isGeminiAvailable } from "./gemini.js";

/* =========================================================
   LLM ENRICHMENT — CANDIDATE SIDE
   Reranks matches and adds a "why this fits you" insight
========================================================= */
// Cache: candidate_id → enriched LLM results array
const llmMatchCache = {};

async function enrichMatchesWithLLM(matches, allJobs, cacheKey) {

  // Return cached result if same candidate was already enriched
  if (cacheKey && llmMatchCache[cacheKey]) {
    console.log("LLM match cache hit:", cacheKey);
    return llmMatchCache[cacheKey];
  }

  const slim = matches.map((m, i) => {
    const job = allJobs.find(j => j.job_id === m.job_id) || {};
    return {
      index: i,
      job_id: m.job_id,
      title: m.title || job.title || "Unknown",
      company: job.company || "Unknown",
      location: job.location_display || job.city || "Unknown",
      salary_min: job.salary_min || null,
      salary_max: job.salary_max || null,
      description_snippet: (job.description || "").slice(0, 300),
      match_percent: m.match_percent,
      existing_reason: m.explanation?.top_reason || ""
    };
  });

// AFTER:
const prompt = `You are a career advisor AI inside a recruitment platform.
Given these job matches for a candidate, do two things:
1. Re-rank them from best to worst fit. match_percent is the PRIMARY ranking signal. A job with lower match_percent must ALWAYS rank below a job with higher match_percent, regardless of salary or other factors.
2. For each job write a single friendly sentence (max 20 words) explaining WHY it suits the candidate. Start with "Great fit because" or "Strong match —" etc.
IMPORTANT: Return ONLY a raw JSON array. No markdown, no backticks, no explanation. Just the JSON.
Each item: { "index": <number>, "job_id": "...", "ai_rank": 1, "ai_insight": "..." }

Matches:
${JSON.stringify(slim, null, 2)}`;

  try {
    const raw = await callGemini(prompt);
    if (!raw) return matches.map((m, i) => ({ job_id: m.job_id, ai_rank: i + 1, ai_insight: null }));

    const parsed = JSON.parse(raw);
    const byJobId = {}, byIndex = {};
    parsed.forEach(r => {
      if (r.job_id) byJobId[r.job_id] = r;
      if (r.index != null) byIndex[r.index] = r;
    });

    const result = matches.map((m, i) => {
      const r = byJobId[m.job_id] || byIndex[i] || {};
      return { job_id: m.job_id, ai_rank: r.ai_rank ?? (i + 1), ai_insight: r.ai_insight || null };
    });

    if (cacheKey) llmMatchCache[cacheKey] = result;
    return result;

  } catch (err) {
    console.warn("LLM enrichment failed, showing matches without AI:", err);
    return matches.map((m, i) => ({ job_id: m.job_id, ai_rank: i + 1, ai_insight: null }));
  }
}


/* =========================================================
   RESOLVE LOCAL ID TO BACKEND ID
   If a candidate only has a local_ Firestore ID (backend
   registration failed at signup), register them now and
   update Firestore with the real backend candidate_id.
========================================================= */
const API_BASE = "https://2bcj60lax1.execute-api.eu-north-1.amazonaws.com/prod";

async function resolveToBackendId(localId) {
  if (!localId.startsWith("local_")) return localId;

  console.log("🔄 local_ ID detected, registering with backend:", localId);

  const snap = await getDoc(doc(db, "candidates", localId));
  if (!snap.exists()) { console.error("Candidate doc not found:", localId); return localId; }

  const data = snap.data();
  const resumeText = data.resume_text || "";

  if (!resumeText.trim()) {
    console.warn("⚠️ No resume_text in doc. Go to Resume Analysis and upload first.");
    return localId;
  }

  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`${API_BASE}/candidates`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      signal:  controller.signal,
      body: JSON.stringify({
        name:        data.name || data.email?.split("@")[0] || "candidate",
        email:       data.email,
        resume_text: resumeText
      })
    });
    const raw = await res.text();
    let parsed = {};
    try { parsed = JSON.parse(raw); } catch(e) {}
    const backendId = parsed?.candidate_id
      || (typeof parsed?.body === "string"
          ? (() => { try { return JSON.parse(parsed.body)?.candidate_id; } catch(e) { return null; } })()
          : null);

    if (!backendId) { console.warn("Backend gave no candidate_id, raw:", raw); return localId; }

    /* Migrate: write real-ID doc, update users doc, delete old local_ doc */
    const user = auth.currentUser;
    await setDoc(doc(db, "candidates", backendId), {
      ...data, candidate_id: backendId, is_latest: true, createdAt: serverTimestamp()
    });
    if (user) {
      await setDoc(doc(db, "users", user.uid),
        { candidate_id: backendId, latest_candidate_id: backendId }, { merge: true });
    }
    try { await deleteDoc(doc(db, "candidates", localId)); } catch(e) {}
    console.log("✅ Migrated:", localId, "→", backendId);
    return backendId;

  } catch (err) {
    console.warn(err.name === "AbortError" ? "Backend timed out" : "Backend failed:", err.message);
    return localId;
  }
}


/* =========================================================
   LOAD JOB MATCHES
   Fetches raw matches, enriches via Gemini, then renders
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
  grid.innerHTML = Array(count).fill(null).map(_jobMatchSkeleton).join('');
}

async function loadCandidateJobMatches() {
  const select = document.getElementById("candidateSelect");
  const candidateId = select?.value;
  const grid = document.getElementById("matchesGrid");

  if (!candidateId) {
    if (window.showToast) showToast("Please select a resume first.", "warning");
    return;
  }

  // Show skeleton immediately — before any async work
  _showJobMatchSkeletons(grid, 8);

  /* Resolve local_ placeholder to real backend ID before calling /matches */
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

  const res = await apiFetch(
    `/matches?candidate_id=${resolvedId}&top_n=5&offset=0`
  );

  let data = res;

  if (typeof res?.body === "string") {
    data = JSON.parse(res.body);
  }

  const matches = Array.isArray(data)
    ? data
    : data.matches || [];

  if (!matches.length) {
    grid.innerHTML = `
      <div class="empty-state">
        <h4>No matches found</h4>
        <p>We couldn’t find any suitable jobs for this candidate right now.</p>
      </div>
    `;
    return;
  }

  const jobsRes = await apiFetch("/jobs");
  let allJobs = Array.isArray(jobsRes)
    ? jobsRes
    : (() => { try { return JSON.parse(jobsRes?.body || "[]"); } catch { return []; } })();

  // ── GEMINI RERANK + INSIGHT ──
  const llmResults = await enrichMatchesWithLLM(matches, allJobs, candidateId);
  const llmMap = {};
  llmResults.forEach(r => { llmMap[r.job_id] = r; });

  const ranked = [...matches].sort((a, b) => {
    const ra = llmMap[a.job_id]?.ai_rank ?? 999;
    const rb = llmMap[b.job_id]?.ai_rank ?? 999;
    return ra - rb;
  });

  grid.innerHTML = "";

  ranked.forEach((match, idx) => {
    const job = allJobs.find(j => j.job_id === match.job_id) || match || {};

    const location =
      job.location_display || job.location ||
      (job.city && job.country ? `${job.city}, ${job.country}` : job.city || job.country || "Not specified");

    const company = job.company || match.company || "Company not available";

    let salary = "Not disclosed";
    if (job.salary_min && job.salary_max) {
      salary = `$${Math.round(job.salary_min).toLocaleString()} – $${Math.round(job.salary_max).toLocaleString()}`;
    } else if (job.salary_min) {
      salary = `From $${Math.round(job.salary_min).toLocaleString()}`;
    } else if (job.salary_max) {
      salary = `Up to $${Math.round(job.salary_max).toLocaleString()}`;
    }

    const percent = match.match_percent != null ? match.match_percent.toFixed(1) : "0.0";
    const aiInsight = llmMap[match.job_id]?.ai_insight;
    const isTopPick = idx === 0;

    // Store full job data for Know More modal
    const cardData = {
      job_id:      job.job_id || match.job_id,
      title:       match.title || job.title || "Job Title",
      company,
      location,
      salary,
      percent,
      description: job.description || "",
      apply_url:   job.apply_url || match.apply_url || ""
    };

    // ── Match ring geometry ──
    const pct      = parseFloat(percent);
    const circ     = 113; // 2π × r(18)
    const offset   = circ - (pct / 100) * circ;
    let ringColor  = '#f87171';
    if (pct >= 80)      ringColor = '#4ade80';
    else if (pct >= 60) ringColor = '#7aa2ff';
    else if (pct >= 40) ringColor = '#fbbf24';

    grid.innerHTML += `
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
          <button class="match-btn apply" onclick='openApplyLink("${cardData.apply_url || '#'}")'>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
            </svg>
            Apply
          </button>
          <button class="match-btn save" data-savejobid="${cardData.job_id}" onclick='handleSaveJob(this, ${JSON.stringify(job)}, "${candidateId}")'>
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
    `;

    window.__jobCardData = window.__jobCardData || {};
    window.__jobCardData[cardData.job_id] = { ...cardData, candidateId };
  });

  setupMatchFilters();
  setupKnowMoreButtons(candidateId);

  document.querySelectorAll(".apply-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const url = btn.getAttribute("data-url");
      if (!url) { if (window.showToast) showToast("No application link available for this job.", "warning"); return; }
      window.open(url, "_blank", "noopener,noreferrer");
    });
  });
}





/* =========================================================
   MATCH FILTERS
   Handles filtering and sorting of matched jobs
========================================================= */
function setupMatchFilters() {

  const locationFilter = document.getElementById("locationFilter");
  const matchFilter = document.getElementById("matchFilter");
  const salarySort = document.getElementById("salarySort");

  if (!locationFilter) return;

  const cards = () => document.querySelectorAll(".match-card");

  const locations = new Set();
  cards().forEach(c => locations.add(c.dataset.location));

  locationFilter.innerHTML =
    `<option value="">All Locations</option>` +
    [...locations].map(l => `<option value="${l}">${l}</option>`).join("");

  function applyFilters() {

    const loc = locationFilter.value;
    const minMatch = matchFilter.value;

    cards().forEach(card => {

      let visible = true;

      if (loc && card.dataset.location !== loc) visible = false;
      if (minMatch && Number(card.dataset.match) < Number(minMatch)) visible = false;

      card.style.display = visible ? "block" : "none";
    });

    if (salarySort.value) {
      const sorted = [...cards()].sort((a, b) => {
        const aSalary = Number(a.dataset.salary);
        const bSalary = Number(b.dataset.salary);

        return salarySort.value === "high"
          ? bSalary - aSalary
          : aSalary - bSalary;
      });

      const grid = document.getElementById("matchesGrid");
      sorted.forEach(card => grid.appendChild(card));
    }
  }

  locationFilter.onchange = applyFilters;
  matchFilter.onchange = applyFilters;
  salarySort.onchange = applyFilters;
}

window.loadCandidateJobMatches = loadCandidateJobMatches;


/* =========================================================
   AUTH LISTENER
   Loads user candidates after login
========================================================= */
onAuthStateChanged(window.auth, (user) => {
  if (!user) return;

  const select = document.getElementById("candidateSelect");
  if (!select) return;

  loadUserCandidatesOnly();
});


/* =========================================================
   SAVE JOB
   Saves shortlisted job to Firestore
========================================================= */
async function saveJobToFirebase(job, candidateId) {

  const user = auth.currentUser;
  if (!user) return;

  /* ===== SAFE CHECK FIRST ===== */
  if (!job || !job.job_id) {
    console.error("Invalid job object:", job);
    if (window.showToast) showToast("Job data is missing. Please try again.", "error");
    return;
  }

  const docId = `${user.uid}_${candidateId}_${job.job_id}`;

  await setDoc(doc(db, "saved_jobs", docId), {
    user_id: user.uid,
    candidate_id: candidateId,
    job_id: job.job_id,
    title: job.title || "Untitled Job",
    company: job.company || "Company not available",
    location:
      job.location_display ||
      job.location ||
      (job.city && job.country
        ? `${job.city}, ${job.country}`
        : "Location not specified"),
    salary_min: job.salary_min ?? null,
    salary_max: job.salary_max ?? null,
    description: job.description || "",
    apply_url: job.apply_url || "#",
    savedAt: serverTimestamp()
  });

  trackInteraction({
    job_id: job.job_id,
    candidate_id: candidateId,
    action: "shortlist"
  });

  if (window.showToast) showToast("Job saved to your list.", "success");
}

/* =========================================================
   TRACK INTERACTION
   Sends interaction data to backend analytics endpoint
========================================================= */
async function trackInteraction({ job_id, candidate_id, action }) {
  try {
    await fetch(
      "https://2bcj60lax1.execute-api.eu-north-1.amazonaws.com/prod/trackInteraction",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          job_id,
          candidate_id,
          action
        })
      }
    );
  } catch (err) {
    console.warn("Interaction tracking failed:", err);
  }
}
function openApplyLink(url) {

  if (!url || url === "#" || url.trim() === "") {
    if (window.showToast) showToast("No application link available for this job.", "warning");
    return;
  }

  window.open(url, "_blank", "noopener,noreferrer");
}

/* =========================================================
   SAVE BUTTON HANDLER — styled feedback, no alert
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
  } catch(e) {
    console.error("Save failed:", e);
  }
}
window.handleSaveJob = handleSaveJob;

/* =========================================================
   GLOBAL EXPORTS
========================================================= */
window.loadCandidateJobMatches = loadCandidateJobMatches;
window.saveJobToFirebase = saveJobToFirebase;
window.openApplyLink = openApplyLink;

/* =========================================================
   KNOW MORE MODAL — JD ANALYSIS + PREP TIPS
========================================================= */

// Cache: job_id → modal analysis result
const knowMoreCache = {};

function setupKnowMoreButtons(candidateId) {
  document.querySelectorAll(".know-more-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const jobId = btn.getAttribute("data-jobid");
      const jobData = window.__jobCardData?.[jobId];
      if (!jobData) return;
      openKnowMoreModal(jobData, candidateId);
    });
  });
}

async function openKnowMoreModal(jobData, candidateId) {

  // Inject modal + overlay if not already in DOM
  if (!document.getElementById("knowMoreOverlay")) {
    const overlay = document.createElement("div");
    overlay.id = "knowMoreOverlay";
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
        position:relative; color:#f9fafb;
        font-family:inherit;
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

    // Close on overlay click or X button
    overlay.addEventListener("click", e => {
      if (e.target === overlay) overlay.style.display = "none";
    });
    document.getElementById("knowMoreClose").addEventListener("click", () => {
      overlay.style.display = "none";
    });
  }

  const overlay  = document.getElementById("knowMoreOverlay");
  const content  = document.getElementById("knowMoreContent");
  overlay.style.display = "flex";

  // Show title + spinner while loading
  const descSnippet = (jobData.description || "").slice(0, 80).replace(/</g,"&lt;");
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

  // Return cached result instantly
  if (knowMoreCache[jobData.job_id]) {
    renderKnowMoreResult(content, jobData, knowMoreCache[jobData.job_id]);
    return;
  }

  // Fetch candidate resume for personalised tips
  let resumeSnippet = "";
  try {
    const { getDoc, doc } = await import("https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js");
    const snap = await getDoc(doc(window.db, "candidates", candidateId));
    if (snap.exists()) {
      resumeSnippet = (snap.data().resume_text || "").slice(0, 800);
    }
  } catch (e) { /* no resume available */ }

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
    // AFTER:
const { callGemini } = await import("./gemini.js");
const raw = await callGemini(prompt);
const clean = raw.replace(/```json|```/g, "").trim();
const jsonStr = clean.match(/\{[\s\S]*\}/)?.[0] || clean;
const parsed = JSON.parse(jsonStr);
    knowMoreCache[jobData.job_id] = parsed;
    renderKnowMoreResult(content, jobData, parsed);
  } catch (err) {
    console.warn("Know More LLM failed:", err);
    content.innerHTML += `<p style="color:#ef4444;font-size:13px;">Analysis failed. Please try again.</p>`;
  }
}

function renderKnowMoreResult(content, jobData, data) {

  const tipsHTML = (data.tips || []).map((t, i) => `
    <div style="
      display:flex;gap:14px;align-items:flex-start;
      padding:12px 14px;background:#0d1117;
      border-radius:10px;border:1px solid #1f2937;
    ">
      <div style="
        min-width:26px;height:26px;border-radius:50%;
        background:linear-gradient(135deg,#4f46e5,#a78bfa);
        display:flex;align-items:center;justify-content:center;
        font-size:12px;font-weight:700;color:#fff;flex-shrink:0;
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
    <!-- Header -->
    <div style="margin-bottom:22px;">
      <div style="font-size:11px;color:#a78bfa;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px;">Job Breakdown</div>
      <h2 style="margin:0 0 4px;font-size:20px;color:#f9fafb;">${jobData.title}</h2>
      <p style="margin:0;color:#9ca3af;font-size:14px;">${jobData.company} &nbsp;·&nbsp; ${jobData.location} &nbsp;·&nbsp; ${jobData.salary}</p>
    </div>

    <!-- Divider -->
    <div style="height:1px;background:#1f2937;margin-bottom:20px;"></div>

    <!-- Summary -->
    <div style="margin-bottom:20px;">
      <div style="font-size:11px;color:#6b7280;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:10px;">About the Role</div>
      <p style="color:#d1d5db;font-size:14px;line-height:1.6;margin:0;">${data.summary || ""}</p>
    </div>

    <!-- What you'll do -->
    ${doHTML ? `
    <div style="margin-bottom:22px;">
      <div style="font-size:11px;color:#6b7280;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:10px;">What You'll Do</div>
      <ul style="margin:0;padding-left:18px;">${doHTML}</ul>
    </div>` : ""}

    <!-- Divider -->
    <div style="height:1px;background:#1f2937;margin-bottom:20px;"></div>

    <!-- Prep Tips -->
    <div style="margin-bottom:24px;">
      <div style="font-size:11px;color:#a78bfa;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:12px;">✨ How to Prepare</div>
      <div style="display:flex;flex-direction:column;gap:10px;">${tipsHTML}</div>
    </div>

    <!-- Apply CTA -->
    ${jobData.apply_url ? `
    <a href="${jobData.apply_url}" target="_blank" rel="noopener noreferrer" style="
      display:block;text-align:center;
      background:linear-gradient(135deg,#4f46e5,#a78bfa);
      color:#fff;font-weight:600;font-size:14px;
      padding:13px 24px;border-radius:10px;
      text-decoration:none;margin-top:4px;
    ">Apply for this Role →</a>` : ""}
  `;
}

window.setupKnowMoreButtons = setupKnowMoreButtons;
window.openKnowMoreModal    = openKnowMoreModal;