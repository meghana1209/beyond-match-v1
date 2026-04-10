/* =========================================================
   LOCATEHIRE — Interactive Job Map
   Shows all available jobs as clustered map markers.
   Green markers = jobs matching the current candidate's resume.
   Blue  markers = other open roles.
   Clicking a marker opens a right-side panel with job cards.
========================================================= */

let map;
let markersLayer;

const GEOCACHE_KEY = "bm_geocode_cache_v1";

function loadGeoCache() {
  try { return JSON.parse(localStorage.getItem(GEOCACHE_KEY) || "{}"); } catch { return {}; }
}
function saveGeoCache(cache) {
  try { localStorage.setItem(GEOCACHE_KEY, JSON.stringify(cache)); } catch { }
}

/* =========================================================
   GEOCODING
   Tries Nominatim first; falls back to the Photon API
   (also OSM-backed, but CORS-permissive for localhost dev).
========================================================= */
async function nominatim(locationStr) {
  // Primary: Nominatim
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(locationStr)}&format=json&limit=1`;
    const res = await fetch(url, {
      headers: {
        "Accept-Language": "en",
        // Nominatim requires a real User-Agent; the browser supplies one automatically,
        // but an explicit Referer helps avoid rate-limit blocks.
        "Referer": window.location.origin
      }
    });
    if (res.ok) {
      const data = await res.json();
      if (data[0]) return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
    }
  } catch { /* fall through to backup */ }

  // Fallback: Photon (CORS-open, OSM-backed)
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

function resolveCountryLabel(jobs) {
  const freq = {};
  jobs.forEach(j => {
    const c = (j.country || "").toUpperCase();
    if (c) freq[c] = (freq[c] || 0) + 1;
  });
  const topCode = Object.entries(freq).sort((a, b) => b[1] - a[1])[0]?.[0];
  if (topCode && COUNTRY_CODES[topCode]) return COUNTRY_CODES[topCode];
  if (topCode?.length === 2) return topCode;

  const loc = jobs.map(j => j.location_display || j.location || "").find(Boolean);
  if (loc) {
    const parts = loc.split(",").map(s => s.trim());
    return parts[parts.length - 1] || loc;
  }
  return "Unknown";
}


/* =========================================================
   MATCHED JOB IDS
   Set is populated from sessionStorage (written by candidate.js
   on the Job Matches page) or by a fresh API call as fallback.

   FIX: use onAuthStateChanged to wait for Firebase auth to
   resolve before reading currentUser — it starts as null even
   when the user is already signed in.
========================================================= */
let _matchedJobIds = new Set();

async function loadMatchedJobIds() {
  try {
    // Fast path: Job Matches page already stored the IDs this session
    const cached = sessionStorage.getItem("bm_matched_job_ids");
    if (cached) {
      try { _matchedJobIds = new Set(JSON.parse(cached)); return; } catch { }
    }

    // Wait for apiFetch to be registered by api.js (it loads in parallel)
    let attempts = 0;
    while (!window.apiFetch && attempts < 30) {
      await new Promise(r => setTimeout(r, 100));
      attempts++;
    }
    if (!window.apiFetch) return;

    // Wait for Firebase Auth to resolve the current user.
    // auth.currentUser is NULL until the first onAuthStateChanged callback fires,
    // even if the user is already signed in — this was the root cause of all
    // markers staying blue.
    let candidateId = null;
    if (window.auth && window.db) {
      const user = await new Promise(resolve => {
        const unsub = window.auth.onAuthStateChanged(u => { unsub(); resolve(u); });
      });

      if (user) {
        const { getDoc, doc } = await import("https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js");
        const snap = await getDoc(doc(window.db, "users", user.uid));
        if (snap.exists()) {
          candidateId = snap.data().latest_candidate_id || snap.data().candidate_id || null;
        }
      }
    }

    if (!candidateId) return;

    // top_n=50 must match the value used in jobmatches.html so both pages agree
    const res  = await window.apiFetch(`/matches?candidate_id=${candidateId}&top_n=50&offset=0`);
    let   data = typeof res?.body === "string" ? JSON.parse(res.body) : res;
    const matches = Array.isArray(data) ? data : (data?.matches || []);
    _matchedJobIds = new Set(matches.map(m => String(m.job_id)));

    try { sessionStorage.setItem("bm_matched_job_ids", JSON.stringify([..._matchedJobIds])); } catch { }
  } catch (e) {
    console.warn("LocateHire: could not load matched job IDs", e);
  }
}

// Re-colour all existing markers after match IDs are loaded
function _refreshMarkerStyles() {
  if (!markersLayer) return;
  markersLayer.eachLayer(marker => {
    if (!marker._bmJobs) return;
    const hasMatch = marker._bmJobs.some(j => _matchedJobIds.has(String(j.job_id)));
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
  _tipEl.id = "bm-map-tip";
  _tipEl.style.cssText = [
    "position:fixed", "pointer-events:none", "z-index:9999",
    "display:none", "opacity:0",
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
function _buildTipHTML(jobs) {
  const country    = resolveCountryLabel(jobs);
  const count      = jobs.length;
  const matchCount = jobs.filter(j => _matchedJobIds.has(String(j.job_id))).length;
  const hasMatch   = matchCount > 0;

  // Accent palette switches to green when there are resume matches
  const accent      = hasMatch ? "#4ade80"              : "#7aa2ff";
  const accentDim   = hasMatch ? "rgba(74,222,128,0.1)" : "rgba(122,162,255,0.1)";
  const accentLine  = hasMatch ? "rgba(74,222,128,0.18)": "rgba(122,162,255,0.18)";
  const accentRoleB = hasMatch ? "rgba(74,222,128,0.1)" : "rgba(122,162,255,0.1)";
  const accentRole  = hasMatch ? "rgba(74,222,128,0.05)": "rgba(122,162,255,0.05)";
  const textCol     = hasMatch ? "#b9ffd4"              : "#c8d8ff";

  // Top 3 roles by frequency
  const roleFreq = {};
  jobs.forEach(j => { if (j.title) roleFreq[j.title] = (roleFreq[j.title] || 0) + 1; });
  const topRoles = Object.entries(roleFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  const rolesHTML = topRoles.map(([role, n]) => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:4px 8px;background:${accentRole};border:1px solid ${accentRoleB};border-radius:6px;">
      <span style="font-size:11.5px;font-weight:600;color:${textCol};">${role}</span>
      <span style="font-size:10px;color:${accent};font-weight:700;margin-left:8px;">${n}</span>
    </div>`).join("");

  const withSal = jobs.filter(j => j.salary_min || j.salary_max);
  const avgSal  = withSal.length
    ? Math.round(withSal.reduce((s, j) => s + (j.salary_max || j.salary_min || 0), 0) / withSal.length)
    : null;

  const salHTML = avgSal ? `
    <div style="margin-top:8px;padding:4px 8px;background:rgba(74,222,128,0.06);border:1px solid rgba(74,222,128,0.15);border-radius:6px;display:flex;justify-content:space-between;align-items:center;">
      <span style="font-size:10.5px;color:#6b7fa8;">Avg. salary</span>
      <span style="font-size:11.5px;font-weight:700;color:#4ade80;">~$${avgSal.toLocaleString()}</span>
    </div>` : "";

  const matchBadge = hasMatch ? `
    <div style="display:inline-flex;align-items:center;gap:4px;font-size:9.5px;font-weight:700;color:#4ade80;background:rgba(74,222,128,0.1);border:1px solid rgba(74,222,128,0.25);border-radius:5px;padding:2px 7px;margin-bottom:8px;letter-spacing:0.05em;text-transform:uppercase;">
      <svg width="8" height="8" viewBox="0 0 24 24" fill="#4ade80"><path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
      ${matchCount} resume match${matchCount !== 1 ? "es" : ""}
    </div>` : "";

  return `
    <div style="background:#0b0e1a;border:1px solid ${accentLine};border-radius:12px;padding:12px 14px;width:220px;box-shadow:0 16px 48px rgba(0,0,0,0.7),inset 0 1px 0 rgba(122,162,255,0.08);font-family:'DM Sans',sans-serif;backdrop-filter:blur(12px);">
      <div style="display:flex;align-items:center;gap:7px;margin-bottom:10px;">
        <div style="width:24px;height:24px;border-radius:7px;background:${accentDim};border:1px solid ${accentLine};display:flex;align-items:center;justify-content:center;flex-shrink:0;">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="${accent}"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>
        </div>
        <div>
          <div style="font-size:13px;font-weight:700;color:#e2e8f0;letter-spacing:-0.01em;">${country}</div>
          <div style="font-size:10px;color:${accent};margin-top:1px;">${count} open position${count !== 1 ? "s" : ""}</div>
        </div>
      </div>

      ${matchBadge}

      <div style="height:1px;background:${accentRoleB};margin-bottom:8px;"></div>

      <div style="font-size:9.5px;font-weight:700;color:#4a5580;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:6px;">Top Roles</div>
      <div style="display:flex;flex-direction:column;gap:4px;">${rolesHTML}</div>

      ${salHTML}

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
      const totalJobs    = childMarkers.reduce((sum, m) => sum + (m._bmJobs?.length || 1), 0);
      const hasMatch     = childMarkers.some(m => m._bmJobs?.some(j => _matchedJobIds.has(String(j.job_id))));

      return L.divIcon({
        html:      `<div class="cluster-icon${hasMatch ? " matched" : ""}">${totalJobs}</div>`,
        className: "",
        iconSize:  L.point(36, 36)
      });
    }
  });

  markersLayer.on("clustermouseover", e => {
    const allJobs = e.layer.getAllChildMarkers().flatMap(m => m._bmJobs || []);
    _showTip(e.originalEvent || window.event, _buildTipHTML(allJobs));
  });
  markersLayer.on("clustermousemove", e => _moveTip(e.originalEvent || window.event));
  markersLayer.on("clustermouseout",  ()  => _hideTip());

  markersLayer.addTo(map);
}


/* =========================================================
   MARKER HELPERS
========================================================= */
function _dotIcon(matched) {
  const bg = matched ? "#4ade80"                                         : "#7aa2ff";
  const bd = matched ? "rgba(255,255,255,0.6)"                           : "rgba(255,255,255,0.5)";
  const sh = matched ? "0 0 0 3px rgba(74,222,128,0.25),0 2px 8px rgba(22,163,74,0.5)"
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
  const hasMatch = loc.jobs.some(j => _matchedJobIds.has(String(j.job_id)));
  const marker   = L.marker([loc.lat, loc.lng], { icon: _dotIcon(hasMatch) });
  marker._bmJobs  = loc.jobs;
  marker._bmTitle = loc.title;
  marker.on("mouseover", e => _showTip(e.originalEvent || window.event, _buildTipHTML(loc.jobs)));
  marker.on("mousemove", e => _moveTip(e.originalEvent || window.event));
  marker.on("mouseout",  ()  => _hideTip());
  marker.on("click",     ()  => showJobsForLocation(loc.title, loc.jobs));
  return marker;
}


/* =========================================================
   LOAD JOBS AND PLACE MARKERS
   Jobs with lat/lng are placed immediately.
   Jobs with only location strings are geocoded via Nominatim
   (with Photon as CORS fallback) using a concurrency limit of
   3 and local localStorage caching.
========================================================= */
async function loadJobsAndMarkers() {
  // Wait for apiFetch (loaded by api.js which may init after this module)
  let attempts = 0;
  while (!window.apiFetch && attempts < 50) {
    await new Promise(r => setTimeout(r, 100));
    attempts++;
  }
  if (!window.apiFetch) return;

  // Kick off match loading in parallel — don't block marker rendering on it
  const matchPromise = loadMatchedJobIds();

  const res = await window.apiFetch("/jobs");
  let jobs  = [];
  if      (Array.isArray(res))        jobs = res;
  else if (Array.isArray(res?.jobs))  jobs = res.jobs;
  else if (res?.body) {
    try { const p = JSON.parse(res.body); jobs = Array.isArray(p) ? p : (p.jobs || []); } catch { }
  }
  if (!jobs.length) return;

  // Group jobs by geographic location key
  const locationMap = {};
  for (const job of jobs) {
    if (job.lat && job.lng) {
      const k = `${job.lat},${job.lng}`;
      if (!locationMap[k]) locationMap[k] = { lat: +job.lat, lng: +job.lng, title: job.city || job.location_display || "Jobs", jobs: [] };
      locationMap[k].jobs.push(job);
      continue;
    }
    const locStr = job.location_display || job.location ||
      (job.city && job.country ? `${job.city}, ${job.country}` : job.city || job.country || null);
    if (!locStr) continue;
    const k = locStr.trim().toLowerCase();
    if (!locationMap[k]) locationMap[k] = { locStr, title: locStr, jobs: [], needsGeocode: true };
    locationMap[k].jobs.push(job);
  }

  const geoCache  = loadGeoCache();
  const toFetch   = Object.values(locationMap).filter(loc => loc.needsGeocode);
  const cacheHits = toFetch.filter(loc => geoCache[loc.locStr.toLowerCase()] !== undefined);
  const cacheMiss = toFetch.filter(loc => geoCache[loc.locStr.toLowerCase()] === undefined);

  // Apply cached coordinates
  for (const loc of cacheHits) {
    const coords = geoCache[loc.locStr.toLowerCase()];
    if (coords) { loc.lat = coords.lat; loc.lng = coords.lng; }
  }

  // Place all already-resolved markers immediately
  [...Object.values(locationMap).filter(l => !l.needsGeocode), ...cacheHits.filter(l => l.lat && l.lng)]
    .forEach(loc => _makeMarker(loc).addTo(markersLayer));

  // Geocode cache misses with concurrency of 3 and 350ms stagger per batch
  const CONCURRENCY = 3;
  const STAGGER_MS  = 350;
  let cacheUpdated  = false;

  async function geocodeOne(loc, delayMs) {
    if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
    const key    = loc.locStr.toLowerCase();
    const coords = await nominatim(loc.locStr);
    geoCache[key] = coords;
    cacheUpdated  = true;
    if (coords) {
      loc.lat = coords.lat;
      loc.lng = coords.lng;
      _makeMarker(loc).addTo(markersLayer);
    }
  }

  for (let i = 0; i < cacheMiss.length; i += CONCURRENCY) {
    await Promise.all(cacheMiss.slice(i, i + CONCURRENCY).map((loc, bi) => geocodeOne(loc, bi * STAGGER_MS)));
    if (i + CONCURRENCY < cacheMiss.length) await new Promise(r => setTimeout(r, 1000));
  }

  if (cacheUpdated) saveGeoCache(geoCache);

  // Once matches are known, recolour any markers that should be green
  await matchPromise;
  _refreshMarkerStyles();
}


/* =========================================================
   RIGHT PANEL — JOB LIST FOR A LOCATION
   Matched jobs appear at the top with a green badge.
========================================================= */
function showJobsForLocation(title, jobs) {
  const panel   = document.getElementById("cityPanel");
  const grid    = document.getElementById("panelGrid");
  const heading = document.getElementById("panelTitle");
  const count   = document.getElementById("panelCount");

  panel.classList.remove("hidden");
  heading.textContent = title;

  const matched   = jobs.filter(j =>  _matchedJobIds.has(String(j.job_id)));
  const unmatched = jobs.filter(j => !_matchedJobIds.has(String(j.job_id)));
  const ordered   = [...matched, ...unmatched];

  if (count) {
    count.textContent = `${jobs.length} job${jobs.length === 1 ? "" : "s"} available${matched.length ? ` · ${matched.length} matched` : ""}`;
  }

  grid.innerHTML = "";

  if (!jobs.length) {
    grid.innerHTML = `
      <div class="panel-placeholder">
        <div class="placeholder-icon">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
        </div>
        <h4>No jobs here</h4>
        <p>No openings available for this location right now.</p>
      </div>`;
    return;
  }

  // Section header for matched group (only when both groups are present)
  if (matched.length > 0 && unmatched.length > 0) {
    grid.innerHTML += `
      <div class="panel-section-divider panel-section-matched">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="#4ade80" style="vertical-align:-1px;margin-right:4px;">
          <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
        </svg>
        Resume Matches
      </div>`;
  }

  ordered.forEach((job, i) => {
    const isMatch  = _matchedJobIds.has(String(job.job_id));
    const location = job.location_display || job.location || job.city || "Location not specified";
    const hasApply = job.apply_url && job.apply_url !== "#";

    if (!isMatch && matched.length > 0 && i === matched.length) {
      grid.innerHTML += `<div class="panel-section-divider" style="margin-top:6px;">Other Jobs</div>`;
    }

    const matchBadge = isMatch ? `
      <div class="panel-match-badge">
        <svg width="9" height="9" viewBox="0 0 24 24" fill="#4ade80"><path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
        Resume Match
      </div>` : "";

    grid.innerHTML += `
      <div class="panel-job-card${isMatch ? " panel-job-matched" : ""}" style="animation-delay:${i * 45}ms">
        ${matchBadge}
        <div class="panel-job-title">${job.title || "Job Role"}</div>
        <div class="panel-job-company">${job.company || "Company not available"}</div>
        <div class="panel-job-meta">
          <span class="panel-job-loc">
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>
            </svg>
            ${location}
          </span>
          ${job.source ? `<span class="panel-job-source">${job.source}</span>` : ""}
        </div>
        ${hasApply ? `
          <a class="panel-apply-btn" href="${job.apply_url}" target="_blank" rel="noopener noreferrer">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
              <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
            </svg>
            Apply Now
          </a>` : ""}
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
  document.addEventListener("DOMContentLoaded", () => { initMap(); loadJobsAndMarkers(); });
} else {
  initMap();
  loadJobsAndMarkers();
}