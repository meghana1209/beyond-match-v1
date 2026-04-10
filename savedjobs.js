/* =========================================================
   SAVED JOBS
   Loads and renders the current user's bookmarked jobs.
   Supports animated card removal.
========================================================= */
import { onAuthStateChanged } from
  "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
  collection,
  getDocs,
  deleteDoc,
  doc,
  query,
  where
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const db   = window.db;
const auth = window.auth;

const EMPTY_STATE_HTML = `
  <div class="empty-state">
    <div class="empty-state-icon">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
        <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
      </svg>
    </div>
    <h4>No saved jobs yet</h4>
    <p>Head to <a href="jobmatches.html">Job Matches</a> and bookmark roles you like.</p>
  </div>`;

function formatSalary(job) {
  if (job.salary_min && job.salary_max) {
    return `$${Math.round(job.salary_min).toLocaleString()} – $${Math.round(job.salary_max).toLocaleString()}`;
  }
  if (job.salary_min) return `From $${Math.round(job.salary_min).toLocaleString()}`;
  if (job.salary_max) return `Up to $${Math.round(job.salary_max).toLocaleString()}`;
  return "";
}

function updateCount(count, grid) {
  if (!count) return;
  const n = grid.querySelectorAll(".saved-card").length;
  count.textContent = n ? `${n} saved job${n === 1 ? "" : "s"}` : "";
}

async function loadSavedJobs() {
  const user = auth.currentUser;
  if (!user) return;

  const grid  = document.getElementById("savedJobsGrid");
  const count = document.getElementById("savedCount");

  const q        = query(collection(db, "saved_jobs"), where("user_id", "==", user.uid));
  const snapshot = await getDocs(q);

  if (snapshot.empty) {
    grid.innerHTML = EMPTY_STATE_HTML;
    if (count) count.textContent = "";
    return;
  }

  if (count) {
    const n = snapshot.size;
    count.textContent = `${n} saved job${n === 1 ? "" : "s"}`;
  }

  grid.innerHTML = "";

  snapshot.forEach((docSnap, idx) => {
    const job      = docSnap.data();
    const applyUrl = job.apply_url || job.apply_link || "";
    const hasApply = applyUrl && applyUrl !== "#";
    const salary   = formatSalary(job);
    const location = job.location || "Location not specified";

    const card = document.createElement("div");
    card.className         = "saved-card";
    card.style.animationDelay = `${idx * 55}ms`;
    card.dataset.docid     = docSnap.id;

    card.innerHTML = `
      <svg class="saved-bookmark" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
        <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
      </svg>

      <div class="saved-card-title">${job.title || "Job Role"}</div>
      <div class="saved-card-company">${job.company || "Company not available"}</div>

      <div class="saved-meta">
        <span class="meta-chip">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>
          </svg>
          ${location}
        </span>
      </div>

      <div class="saved-salary ${salary ? "" : "unknown"}">${salary || "Salary not disclosed"}</div>

      <div class="card-divider"></div>

      <div class="saved-actions">
        ${hasApply
          ? `<a href="${applyUrl}" target="_blank" rel="noopener noreferrer" class="saved-btn apply">
               <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                 <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                 <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
               </svg>
               Apply
             </a>`
          : `<button class="saved-btn apply disabled" disabled>
               <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                 <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                 <polyline points="15 3 21 3 21 9"/>
               </svg>
               Apply
             </button>`
        }
        <button class="saved-btn remove" onclick="removeSavedJob('${docSnap.id}', this)">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>
          </svg>
          Remove
        </button>
      </div>
    `;

    grid.appendChild(card);
  });
}

async function removeSavedJob(docId, btn) {
  const card = btn?.closest(".saved-card");
  if (card) {
    card.classList.add("removing");
    await new Promise(r => setTimeout(r, 260));
    card.remove();
  }

  await deleteDoc(doc(db, "saved_jobs", docId));

  const grid  = document.getElementById("savedJobsGrid");
  const count = document.getElementById("savedCount");

  if (!grid.querySelectorAll(".saved-card").length) {
    grid.innerHTML = EMPTY_STATE_HTML;
    if (count) count.textContent = "";
  } else {
    updateCount(count, grid);
  }
}

window.removeSavedJob = removeSavedJob;

onAuthStateChanged(auth, (user) => {
  if (!user) return;
  loadSavedJobs();
});
