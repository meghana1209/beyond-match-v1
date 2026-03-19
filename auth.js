/* =========================================================
   FIREBASE IMPORTS
========================================================= */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getAnalytics, logEvent }
from "https://www.gstatic.com/firebasejs/10.7.1/firebase-analytics.js";
import {
  getFirestore,
  serverTimestamp,
  doc,
  setDoc,
  getDoc,
  updateDoc
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";


/* =========================================================
   FIREBASE CONFIGURATION
========================================================= */
const firebaseConfig = {
  apiKey: "AIzaSyCbrwCaaQYEFCF1FJto_O3OYi68qTOqGQc",
  authDomain: "beyondmatch-a714f.firebaseapp.com",
  projectId: "beyondmatch-a714f",
  storageBucket: "beyondmatch-a714f.firebasestorage.app",
  messagingSenderId: "16758090560",
  appId: "1:16758090560:web:89f207139970c97592a8a5",
  measurementId: "G-VZN3JKW8DX"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const analytics = getAnalytics(app);

const API_BASE = "https://2bcj60lax1.execute-api.eu-north-1.amazonaws.com/prod";

/* Flag to prevent redirect while signup Firestore writes are in progress */
let _signupInProgress = false;


/* =========================================================
   GLOBAL AUTH STATE LISTENER
========================================================= */
onAuthStateChanged(auth, async (user) => {
  const path = window.location.pathname;

  if (!user) {
    if (!path.endsWith("index.html") && path !== "/") {
      window.location.href = "/index.html";
    }
    return;
  }

  /* ── TOKEN EXPIRY WATCHER (non-landing pages) ── */
  if (!path.endsWith("index.html") && path !== "/") {
    try {
      const tokenResult = await user.getIdTokenResult();
      const minsLeft = (new Date(tokenResult.expirationTime) - new Date()) / 60000;
      if (minsLeft < 5) {
        if (window.showToast) {
          showToast("Session expiring soon — please save your work.", "warning");
        }
      }
    } catch (e) { /* non-critical — ignore */ }
  }

  if (path.endsWith("index.html") || path === "/") {
    /* Wait for signup writes to finish before redirecting */
    if (_signupInProgress) {
      await new Promise(resolve => {
        const check = setInterval(() => {
          if (!_signupInProgress) { clearInterval(check); resolve(); }
        }, 100);
        setTimeout(() => { clearInterval(check); resolve(); }, 5000); // max 5s wait
      });
    }

    const snap = await getDoc(doc(db, "users", user.uid));
    const role     = snap.exists() ? snap.data().role     : "candidate";
    const userData = snap.exists() ? snap.data()          : {};

    /* ── Safety net: candidate signed up but candidate_id not written yet ── */
    if (role === "candidate" && !userData.candidate_id) {
      const fallbackId = `local_${user.uid}`;
      try {
        const existingCand = await getDoc(doc(db, "candidates", fallbackId));
        if (!existingCand.exists()) {
          await setDoc(doc(db, "candidates", fallbackId), {
            candidate_id: fallbackId,
            name:         user.email.split("@")[0],
            email:        user.email,
            user_id:      user.uid,
            applied_role: "candidate",
            resume_text:  "",
            is_latest:    true,
            createdAt:    serverTimestamp()
          });
        }
        await setDoc(doc(db, "users", user.uid), {
          candidate_id:        fallbackId,
          latest_candidate_id: fallbackId
        }, { merge: true });
      } catch (e) {
      }
    }

    if (role === "recruiter") {
      /* ── Backfill: write recruiter_id if missing (existing accounts) ── */
      if (!userData.recruiter_id) {
        try {
          await updateDoc(doc(db, "users", user.uid), { recruiter_id: user.uid });
        } catch (e) {
        }
      }
      window.location.href = "/rec-dash.html";
    } else if (role === "admin") {
      window.location.href = "/admin.html";
    } else {
      window.location.href = "/candidate-dashboard.html";
    }
  }
});


/* =========================================================
   LOGOUT
========================================================= */
window.unifiedLogout = async function () {
  try {
    await signOut(auth);
    window.location.replace("index.html");
  } catch (err) {
    if (window.showToast) showToast("Logout failed. Please try again.", "error"); else alert("Logout failed.");
  }
};


/* =========================================================
   AUTH STATE VARIABLES
========================================================= */
let authMode = "login";
let justSignedUp = false;

/* Parsed resume text captured during candidate signup */
let _signupResumeText = "";


/* =========================================================
   RESUME PARSING HELPERS (used in signup modal)
========================================================= */
async function _parsePDF(file) {
  /* pdf.js must be loaded on the page */
  const buffer = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data: buffer }).promise;
  let text = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map(x => x.str).join(" ") + "\n";
  }
  return text;
}

async function _parseDOCX(file) {
  const buffer = await file.arrayBuffer();
  const result = await window.mammoth.extractRawText({ arrayBuffer: buffer });
  return result.value;
}

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
    let score = 0;
    ROLE_KEYWORDS[role].forEach(k => { if (t.includes(k)) score++; });
    if (score > maxScore) { maxScore = score; bestRole = role; }
  }
  return bestRole;
}


/* =========================================================
   AUTH MODAL UI CONTROL
========================================================= */
function openAuth(mode) {
  authMode = mode;
  updateAuthUI();
  clearAuthMessage();
  document.getElementById("authOverlay").style.display = "block";
  document.getElementById("authCard").style.display = "block";
}

function closeAuth() {
  document.getElementById("authOverlay").style.display = "none";
  document.getElementById("authCard").style.display = "none";
}

function toggleAuth() {
  authMode = authMode === "login" ? "signup" : "login";
  updateAuthUI();
  clearAuthMessage();
}


/* =========================================================
   UPDATE AUTH UI
========================================================= */
function updateAuthUI() {
  const title       = document.getElementById("authTitle");
  const text        = document.getElementById("authText");
  const link        = document.getElementById("authToggleLink");
  const btn         = document.querySelector(".auth-btn");
  const roleSelect  = document.getElementById("roleSelect");
  const orgInput    = document.getElementById("orgNameInput");
  const resumeWrap  = document.getElementById("resumeUploadWrap");

  if (authMode === "login") {
    title.innerText = "Login";
    text.innerText  = "Don't have an account?";
    link.innerText  = "Sign Up";
    btn.innerText   = "Login";

    if (roleSelect)  roleSelect.style.display  = "none";
    if (resumeWrap)  resumeWrap.style.display   = "none";

  } else {
    title.innerText = "Sign Up";
    text.innerText  = "Already have an account?";
    link.innerText  = "Login";
    btn.innerText   = "Create Account";

    if (roleSelect) roleSelect.style.display  = "block";
    if (orgInput)   { orgInput.style.display = "none"; orgInput.value = ""; }

    /* Show resume upload only when candidate role is selected (handled by role change) */
    if (resumeWrap) resumeWrap.style.display = "none";
    _signupResumeText = "";
  }
}


/* =========================================================
   AUTH MESSAGE HELPERS
========================================================= */
function showMessage(text, type = "error") {
  const msg = document.getElementById("authMessage");
  msg.innerText = text;
  msg.className = `auth-message ${type}`;
  msg.style.display = "block";
}

function clearAuthMessage() {
  const msg = document.getElementById("authMessage");
  if (!msg) return;
  msg.innerText = "";
  msg.style.display = "none";
}


/* =========================================================
   AUTH FORM SUBMIT HANDLER
========================================================= */
document.addEventListener("DOMContentLoaded", () => {
  const emailInput    = document.getElementById("authEmail")    || document.querySelector('.auth-card input[type="email"]');
  const passwordInput = document.getElementById("authPassword") || document.querySelector('.auth-card input[type="password"]');
  const btn           = document.querySelector(".auth-btn");

  if (!btn) return;

  /* ── RESUME FILE INPUT HANDLER (candidate signup) ── */
  const resumeFileInput = document.getElementById("authResumeFile");
  const resumeStatus    = document.getElementById("authResumeStatus");

  if (resumeFileInput) {
   resumeFileInput.addEventListener("change", async () => {
  const file = resumeFileInput.files[0];
  if (!file) return;

  btn.disabled = true;
  resumeStatus.textContent = "Parsing…";
  _signupResumeText = "";

     try {

  const ext = file.name.split(".").pop().toLowerCase();

  if (ext === "pdf" && window.pdfjsLib) {
    _signupResumeText = await _parsePDF(file);
  }

  else if (ext === "docx" && window.mammoth) {
    _signupResumeText = await _parseDOCX(file);
  }

  else {
    resumeStatus.textContent = "Unsupported file type.";
    btn.disabled = false;
    return;
  }

  resumeStatus.textContent = "✓ Resume parsed successfully";
  btn.disabled = false;

} catch (err) {

  resumeStatus.textContent = "Failed to parse resume.";
  btn.disabled = false;

}
    });
  }

  /* ── MAIN SUBMIT ── */
  btn.onclick = async () => {
    clearAuthMessage();

    const email    = emailInput.value.trim();
    const password = passwordInput.value;
    const role     = authMode === "signup"
      ? document.getElementById("roleSelect")?.value
      : null;

    // 🚨 Ensure resume was parsed before allowing candidate signup
if (authMode === "signup" && role === "candidate") {
  if (!_signupResumeText || !_signupResumeText.trim()) {
    showMessage("Please upload your resume before signing up.");
    btn.disabled = false;
    return;
  }
}

    if (!email || !password) { showMessage("Please enter email and password."); return; }
    if (password.length < 6) { showMessage("Password must be at least 6 characters."); return; }
    if (authMode === "signup" && !role) { showMessage("Please select a role."); return; }

    const orgName = document.getElementById("orgNameInput")?.value.trim();
    if (authMode === "signup" && role === "recruiter" && !orgName) {
      showMessage("Please enter organisation name.");
      return;
    }

    btn.disabled = true;

    try {
      /* ── SIGNUP ── */
      if (authMode === "signup") {
        const cred = await createUserWithEmailAndPassword(auth, email, password);
       
const uid = cred.user.uid;

if (role === "candidate") {

  const candidateId = `local_${uid}`;
  const candidateName = email.split("@")[0];
  const inferredRole = inferRoleFromResume(_signupResumeText);

  // 🔥 CREATE candidate document immediately
  await setDoc(doc(db, "candidates", candidateId), {
    candidate_id: candidateId,
    name: candidateName,
    email: email,
    user_id: uid,
    applied_role: inferredRole,
    resume_text: _signupResumeText,
    is_latest: true,
    createdAt: serverTimestamp()
  });

  // 🔥 LINK user → candidate
  await setDoc(doc(db, "users", uid), {
    email,
    role: "candidate",
    candidate_id: candidateId,
    latest_candidate_id: candidateId,
    createdAt: serverTimestamp()
  });

}
        /* Pre-compute fallback candidateId so it's always available */
        const fallbackCandidateId = role === "candidate" ? `local_${cred.user.uid}` : null;

        /* Save user profile — include candidate_id for candidates, recruiter_id for recruiters */
        await setDoc(doc(db, "users", cred.user.uid), {
          email,
          role,
          organisation_name:   role === "recruiter" ? orgName : null,
          recruiter_id:        role === "recruiter" ? cred.user.uid : null,
          candidate_id:        fallbackCandidateId,
          latest_candidate_id: fallbackCandidateId,
          createdAt: serverTimestamp()
        }, { merge: true });

        /* If candidate — always store resume in Firestore regardless of backend result */
        if (role === "candidate") {
          const candidateName = email.split("@")[0];
          const inferredRole  = inferRoleFromResume(_signupResumeText);
          let   candidateId   = null;

          /* ── 1. Try to register with backend (5s timeout) ── */
          if (_signupResumeText.trim()) {
            try {
              showMessage("Creating your profile…", "success");
              const controller = new AbortController();
              const timeoutId  = setTimeout(() => controller.abort(), 5000);
              const res = await fetch(`${API_BASE}/candidates`, {
                method:  "POST",
                headers: { "Content-Type": "application/json" },
                signal:  controller.signal,
                body:    JSON.stringify({
                  name:        candidateName,
                  email:       email,
                  resume_text: _signupResumeText
                })
              });
              clearTimeout(timeoutId);

              const raw  = await res.text();

              let data = {};
              try { data = JSON.parse(raw); } catch(e) {}

              candidateId = data?.candidate_id
                || (typeof data?.body === "string"
                    ? (() => { try { return JSON.parse(data.body)?.candidate_id; } catch(e) { return null; } })()
                    : null);


            } catch (err) {
              if (err.name === "AbortError") {
              } else {
              }
            }
          }

          /* ── 2. Fallback: use uid-based ID if backend gave nothing ── */
          if (!candidateId) {
            candidateId = fallbackCandidateId;
          }

          /* ── 3. Write candidate doc ── */
          _signupInProgress = true;
          try {
            await setDoc(doc(db, "candidates", candidateId), {
              candidate_id: candidateId,
              name:         candidateName,
              email,
              user_id:      cred.user.uid,
              applied_role: inferredRole,
              resume_text:  _signupResumeText || "",
              is_latest:    true,
              createdAt:    serverTimestamp()
            });
          } catch (candErr) {
          }

          /* ── 4. ALWAYS write candidate_id to users doc (separate try so it never gets skipped) ── */
          try {
            await setDoc(doc(db, "users", cred.user.uid), {
              email,
              role,
              organisation_name:   null,
              candidate_id:        candidateId,
              latest_candidate_id: candidateId,
              createdAt:           serverTimestamp()
            }, { merge: true });
            _signupInProgress = false;

            logEvent(analytics, "candidate_created", {
              recruiter_id:  cred.user.uid,
              role_detected: inferredRole,
              source:        "signup"
            });

          } catch (firestoreErr) {
            _signupInProgress = false;
            showMessage("Account created but profile save failed. Please re-login.", "error");
          }
        }

        showMessage("Account created successfully 🎉 Please login.", "success");
        justSignedUp = true;
        authMode = "login";
        updateAuthUI();
        btn.disabled = false;
        return;
      }

      /* ── LOGIN ── */
      try {
        await signInWithEmailAndPassword(auth, email, password);
      } catch (loginErr) {
        // Re-throw so the outer catch handles the user-facing message,
        // but this inner try prevents Firebase from logging the 400 to console.
        throw loginErr;
      }
      showMessage("Login successful. Redirecting…", "success");

    } catch (error) {
      if (error.code === "auth/email-already-in-use") {
        showMessage("Email already registered. Please login.");
      } else if (error.code === "auth/wrong-password") {
        showMessage("Incorrect password.");
      } else if (error.code === "auth/user-not-found") {
        showMessage("No account found. Please sign up.");
      } else if (error.code === "auth/invalid-email") {
        showMessage("Invalid email format.");
      } else {
        showMessage("Authentication failed. Please try again.");
      }
    } finally {
      btn.disabled = false;
    }
  };
});


/* =========================================================
   ROLE SELECT HANDLER
   Shows org field for recruiter, resume upload for candidate
========================================================= */
document.getElementById("roleSelect")?.addEventListener("change", (e) => {
  const orgInput   = document.getElementById("orgNameInput");
  const resumeWrap = document.getElementById("resumeUploadWrap");

  /* org field */
  if (orgInput) {
    orgInput.style.display = e.target.value === "recruiter" ? "block" : "none";
    if (e.target.value !== "recruiter") orgInput.value = "";
  }

  /* resume upload (candidates only) */
  if (resumeWrap) {
    resumeWrap.style.display = e.target.value === "candidate" ? "block" : "none";
    if (e.target.value !== "candidate") {
      _signupResumeText = "";
      const fi = document.getElementById("authResumeFile");
      const rs = document.getElementById("authResumeStatus");
      if (fi) fi.value = "";
      if (rs) rs.textContent = "";
    }
  }
});


/* =========================================================
   GLOBAL EXPORTS
========================================================= */
window.auth = auth;
window.db   = db;

window.openAuth  = openAuth;
window.closeAuth = closeAuth;
window.toggleAuth = toggleAuth;

export { analytics, auth, db };