/**
 * apply-job.js — BeyondMatch
 * ─────────────────────────────────────────────────────────────
 * Handles what happens when a candidate clicks "Apply" on a job.
 *
 * USAGE (add to cand-matches.html and candidate-dashboard.html):
 *   <script type="module" src="apply-job.js"></script>
 *
 * Exposes: window.applyToJob(jobId, jobTitle, recruiterId, jobFirestoreId)
 * ─────────────────────────────────────────────────────────────
 * Firestore structure created:
 *
 * applications/{auto_id} {
 *   job_id, job_title,
 *   candidate_id, candidate_name, candidate_email,
 *   recruiter_id,
 *   status: "applied",
 *   note: "",
 *   rec_unread: true,
 *   cand_unread: false,
 *   status_history: [],
 *   applied_at: serverTimestamp(),
 *   updated_at: serverTimestamp()
 * }
 *
 * notifications/{auto_id} {
 *   to_user_id: recruiterId,
 *   to_role: "recruiter",
 *   from_role: "candidate",
 *   type: "new_application",
 *   app_id, job_title, candidate_name,
 *   message: "...",
 *   read: false,
 *   created_at: serverTimestamp()
 * }
 * ─────────────────────────────────────────────────────────────
 */

import { auth, db } from "./auth.js";
import {
  collection, addDoc, query, where, getDocs, doc, getDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

/* ─────────────────────────────────────────────────
   safeToast
   FIX: The original code called showToast() directly (not window.showToast),
   which throws a ReferenceError because showToast lives in api.js as a module
   export and is not in scope here. Also guarded with window.showToast check
   which was correct but the bare showToast() call immediately after would
   still throw. Use this helper everywhere instead.
   ───────────────────────────────────────────────── */
function safeToast(msg, type, title) {
  if (typeof window.showToast === "function") {
    window.showToast(msg, type, title);
  } else {
    console.warn("[applyToJob toast]", type?.toUpperCase(), title || "", msg);
  }
}

/* ─────────────────────────────────────────────────
   waitForAuth
   FIX: auth.currentUser is null immediately on page load because Firebase
   resolves the persisted session asynchronously. The original code checked
   auth.currentUser synchronously and would always see null on first call,
   silently refusing every application attempt until the page was interacted
   with again. Wrap in onAuthStateChanged so we wait for the real value.
   ───────────────────────────────────────────────── */
function waitForAuth() {
  return new Promise((resolve) => {
    const unsub = onAuthStateChanged(auth, (user) => {
      unsub();
      resolve(user);
    });
  });
}

/* ─────────────────────────────────────────────────
   _isSubmitting guard
   Prevents simultaneous duplicate submissions when the user
   clicks Apply more than once before the first call resolves.
   ───────────────────────────────────────────────── */
let _isSubmitting = false;

/* ─────────────────────────────────────────────────
   applyToJob
   Call this when a candidate clicks the Apply button.

   @param {string} jobId            — the job's backend id (job_id field)
   @param {string} jobTitle         — display title of the job
   @param {string} recruiterId      — uid of the recruiter who posted the job
   @param {string} [jobFirestoreId] — Firestore doc id if different from jobId
   @param {string} [candidateNote]  — optional cover note from the modal
   @param {string} [companyName]    — company name passed from the card (avoids Firestore lookup)
   ───────────────────────────────────────────────── */
window.applyToJob = async function (jobId, jobTitle, recruiterId, jobFirestoreId, candidateNote, companyName) {
  // FIX: Prevent simultaneous duplicate submissions (rapid double-click or
  // multiple Apply buttons clicked before the first resolves).
  if (_isSubmitting) {
    console.warn("applyToJob: submission already in progress, ignoring duplicate call.");
    return false;
  }
  _isSubmitting = true;

  try {
    return await _doApply(jobId, jobTitle, recruiterId, jobFirestoreId, candidateNote, companyName);
  } finally {
    _isSubmitting = false;
  }
};

async function _doApply(jobId, jobTitle, recruiterId, jobFirestoreId, candidateNote, companyName) {
  // If jobId is undefined, the Firestore where("job_id", "==", undefined) call
  // throws: "FirebaseError: Unsupported field value: undefined".
  // This happens when _applyClick() in candidate.js fails to resolve the id
  // from the button's data attributes (e.g. wrong dataset key, wrong button
  // variant rendered). Fail fast here with a clear message instead.
  if (!jobId) {
    console.error("applyToJob called with missing jobId. Check data-apply-job attribute on the Apply button.");
    safeToast("Could not identify the job. Please refresh and try again.", "error");
    return false;
  }

  // FIX: Wait for Firebase auth to resolve before checking currentUser.
  // The original synchronous auth.currentUser check always returned null on
  // first page load, causing every apply attempt to silently fail.
  const user = await waitForAuth();
  if (!user) {
    safeToast("Please log in to apply.", "warning");
    return false;
  }

  // get candidate profile
  const userSnap = await getDoc(doc(db, "users", user.uid)).catch(() => null);
  if (!userSnap?.exists()) {
    safeToast("Candidate profile not found.", "error");
    return false;
  }
  const userData = userSnap.data();
  const candidateId = userData.candidate_id || userData.latest_candidate_id;
  if (!candidateId) {
    safeToast("Please complete your profile first.", "warning");
    return false;
  }

  // fetch candidate details
  let candidateName  = user.email?.split("@")[0] || "Candidate";
  let candidateEmail = user.email || "";
  let candidateRole  = "";
  try {
    const cSnap = await getDoc(doc(db, "candidates", candidateId));
    if (cSnap.exists()) {
      const cd = cSnap.data();
      candidateName  = cd.name  || candidateName;
      candidateEmail = cd.email || candidateEmail;
      candidateRole  = cd.applied_role || "";
    }
  } catch { /* use fallbacks */ }

  // fetch company name — use the value passed from the card first.
  // Only fall back to a Firestore lookup if we don't have it yet AND
  // jobFirestoreId looks like a real Firestore doc ID (i.e. the job was
  // posted via rec-postjob.html, not fetched from the external API).
  let resolvedCompany = companyName || "";
  if (!resolvedCompany && jobFirestoreId && jobFirestoreId !== jobId) {
    try {
      const jobSnap = await getDoc(doc(db, "posted_jobs", jobFirestoreId));
      if (jobSnap.exists()) {
        const jd = jobSnap.data();
        resolvedCompany = jd.organisation_name || jd.company || jd.company_name || "";
      }
    } catch { /* non-critical */ }
  }

  // check for duplicate application
  // Query by candidate_user_id (Firebase UID) + job_id — candidate_user_id is
  // already indexed so no extra composite index is needed.
  // Do NOT silently catch errors: if this fails we must not proceed and create a duplicate.
  try {
    const dupQ = query(
      collection(db, "applications"),
      where("candidate_user_id", "==", user.uid),
      where("job_id",            "==", jobId)
    );
    const dupSnap = await getDocs(dupQ);
    if (!dupSnap.empty) {
      safeToast("You've already applied to this job.", "info", "Already Applied");
      return false;
    }
  } catch (err) {
    console.error("applyToJob duplicate check failed:", err);
    safeToast("Could not verify application status. Please try again.", "error");
    return false;
  }

  // create application doc
  let appRef;
  try {
    appRef = await addDoc(collection(db, "applications"), {
      job_id:             jobId,
      job_firestore_id:   jobFirestoreId || jobId,
      job_title:          jobTitle,
      company_name:       resolvedCompany,
      candidate_id:       candidateId,
      candidate_user_id:  user.uid,        // Firebase UID — used by Firestore rules & queries
      candidate_name:     candidateName,
      candidate_email:    candidateEmail,
      candidate_role:     candidateRole,
      recruiter_id:       recruiterId,
      status:             "applied",
      note:               candidateNote || "",
      rec_unread:         true,
      cand_unread:        false,
      status_history:     [],
      applied_at:         serverTimestamp(),
      updated_at:         serverTimestamp()
    });
  } catch (err) {
    safeToast("Application failed. Please try again.", "error");
    console.error("applyToJob error:", err);
    return false;
  }

  // create recruiter notification
  if (recruiterId) {
    try {
      await addDoc(collection(db, "notifications"), {
        to_user_id:     recruiterId,
        to_role:        "recruiter",
        from_role:      "candidate",
        type:           "new_application",
        app_id:         appRef.id,
        job_id:         jobId,
        job_title:      jobTitle,
        candidate_name: candidateName,
        message:        `${candidateName} applied for "${jobTitle}".`,
        read:           false,
        created_at:     serverTimestamp()
      });
    } catch { /* non-critical */ }
  }

  safeToast(`Applied to ${jobTitle}!`, "success", "Application Sent");
  return true;
}


/* ─────────────────────────────────────────────────
   hasApplied
   Check if current candidate already applied to a job.
   Returns true/false. Useful to disable Apply buttons.
   ───────────────────────────────────────────────── */
window.hasApplied = async function (jobId) {
  // FIX: Use waitForAuth() instead of auth.currentUser for the same reason
  // as applyToJob — synchronous check returns null on first page load.
  const user = await waitForAuth();
  if (!user) return false;
  try {
    const q = query(
      collection(db, "applications"),
      where("candidate_user_id", "==", user.uid),
      where("job_id",            "==", jobId)
    );
    const snap = await getDocs(q);
    return !snap.empty;
  } catch { return false; }
};


/* ─────────────────────────────────────────────────
   markApplyButtons
   Call after rendering job cards to automatically
   update Apply button states based on existing apps.

   @param {Array} jobs — array of job objects with .job_id and .recruiter_id
   ───────────────────────────────────────────────── */
window.markApplyButtons = async function (jobs) {
  // FIX: Use waitForAuth() for consistency — avoids null currentUser race.
  const user = await waitForAuth();
  if (!user || !jobs?.length) return;

  try {
    const userSnap    = await getDoc(doc(db, "users", user.uid));
    const candidateId = userSnap.exists()
      ? (userSnap.data().candidate_id || userSnap.data().latest_candidate_id)
      : null;
    if (!candidateId) return;

    const q = query(
      collection(db, "applications"),
      where("candidate_id", "==", candidateId)
    );
    const snap    = await getDocs(q);
    const applied = new Set(snap.docs.map(d => d.data().job_id));

    document.querySelectorAll("[data-apply-job]").forEach(btn => {
      const jobId = btn.getAttribute("data-apply-job");
      if (applied.has(jobId)) {
        btn.textContent   = "✓ Applied";
        btn.disabled      = true;
        btn.style.opacity = "0.6";
        btn.style.cursor  = "default";
      }
    });
  } catch { /* best-effort */ }
};