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
  apiKey:            "AIzaSyCbrwCaaQYEFCF1FJto_O3OYi68qTOqGQc",
  authDomain:        "beyondmatch-a714f.firebaseapp.com",
  projectId:         "beyondmatch-a714f",
  storageBucket:     "beyondmatch-a714f.firebasestorage.app",
  messagingSenderId: "16758090560",
  appId:             "1:16758090560:web:89f207139970c97592a8a5",
  measurementId:     "G-VZN3JKW8DX"
};

const app       = initializeApp(firebaseConfig);
const auth      = getAuth(app);
const db        = getFirestore(app);
const analytics = getAnalytics(app);

const API_BASE = "https://2bcj60lax1.execute-api.eu-north-1.amazonaws.com/prod";

// Prevents redirect while signup Firestore writes are still in-flight
let _signupInProgress = false;


/* =========================================================
   GLOBAL AUTH STATE LISTENER
   Handles redirects, token expiry warnings, and missing
   candidate_id / recruiter_id backfills for existing accounts.
========================================================= */
onAuthStateChanged(auth, async (user) => {
  const path = window.location.pathname;

  if (!user) {
    if (!path.endsWith("index.html") && path !== "/") {
      window.location.href = "/index.html";
    }
    return;
  }

  // Warn when the session token is about to expire
  if (!path.endsWith("index.html") && path !== "/") {
    try {
      const tokenResult = await user.getIdTokenResult();
      const minsLeft    = (new Date(tokenResult.expirationTime) - new Date()) / 60000;
      if (minsLeft < 5 && window.showToast) {
        showToast("Session expiring soon — please save your work.", "warning");
      }
    } catch { /* non-critical — ignore */ }
  }

  if (!path.endsWith("index.html") && path !== "/") return;

  // Wait for any in-progress signup Firestore writes before redirecting
  if (_signupInProgress) {
    await new Promise(resolve => {
      const check = setInterval(() => {
        if (!_signupInProgress) { clearInterval(check); resolve(); }
      }, 100);
      setTimeout(() => { clearInterval(check); resolve(); }, 5000);
    });
  }

  const snap     = await getDoc(doc(db, "users", user.uid));
  const role     = snap.exists() ? snap.data().role     : "candidate";
  const userData = snap.exists() ? snap.data()          : {};

  // Safety net: candidate signed up but candidate_id was never written
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
    } catch { /* best-effort backfill */ }
  }

  if (role === "recruiter") {
    // Backfill recruiter_id for accounts created before this field existed
    if (!userData.recruiter_id) {
      try { await updateDoc(doc(db, "users", user.uid), { recruiter_id: user.uid }); } catch { }
    }
    window.location.href = "/rec-dash.html";
  } else if (role === "admin") {
    window.location.href = "/admin.html";
  } else {
    window.location.href = "/candidate-dashboard.html";
  }
});


/* =========================================================
   LOGOUT
========================================================= */
window.unifiedLogout = async function () {
  try {
    await signOut(auth);
    window.location.replace("index.html");
  } catch {
    if (window.showToast) showToast("Logout failed. Please try again.", "error");
    else alert("Logout failed.");
  }
};


/* =========================================================
   AUTH STATE VARIABLES
========================================================= */
let authMode        = "login";
let _signupResumeText = ""; // Resume text captured during candidate signup


/* =========================================================
   RESUME PARSING HELPERS
   Used during candidate signup to extract text from PDF/DOCX.
========================================================= */
async function _parsePDF(file) {
  const buffer = await file.arrayBuffer();
  const pdf    = await window.pdfjsLib.getDocument({ data: buffer }).promise;
  let text     = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page    = await pdf.getPage(i);
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
    "Backend Developer":   ["backend", "node", "django", "flask", "api", "database", "express"],
    "Frontend Developer":  ["frontend", "html", "css", "react", "ui"],
    "Full Stack Developer":["full stack", "mern", "frontend", "backend"],
    "Software Engineer":   ["software engineer", "java", "javascript"],
    "Data Scientist":      ["machine learning", "deep learning", "statistics", "model"],
    "Data Analyst":        ["data analyst", "power bi", "tableau", "excel", "analytics"],
    "DevOps Engineer":     ["docker", "kubernetes", "aws", "ci/cd"],
    "AI Engineer":         ["nlp", "computer vision", "llm"]
  };

  let bestRole = "General", maxScore = 0;
  for (const role in ROLE_KEYWORDS) {
    const score = ROLE_KEYWORDS[role].filter(k => t.includes(k)).length;
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
  document.getElementById("authCard").style.display   = "block";
}

function closeAuth() {
  document.getElementById("authOverlay").style.display = "none";
  document.getElementById("authCard").style.display   = "none";
}

function toggleAuth() {
  authMode = authMode === "login" ? "signup" : "login";
  updateAuthUI();
  clearAuthMessage();
}

function updateAuthUI() {
  const title      = document.getElementById("authTitle");
  const text       = document.getElementById("authText");
  const link       = document.getElementById("authToggleLink");
  const btn        = document.querySelector(".auth-btn");
  const roleSelect = document.getElementById("roleSelect");
  const orgInput   = document.getElementById("orgNameInput");
  const resumeWrap = document.getElementById("resumeUploadWrap");
  const adminWrap  = document.getElementById("adminKeyWrap");
  const adminInput = document.getElementById("adminKeyInput");

  if (authMode === "login") {
    title.innerText = "Login";
    text.innerText  = "Don't have an account?";
    link.innerText  = "Sign Up";
    btn.innerText   = "Login";

    if (roleSelect) roleSelect.style.display = "none";
    if (resumeWrap) resumeWrap.style.display = "none";
    if (adminWrap)  { adminWrap.style.display = "none"; if (adminInput) adminInput.value = ""; }
  } else {
    title.innerText = "Sign Up";
    text.innerText  = "Already have an account?";
    link.innerText  = "Login";
    btn.innerText   = "Create Account";

    if (roleSelect) roleSelect.style.display = "block";
    if (orgInput)   { orgInput.style.display = "none"; orgInput.value = ""; }
    if (resumeWrap) resumeWrap.style.display = "none";
    _signupResumeText = "";
  }
}


/* =========================================================
   AUTH MESSAGE HELPERS
========================================================= */
function showMessage(text, type = "error") {
  const msg = document.getElementById("authMessage");
  msg.innerText  = text;
  msg.className  = `auth-message ${type}`;
  msg.style.display = "block";
}

function clearAuthMessage() {
  const msg = document.getElementById("authMessage");
  if (!msg) return;
  msg.innerText = "";
  msg.style.display = "none";
}


/* =========================================================
   AUTH FORM — MAIN SUBMIT HANDLER
========================================================= */
document.addEventListener("DOMContentLoaded", () => {
  const emailInput    = document.getElementById("authEmail")    || document.querySelector('.auth-card input[type="email"]');
  const passwordInput = document.getElementById("authPassword") || document.querySelector('.auth-card input[type="password"]');
  const btn           = document.querySelector(".auth-btn");

  if (!btn) return;

  // Resume file input handler (candidate signup only)
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
        } else if (ext === "docx" && window.mammoth) {
          _signupResumeText = await _parseDOCX(file);
        } else {
          resumeStatus.textContent = "Unsupported file type.";
          btn.disabled = false;
          return;
        }

        resumeStatus.textContent = "✓ Resume parsed successfully";
      } catch {
        resumeStatus.textContent = "Failed to parse resume.";
      } finally {
        btn.disabled = false;
      }
    });
  }

  // Main submit
  btn.onclick = async () => {
    clearAuthMessage();

    const email    = emailInput.value.trim();
    const password = passwordInput.value;
    const role     = authMode === "signup" ? document.getElementById("roleSelect")?.value : null;

    if (!email || !password)   { showMessage("Please enter email and password."); return; }
    if (password.length < 6)   { showMessage("Password must be at least 6 characters."); return; }
    if (authMode === "signup" && !role) { showMessage("Please select a role."); return; }

    const orgName = document.getElementById("orgNameInput")?.value.trim();
    if (authMode === "signup" && role === "recruiter" && !orgName) {
      showMessage("Please enter organisation name.");
      return;
    }

    if (authMode === "signup" && role === "candidate") {
      if (!_signupResumeText?.trim()) {
        showMessage("Please upload your resume before signing up.");
        return;
      }
    }

    // Admin key verification
    if (authMode === "signup" && role === "admin") {
      const adminKey = document.getElementById("adminKeyInput")?.value.trim();
      if (!adminKey) {
        showMessage("Please enter the authorization key for admin access.");
        return;
      }
      try {
        const configSnap = await getDoc(doc(db, "config", "adminKey"));
        if (!configSnap.exists()) {
          showMessage("Admin access is not configured. Contact your system administrator.");
          return;
        }
        const configData = configSnap.data();
        let verified = false;

        if (configData?.key) {
          verified = adminKey === configData.key;
        }
        if (!verified && configData?.hash) {
          try {
            const encoder    = new TextEncoder();
            const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(adminKey));
            const hashHex    = Array.from(new Uint8Array(hashBuffer))
              .map(b => b.toString(16).padStart(2, "0")).join("");
            verified = hashHex === configData.hash;
          } catch { /* crypto.subtle unavailable on HTTP — skip hash check */ }
        }

        if (!verified) { showMessage("Invalid authorization key. Access denied."); return; }
      } catch {
        showMessage("Could not verify authorization key. Please try again.");
        return;
      }
    }

    btn.disabled = true;

    try {
      if (authMode === "signup") {
        await _handleSignup(email, password, role, orgName);
      } else {
        await signInWithEmailAndPassword(auth, email, password);
        showMessage("Login successful. Redirecting…", "success");
      }
    } catch (error) {
      const messages = {
        "auth/email-already-in-use": "Email already registered. Please login.",
        "auth/wrong-password":       "Incorrect password.",
        "auth/user-not-found":       "No account found. Please sign up.",
        "auth/invalid-email":        "Invalid email format."
      };
      showMessage(messages[error.code] || "Authentication failed. Please try again.");
    } finally {
      btn.disabled = false;
    }
  };
});


/* =========================================================
   SIGNUP HANDLER
   Extracted from the submit handler for clarity.
========================================================= */
async function _handleSignup(email, password, role, orgName) {
  const btn = document.querySelector(".auth-btn");

  const cred = await createUserWithEmailAndPassword(auth, email, password);
  const uid  = cred.user.uid;

  const fallbackCandidateId = role === "candidate" ? `local_${uid}` : null;
  const candidateName       = email.split("@")[0];

  if (role === "candidate") {
    const inferredRole = inferRoleFromResume(_signupResumeText);

    // Write candidate doc immediately so the user can log in without issues
    await setDoc(doc(db, "candidates", fallbackCandidateId), {
      candidate_id: fallbackCandidateId,
      name:         candidateName,
      email,
      user_id:      uid,
      applied_role: inferredRole,
      resume_text:  _signupResumeText,
      is_latest:    true,
      createdAt:    serverTimestamp()
    });

    // Link user → candidate
    await setDoc(doc(db, "users", uid), {
      email,
      role:                "candidate",
      candidate_id:        fallbackCandidateId,
      latest_candidate_id: fallbackCandidateId,
      createdAt:           serverTimestamp()
    });

    // Try to register with the backend and get a real candidate_id
    let backendCandidateId = null;
    if (_signupResumeText.trim()) {
      try {
        showMessage("Creating your profile…", "success");
        const controller = new AbortController();
        const timeoutId  = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(`${API_BASE}/candidates`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          signal:  controller.signal,
          body:    JSON.stringify({ name: candidateName, email, resume_text: _signupResumeText })
        });
        clearTimeout(timeoutId);

        let data = {};
        try { data = JSON.parse(await res.text()); } catch { }
        backendCandidateId =
          data?.candidate_id ||
          (typeof data?.body === "string"
            ? (() => { try { return JSON.parse(data.body)?.candidate_id; } catch { return null; } })()
            : null);
      } catch { /* timeout or network error — continue with fallback ID */ }
    }

    const finalCandidateId = backendCandidateId || fallbackCandidateId;

    // Write or overwrite the candidate doc with the final ID
    _signupInProgress = true;
    try {
      await setDoc(doc(db, "candidates", finalCandidateId), {
        candidate_id: finalCandidateId,
        name:         candidateName,
        email,
        user_id:      uid,
        applied_role: inferRoleFromResume(_signupResumeText),
        resume_text:  _signupResumeText || "",
        is_latest:    true,
        createdAt:    serverTimestamp()
      });
    } catch { }

    // Always write candidate_id to the users doc
    try {
      await setDoc(doc(db, "users", uid), {
        email,
        role,
        organisation_name:   null,
        candidate_id:        finalCandidateId,
        latest_candidate_id: finalCandidateId,
        createdAt:           serverTimestamp()
      }, { merge: true });

      logEvent(analytics, "candidate_created", {
        recruiter_id:  uid,
        role_detected: inferRoleFromResume(_signupResumeText),
        source:        "signup"
      });
    } catch {
      showMessage("Account created but profile save failed. Please re-login.", "error");
    } finally {
      _signupInProgress = false;
    }

  } else {
    // Recruiter / admin signup
    await setDoc(doc(db, "users", uid), {
      email,
      role,
      organisation_name:   role === "recruiter" ? orgName : null,
      recruiter_id:        role === "recruiter" ? uid     : null,
      candidate_id:        null,
      latest_candidate_id: null,
      createdAt:           serverTimestamp()
    }, { merge: true });
  }

  showMessage("Account created successfully 🎉 Please login.", "success");
  authMode = "login";
  updateAuthUI();
  btn.disabled = false;
}


/* =========================================================
   ROLE SELECT HANDLER
   Toggles org field, resume upload, and admin key input
   based on the selected role during signup.
========================================================= */
document.getElementById("roleSelect")?.addEventListener("change", (e) => {
  const role       = e.target.value;
  const orgInput   = document.getElementById("orgNameInput");
  const resumeWrap = document.getElementById("resumeUploadWrap");
  const adminWrap  = document.getElementById("adminKeyWrap");

  if (orgInput) {
    orgInput.style.display = role === "recruiter" ? "block" : "none";
    if (role !== "recruiter") orgInput.value = "";
  }

  if (resumeWrap) {
    resumeWrap.style.display = role === "candidate" ? "block" : "none";
    if (role !== "candidate") {
      _signupResumeText = "";
      const fi = document.getElementById("authResumeFile");
      const rs = document.getElementById("authResumeStatus");
      if (fi) fi.value = "";
      if (rs) rs.textContent = "";
    }
  }

  if (adminWrap) {
    adminWrap.style.display = role === "admin" ? "block" : "none";
    if (role !== "admin") {
      const ki = document.getElementById("adminKeyInput");
      if (ki) ki.value = "";
    }
  }
});


/* =========================================================
   GLOBAL EXPORTS
========================================================= */
window.auth = auth;
window.db   = db;

window.openAuth   = openAuth;
window.closeAuth  = closeAuth;
window.toggleAuth = toggleAuth;

export { analytics, auth, db };
