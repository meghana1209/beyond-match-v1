/* =========================================================
   REC-LOCATEHIRE — Recruiter Candidate Map
   Shows all candidates as clustered map markers.
   Green markers  = candidates matched to at least one of the
                    recruiter's org jobs.
   Blue  markers  = all other candidates in the pool.
   Clicking a marker opens the right panel with candidate cards.
========================================================= */

let map;
let markersLayer;

const GEOCACHE_KEY = "bm_rec_geocode_cache_v1";

function loadGeoCache() {
  try { return JSON.parse(localStorage.getItem(GEOCACHE_KEY) || "{}"); } catch { return {}; }
}
function saveGeoCache(cache) {
  try { localStorage.setItem(GEOCACHE_KEY, JSON.stringify(cache)); } catch { }
}


/* =========================================================
   GEOCODING
   Nominatim first, Photon as CORS-safe fallback.
========================================================= */
async function nominatim(locationStr) {
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(locationStr)}&format=json&limit=1`;
    const res = await fetch(url, {
      headers: { "Accept-Language": "en", "Referer": window.location.origin }
    });
    if (res.ok) {
      const data = await res.json();
      if (data[0]) return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
    }
  } catch { /* fall through */ }

  try {
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(locationStr)}&limit=1&lang=en`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      const feat = data?.features?.[0];
      if (feat) {
        const [lng, lat] = feat.geometry.coordinates;
        return { lat, lng };
      }
    }
  } catch { /* both failed */ }

  return null;
}


/* =========================================================
   COUNTRY CODE → DISPLAY NAME
========================================================= */
const COUNTRY_CODES = {
  US:"United States", GB:"United Kingdom", AU:"Australia",  IN:"India",
  CA:"Canada",        DE:"Germany",        FR:"France",     NL:"Netherlands",
  SG:"Singapore",     AE:"UAE",            NZ:"New Zealand",IE:"Ireland",
  PK:"Pakistan",      NG:"Nigeria",        ZA:"South Africa",KE:"Kenya",
  BR:"Brazil",        MX:"Mexico",         JP:"Japan",      CN:"China",
  KR:"South Korea",   SE:"Sweden",         NO:"Norway",     DK:"Denmark",
  FI:"Finland",       CH:"Switzerland",    ES:"Spain",      IT:"Italy",
  PL:"Poland",        PT:"Portugal",       PH:"Philippines",MY:"Malaysia",
  TH:"Thailand",
};

function resolveCountryLabel(candidates) {
  const loc = candidates.map(c => c.location_display || c.location || c.city || "").find(Boolean);
  if (loc) {
    const parts = loc.split(",").map(s => s.trim());
    return parts[parts.length - 1] || loc;
  }
  return "Unknown";
}


/* =========================================================
   MATCHED CANDIDATE IDS
   Populated by fetching /matches for every job in the
   recruiter's organisation. Green = matched to at least
   one org job. Blue = unmatched.
========================================================= */
let _matchedCandidateIds = new Set();
let _recruiterOrg        = null;
let _orgJobs             = [];

async function loadMatchedCandidateIds() {
  try {
    // Fast path: already stored this session
    const cached = sessionStorage.getItem("bm_rec_matched_cand_ids");
    if (cached) {
      try { _matchedCandidateIds = new Set(JSON.parse(cached)); return; } catch { }
    }

    // Wait for apiFetch from api.js
    let attempts = 0;
    while (!window.apiFetch && attempts < 30) {
      await new Promise(r => setTimeout(r, 100));
      attempts++;
    }
    if (!window.apiFetch) return;

    // Wait for Firebase auth to resolve (auth.currentUser is null until
    // onAuthStateChanged fires, even when the user is already signed in)
    let recruiterUid = null;
    if (window.auth && window.db) {
      const user = await new Promise(resolve => {
        const unsub = window.auth.onAuthStateChanged(u => { unsub(); resolve(u); });
      });

      if (user) {
        const { getDoc, doc } = await import("https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js");
        const snap = await getDoc(doc(window.db, "users", user.uid));
        if (snap.exists()) {
          _recruiterOrg = snap.data().organisation_name || null;
          recruiterUid  = user.uid;
        }
      }
    }

    if (!_recruiterOrg) return;

    // 1. Fetch org jobs (same pattern as api.js fetchOrgJobs)
    const jobsRes  = await window.apiFetch(`/jobs?company=${encodeURIComponent(_recruiterOrg)}`);
    let   orgJobs  = jobsRes?.jobs || jobsRes?.matches || (Array.isArray(jobsRes) ? jobsRes : []);

    // Fallback: client-side filter
    if (!orgJobs.length) {
      const allRes = await window.apiFetch("/jobs");
      const all    = allRes?.jobs || (Array.isArray(allRes) ? allRes : []);
      const normOrg = (_recruiterOrg || "").toLowerCase().trim();
      orgJobs = all.filter(j => (j.company || "").toLowerCase().trim() === normOrg);
    }

    _orgJobs = orgJobs;

    if (!orgJobs.length) return;

    // 2. Fetch matches for each job (top_n=50 covers realistic pool sizes)
    const allMatchArrays = await Promise.all(
      orgJobs.map(async j => {
        try {
          const res = await window.apiFetch(`/matches?job_id=${j.job_id}&top_n=50&offset=0`);
          const matches = res?.matches || (Array.isArray(res) ? res : []);
          return matches.map(m => String(m.candidate_id));
        } catch { return []; }
      })
    );

    _matchedCandidateIds = new Set(allMatchArrays.flat());

    try {
      sessionStorage.setItem("bm_rec_matched_cand_ids", JSON.stringify([..._matchedCandidateIds]));
    } catch { }

  } catch (e) {
    console.warn("RecLocateHire: could not load matched candidate IDs", e);
  }
}

// Re-colour markers after match IDs load
function _refreshMarkerStyles() {
  if (!markersLayer) return;
  markersLayer.eachLayer(marker => {
    if (!marker._bmCandidates) return;
    const hasMatch = marker._bmCandidates.some(c => _matchedCandidateIds.has(String(c.candidate_id)));
    marker.setIcon(_dotIcon(hasMatch));
  });
  markersLayer.refreshClusters();
}


/* =========================================================
   FLOATING TOOLTIP
========================================================= */
let _tipEl = null;

function getTip() {
  if (_tipEl) return _tipEl;
  _tipEl = document.createElement("div");
  _tipEl.id = "bm-rec-map-tip";
  _tipEl.style.cssText = [
    "position:fixed","pointer-events:none","z-index:9999",
    "display:none","opacity:0",
    "transition:opacity 0.15s ease,transform 0.15s ease",
    "transform:translateY(8px)",
  ].join(";");
  document.body.appendChild(_tipEl);
  return _tipEl;
}

function _showTip(e, html) {
  const tip = getTip();
  tip.innerHTML     = html;
  tip.style.display = "block";
  requestAnimationFrame(() => {
    tip.style.opacity   = "1";
    tip.style.transform = "translateY(0)";
  });
  _moveTip(e);
}

function _moveTip(e) {
  const tip = getTip();
  const W = tip.offsetWidth, H = tip.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  let x = e.clientX + 18, y = e.clientY - H / 2;
  if (x + W > vw - 12) x = e.clientX - W - 14;
  if (y < 8) y = 8;
  if (y + H > vh - 8) y = vh - H - 8;
  tip.style.left = `${x}px`;
  tip.style.top  = `${y}px`;
}

function _hideTip() {
  const tip = getTip();
  tip.style.opacity   = "0";
  tip.style.transform = "translateY(8px)";
  setTimeout(() => { if (tip.style.opacity === "0") tip.style.display = "none"; }, 180);
}

document.addEventListener("mousemove", e => {
  if (_tipEl && _tipEl.style.display !== "none") _moveTip(e);
});


/* =========================================================
   TOOLTIP HTML BUILDER
========================================================= */
function _buildTipHTML(candidates) {
  const country    = resolveCountryLabel(candidates);
  const count      = candidates.length;
  const matchCount = candidates.filter(c => _matchedCandidateIds.has(String(c.candidate_id))).length;
  const hasMatch   = matchCount > 0;

  const accent      = hasMatch ? "#4ade80"               : "#7aa2ff";
  const accentDim   = hasMatch ? "rgba(74,222,128,0.1)"  : "rgba(122,162,255,0.1)";
  const accentLine  = hasMatch ? "rgba(74,222,128,0.18)" : "rgba(122,162,255,0.18)";
  const accentRoleB = hasMatch ? "rgba(74,222,128,0.1)"  : "rgba(122,162,255,0.1)";
  const accentRole  = hasMatch ? "rgba(74,222,128,0.05)" : "rgba(122,162,255,0.05)";
  const textCol     = hasMatch ? "#b9ffd4"               : "#c8d8ff";

  // Top 3 applied roles by frequency
  const roleFreq = {};
  candidates.forEach(c => {
    const r = c.applied_role || c.role || "Unknown";
    roleFreq[r] = (roleFreq[r] || 0) + 1;
  });
  const topRoles = Object.entries(roleFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  const rolesHTML = topRoles.map(([role, n]) => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:4px 8px;background:${accentRole};border:1px solid ${accentRoleB};border-radius:6px;">
      <span style="font-size:11.5px;font-weight:600;color:${textCol};">${role}</span>
      <span style="font-size:10px;color:${accent};font-weight:700;margin-left:8px;">${n}</span>
    </div>`).join("");

  const matchBadge = hasMatch ? `
    <div style="display:inline-flex;align-items:center;gap:4px;font-size:9.5px;font-weight:700;color:#4ade80;background:rgba(74,222,128,0.1);border:1px solid rgba(74,222,128,0.25);border-radius:5px;padding:2px 7px;margin-bottom:8px;letter-spacing:0.05em;text-transform:uppercase;">
      <svg width="8" height="8" viewBox="0 0 24 24" fill="#4ade80"><path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
      ${matchCount} org match${matchCount !== 1 ? "es" : ""}
    </div>` : "";

  return `
    <div style="background:#0b0e1a;border:1px solid ${accentLine};border-radius:12px;padding:12px 14px;width:220px;box-shadow:0 16px 48px rgba(0,0,0,0.7),inset 0 1px 0 rgba(122,162,255,0.08);font-family:'DM Sans',sans-serif;backdrop-filter:blur(12px);">
      <div style="display:flex;align-items:center;gap:7px;margin-bottom:10px;">
        <div style="width:24px;height:24px;border-radius:7px;background:${accentDim};border:1px solid ${accentLine};display:flex;align-items:center;justify-content:center;flex-shrink:0;">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="${accent}"><path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/></svg>
        </div>
        <div>
          <div style="font-size:13px;font-weight:700;color:#e2e8f0;letter-spacing:-0.01em;">${country}</div>
          <div style="font-size:10px;color:${accent};margin-top:1px;">${count} candidate${count !== 1 ? "s" : ""}</div>
        </div>
      </div>

      ${matchBadge}

      <div style="height:1px;background:${accentRoleB};margin-bottom:8px;"></div>

      <div style="font-size:9.5px;font-weight:700;color:#4a5580;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:6px;">Top Roles</div>
      <div style="display:flex;flex-direction:column;gap:4px;">${rolesHTML}</div>

      <div style="margin-top:9px;text-align:right;font-size:10px;color:#3a4568;letter-spacing:0.03em;">Click to explore →</div>
    </div>`;
}


/* =========================================================
   MAP INIT
========================================================= */
function initMap() {
  map = L.map("map").setView([20, 0], 2);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap"
  }).addTo(map);

  markersLayer = L.markerClusterGroup({
    maxClusterRadius: 40,
    iconCreateFunction(cluster) {
      const childMarkers = cluster.getAllChildMarkers();
      const totalCands   = childMarkers.reduce((sum, m) => sum + (m._bmCandidates?.length || 1), 0);
      const hasMatch     = childMarkers.some(m =>
        m._bmCandidates?.some(c => _matchedCandidateIds.has(String(c.candidate_id)))
      );

      return L.divIcon({
        html:      `<div class="cluster-icon${hasMatch ? " matched" : ""}">${totalCands}</div>`,
        className: "",
        iconSize:  L.point(36, 36)
      });
    }
  });

  markersLayer.on("clustermouseover", e => {
    const allCands = e.layer.getAllChildMarkers().flatMap(m => m._bmCandidates || []);
    _showTip(e.originalEvent || window.event, _buildTipHTML(allCands));
  });
  markersLayer.on("clustermousemove", e => _moveTip(e.originalEvent || window.event));
  markersLayer.on("clustermouseout",  ()  => _hideTip());

  markersLayer.addTo(map);
}


/* =========================================================
   MARKER HELPERS
========================================================= */
function _dotIcon(matched) {
  const bg = matched ? "#4ade80" : "#7aa2ff";
  const bd = matched ? "rgba(255,255,255,0.6)" : "rgba(255,255,255,0.5)";
  const sh = matched
    ? "0 0 0 3px rgba(74,222,128,0.25),0 2px 8px rgba(22,163,74,0.5)"
    : "0 0 0 3px rgba(122,162,255,0.2),0 2px 6px rgba(79,70,229,0.4)";
  return L.divIcon({
    html:       `<div style="width:14px;height:14px;border-radius:50%;background:${bg};border:2px solid ${bd};box-shadow:${sh};box-sizing:border-box;"></div>`,
    className:  "",
    iconSize:   [14, 14],
    iconAnchor: [7, 7],
    popupAnchor:[0, -10],
  });
}

function _makeMarker(loc) {
  const hasMatch = loc.candidates.some(c => _matchedCandidateIds.has(String(c.candidate_id)));
  const marker   = L.marker([loc.lat, loc.lng], { icon: _dotIcon(hasMatch) });
  marker._bmCandidates = loc.candidates;
  marker._bmTitle      = loc.title;
  marker.on("mouseover", e => _showTip(e.originalEvent || window.event, _buildTipHTML(loc.candidates)));
  marker.on("mousemove", e => _moveTip(e.originalEvent || window.event));
  marker.on("mouseout",  ()  => _hideTip());
  marker.on("click",     ()  => showCandidatesForLocation(loc.title, loc.candidates));
  return marker;
}


/* =========================================================
   LOAD CANDIDATES AND PLACE MARKERS
   Candidates with lat/lng placed immediately.
   Others geocoded via Nominatim (Photon fallback) with
   concurrency=3, 350ms stagger, localStorage caching.
========================================================= */
async function loadCandidatesAndMarkers() {
  let candidates = [];

  // ✅ 1. Fetch from Firestore (NO API → no 403)
  try {
    if (window.db) {
      const { collection, getDocs } = await import(
        "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js"
      );

      const snapshot = await getDocs(collection(window.db, "candidates"));

      candidates = snapshot.docs
        .map(doc => doc.data())
        .filter(c => c.is_latest !== false);

      console.log("🔥 Candidates loaded:", candidates.length);
    }
  } catch (err) {
    console.error("❌ Firestore fetch failed:", err);
  }

  // ❌ No data
  if (!candidates.length) {
    console.warn("No candidates found");
    return;
  }

  // ✅ 2. Start match loading in parallel
  const matchPromise = loadMatchedCandidateIds();

  // ✅ 3. Helper for location
  function getCandLocation(c) {
    return (
      c.location_display ||
      c.location ||
      (c.city && c.country ? `${c.city}, ${c.country}` : c.city || c.country || null)
    );
  }

  // ✅ 4. Group by location
  const locationMap = {};

  for (const cand of candidates) {

    // 🔥 FIX: fallback location (IMPORTANT)
    let locStr = getCandLocation(cand);
    if (!locStr) {
      locStr = "Bangalore, India";   // ✅ fallback
      cand.location_display = locStr;
    }

    // If lat/lng already exists → use directly
    if (cand.lat && cand.lng) {
      const key = `${cand.lat},${cand.lng}`;
      if (!locationMap[key]) {
        locationMap[key] = {
          lat: +cand.lat,
          lng: +cand.lng,
          title: cand.city || locStr,
          candidates: []
        };
      }
      locationMap[key].candidates.push(cand);
      continue;
    }

    // Otherwise group by location string
    const key = locStr.trim().toLowerCase();
    if (!locationMap[key]) {
      locationMap[key] = {
        locStr,
        title: locStr,
        candidates: [],
        needsGeocode: true
      };
    }
    locationMap[key].candidates.push(cand);
  }

  console.log("📍 Locations:", Object.keys(locationMap).length);

  // ✅ 5. Geocoding setup
  const geoCache = loadGeoCache();
  const toFetch = Object.values(locationMap).filter(loc => loc.needsGeocode);

  const cacheHits = toFetch.filter(loc => geoCache[loc.locStr.toLowerCase()]);
  const cacheMiss = toFetch.filter(loc => !geoCache[loc.locStr.toLowerCase()]);

  // Apply cached coords
  for (const loc of cacheHits) {
    const coords = geoCache[loc.locStr.toLowerCase()];
    loc.lat = coords.lat;
    loc.lng = coords.lng;
  }

  // ✅ 6. Add markers immediately (cached + direct)
  [...Object.values(locationMap).filter(l => !l.needsGeocode), ...cacheHits]
    .forEach(loc => {
      if (loc.lat && loc.lng) {
        _makeMarker(loc).addTo(markersLayer);
      }
    });

  // ✅ 7. Geocode remaining
  const CONCURRENCY = 3;
  const STAGGER_MS = 300;

  async function geocodeOne(loc, delay) {
    if (delay) await new Promise(r => setTimeout(r, delay));

    const coords = await nominatim(loc.locStr);
    geoCache[loc.locStr.toLowerCase()] = coords;

    if (coords) {
      loc.lat = coords.lat;
      loc.lng = coords.lng;
      _makeMarker(loc).addTo(markersLayer);
    }
  }

  for (let i = 0; i < cacheMiss.length; i += CONCURRENCY) {
    await Promise.all(
      cacheMiss.slice(i, i + CONCURRENCY)
        .map((loc, idx) => geocodeOne(loc, idx * STAGGER_MS))
    );
  }

  saveGeoCache(geoCache);

  // ✅ 8. Apply match highlighting
  await matchPromise;
  _refreshMarkerStyles();
}


/* =========================================================
   RIGHT PANEL — CANDIDATE LIST FOR A LOCATION
   Matched candidates (against org jobs) appear at the top
   with a green badge. Others follow below.
========================================================= */
function showCandidatesForLocation(title, candidates) {
  const panel   = document.getElementById("cityPanel");
  const grid    = document.getElementById("panelGrid");
  const heading = document.getElementById("panelTitle");
  const count   = document.getElementById("panelCount");

  panel.classList.remove("hidden");
  heading.textContent = title;

  const matched   = candidates.filter(c =>  _matchedCandidateIds.has(String(c.candidate_id)));
  const unmatched = candidates.filter(c => !_matchedCandidateIds.has(String(c.candidate_id)));
  const ordered   = [...matched, ...unmatched];

  if (count) {
    count.textContent = `${candidates.length} candidate${candidates.length === 1 ? "" : "s"}${matched.length ? ` · ${matched.length} org match${matched.length === 1 ? "" : "es"}` : ""}`;
  }

  grid.innerHTML = "";

  if (!candidates.length) {
    grid.innerHTML = `
      <div class="panel-placeholder">
        <div class="placeholder-icon">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
        </div>
        <h4>No candidates here</h4>
        <p>No candidates available for this location.</p>
      </div>`;
    return;
  }

  // Section headers only when both groups are present
  if (matched.length > 0 && unmatched.length > 0) {
    grid.innerHTML += `
      <div class="panel-section-divider panel-section-matched">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="#4ade80" style="vertical-align:-1px;margin-right:4px;">
          <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
        </svg>
        Org Matches
      </div>`;
  }

  ordered.forEach((cand, i) => {
    const isMatch   = _matchedCandidateIds.has(String(cand.candidate_id));
    const name      = cand.name || "Candidate";
    const email     = cand.email || "";
  // 🔥 Find matched job (best possible match)
let matchedJob = null;

if (isMatch && _orgJobs.length) {
  matchedJob = _orgJobs[0]; // simple mapping (since exact mapping not stored)
}

// ✅ Values
const companyName = _recruiterOrg || "Your Company";
const jobRole     = matchedJob?.title || matchedJob?.role || "Matched Role";

const location  = cand.location_display || cand.location || cand.city || "Location not specified";

// ✅ Replace badge
const matchBadge = isMatch ? `
  <div class="panel-match-badge">
    ${companyName}
  </div>` : "";

    const viewHref = `cand-matches.html`;

    grid.innerHTML += `
      <div class="panel-job-card${isMatch ? " panel-job-matched" : ""}" style="animation-delay:${i * 45}ms">
        ${matchBadge}
        <div class="panel-job-title">${name}</div>

<!-- 🔥 Show job role if matched -->
<div class="panel-job-company">
  ${isMatch ? jobRole : (cand.applied_role || cand.role || "Candidate")}
</div>
        <div class="panel-job-meta">
          <span class="panel-job-loc">
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>
            </svg>
            ${location}
          </span>
          ${email ? `<span class="panel-job-source" style="font-size:10px;color:#6b7fa8;margin-left:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:120px;">${email}</span>` : ""}
        </div>
        <a class="panel-apply-btn" href="${viewHref}" style="${isMatch ? "background:linear-gradient(135deg,rgba(74,222,128,0.18),rgba(74,222,128,0.08));border-color:rgba(74,222,128,0.35);color:#4ade80;" : ""}">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
          View Matches →
        </a>
      </div>`;
  });
}

window.closeCityPanel = function () {
  document.getElementById("cityPanel")?.classList.add("hidden");
  const grid = document.getElementById("panelGrid");
  if (grid) grid.innerHTML = "";
};


/* =========================================================
   BOOT
========================================================= */
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => { initMap(); loadCandidatesAndMarkers(); });
} else {
  initMap();
  loadCandidatesAndMarkers();
}