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
// Maps candidate_id → { match_percent, job_id, job_title, company }[]
let _candidateMatchMap   = {};
let _recruiterOrg        = null;
let _orgJobs             = [];

async function loadMatchedCandidateIds() {
  try {
    // Fast path: already stored this session
    const cached = sessionStorage.getItem("bm_rec_matched_cand_ids");
    if (cached) {
      try {
        _matchedCandidateIds = new Set(JSON.parse(cached));
        const cachedMap = sessionStorage.getItem("bm_rec_candidate_match_map");
        if (cachedMap) _candidateMatchMap = JSON.parse(cachedMap);
        // Validate cache has real pct data — if all are 0/null, bust the cache
        const vals = Object.values(_candidateMatchMap).flat();
        const hasRealData = vals.some(v => v.match_percent != null && v.match_percent > 0);
        // Also bust if company field is missing (older broken cache)
        const hasCompany = vals.some(v => v.company && v.company !== "");
        if (vals.length === 0 || (hasRealData && hasCompany)) return; // cache is good
        // else fall through to re-fetch
        sessionStorage.removeItem("bm_rec_matched_cand_ids");
        sessionStorage.removeItem("bm_rec_candidate_match_map");
        _candidateMatchMap = {};
        _matchedCandidateIds = new Set();
      } catch { }
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
          // match_percent may also come as score (0–1) or match_score — normalise all
          return matches.map(m => {
            let pct = m.match_percent ?? m.match_score ?? null;
            if (pct == null && m.score != null) pct = m.score * 100; // 0-1 → 0-100
            pct = pct != null ? Math.round(pct) : null; // null = unknown, not 0
            return {
              candidate_id: String(m.candidate_id),
              match_percent: pct,
              job_id:    j.job_id,
              job_title: j.title || j.role || "Open Role",
              company:   j.company || _recruiterOrg || ""
            };
          });
        } catch { return []; }
      })
    );

    // Build per-candidate map: keep best match per job, sorted desc by %
    _candidateMatchMap = {};
    for (const arr of allMatchArrays) {
      for (const m of arr) {
        // Store under BOTH the raw string and numeric string so Firestore doc-ID
        // lookups (which are strings like "42" or full UUIDs) always find a hit.
        const keys = new Set([String(m.candidate_id)]);
        const asNum = String(Number(m.candidate_id));
        if (asNum !== "NaN") keys.add(asNum);
        for (const key of keys) {
          if (!_candidateMatchMap[key]) _candidateMatchMap[key] = [];
          _candidateMatchMap[key].push(m);
        }
      }
    }
    // Sort each candidate's matches desc
    for (const id of Object.keys(_candidateMatchMap)) {
      _candidateMatchMap[id].sort((a, b) => b.match_percent - a.match_percent);
    }

    // Build the matched ID set from the map keys (already normalised above)
    _matchedCandidateIds = new Set(Object.keys(_candidateMatchMap));

    try {
      sessionStorage.setItem("bm_rec_matched_cand_ids", JSON.stringify([..._matchedCandidateIds]));
      sessionStorage.setItem("bm_rec_candidate_match_map", JSON.stringify(_candidateMatchMap));
    } catch { }

  } catch (e) {
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
   AUTO-ZOOM: if all markers fall within a single country,
   fit the map to those bounds automatically.
========================================================= */
function _autoZoomIfSingleCountry() {
  if (!markersLayer) return;

  const allMarkers = [];
  markersLayer.eachLayer(m => { if (m._bmCandidates) allMarkers.push(m); });

  if (!allMarkers.length) return;

  // Extract country from each marker's first candidate location
  function _extractCountry(marker) {
    const loc = marker._bmCandidates[0]?.location_display
              || marker._bmCandidates[0]?.location
              || marker._bmCandidates[0]?.city
              || "";
    const parts = loc.split(",").map(s => s.trim());
    return parts[parts.length - 1] || "";
  }

  const countries = new Set(allMarkers.map(_extractCountry).filter(Boolean));

  if (countries.size !== 1) return; // multiple or no country — skip

  // Fit map to marker bounds with padding
  const bounds = L.latLngBounds(allMarkers.map(m => m.getLatLng()));
  map.fitBounds(bounds, { padding: [60, 60], maxZoom: 8, animate: true });

  // After zoom, open the panel for that location automatically
  setTimeout(() => {
    const first = allMarkers[0];
    if (first) showCandidatesForLocation(first._bmTitle || [...countries][0], allMarkers.flatMap(m => m._bmCandidates));
  }, 600);
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
        .map(doc => {
          const data = doc.data();
          // Ensure candidate_id is always the Firestore document ID so it
          // aligns with the IDs returned by /matches from the backend.
          return { candidate_id: doc.id, ...data };
        })
        .filter(c => c.is_latest !== false);

    }
  } catch (err) {
  }

  // ❌ No data
  if (!candidates.length) {
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

  // ✅ 9. Auto-zoom if all candidates share one country
  _autoZoomIfSingleCountry();
}


/* =========================================================
   RIGHT PANEL — CANDIDATE LIST FOR A LOCATION
   Matched candidates (against org jobs) appear at the top,
   sorted by match_percent descending. Others follow below.
   Each card clearly separates:
     • Candidate name + their role (what they are)
     • Job title + company they matched to (what the org needs)
     • Match % ring
========================================================= */
function showCandidatesForLocation(title, candidates) {
  const panel   = document.getElementById("cityPanel");
  const grid    = document.getElementById("panelGrid");
  const heading = document.getElementById("panelTitle");
  const count   = document.getElementById("panelCount");

  panel.classList.remove("hidden");
  heading.textContent = title;

  // Enrich each candidate with their best match info.
  // Try both the raw candidate_id and numeric form since the backend /matches
  // API may return integer IDs while Firestore stores them as strings.
  const enriched = candidates.map(c => {
    const idStr  = String(c.candidate_id ?? "");
    const idNum  = String(Number(idStr));            // "42" → "42", "abc" → "NaN"
    // Look up match data — try string key first, then numeric, then name fallback
    const matches =
      _candidateMatchMap[idStr] ||
      (_candidateMatchMap[idNum] && idNum !== "NaN" ? _candidateMatchMap[idNum] : null) ||
      [];
    const isMatch =
      _matchedCandidateIds.has(idStr) ||
      (_matchedCandidateIds.has(idNum) && idNum !== "NaN");
    const best = matches[0] || null;
    return { ...c, _isMatch: isMatch, _best: best, _matches: matches };
  });

  // Sort: matched first sorted by match_percent desc, then unmatched alphabetically
  const matched   = enriched
    .filter(c => c._isMatch)
    .sort((a, b) => (b._best?.match_percent ?? -1) - (a._best?.match_percent ?? -1));
  const unmatched = enriched
    .filter(c => !c._isMatch)
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  const ordered   = [...matched, ...unmatched];

  if (count) {
    count.textContent = `${candidates.length} candidate${candidates.length === 1 ? "" : "s"}${matched.length ? ` · ${matched.length} org match${matched.length === 1 ? "" : "es"}` : ""}`;
  }

  // Build HTML in one shot (no innerHTML += in loop)
  let html = "";

  if (!candidates.length) {
    html = `
      <div class="panel-placeholder">
        <div class="placeholder-icon">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
        </div>
        <h4>No candidates here</h4>
        <p>No candidates available for this location.</p>
      </div>`;
    grid.innerHTML = html;
    return;
  }

  // ── Org Matches section header ──────────────────────────────
  if (matched.length > 0) {
    html += `
      <div class="panel-section-divider panel-section-matched" style="margin-top:0;border-top:none;padding-top:0;margin-bottom:8px;">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="#4ade80" style="vertical-align:-1px;margin-right:4px;">
          <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
        </svg>
        Org Matches
      </div>`;
  }

  ordered.forEach((cand, i) => {
    const isMatch = cand._isMatch;
    const best    = cand._best;

    // ── Section break between matched and unmatched ──────────
    if (i === matched.length && unmatched.length > 0 && matched.length > 0) {
      html += `
        <div class="panel-section-divider" style="margin-top:6px;margin-bottom:8px;">
          Other Candidates
        </div>`;
    }

    // ── Candidate identity ───────────────────────────────────
    const candName = cand.name || "Candidate";
    // What the candidate IS (their role from Firestore)
    const candRole = cand.applied_role || cand.role || "—";
    const location = cand.location_display || cand.location || cand.city || "Location not specified";

    // ── Match job details (what the ORG needs) ───────────────
    const jobTitle  = best?.job_title || "—";
    const company   = best?.company   || _recruiterOrg || "—";
    const pct       = best?.match_percent; // null = unknown

    // ── Match % ring ─────────────────────────────────────────
    let matchRingHTML = "";
    if (isMatch) {
      const hasPct      = pct != null;
      const displayPct  = hasPct ? pct : "?";
      const ringColor   = !hasPct ? "#6b7fa8" : pct >= 75 ? "#4ade80" : pct >= 50 ? "#fbbf24" : "#7aa2ff";
      const circumference = 2 * Math.PI * 15;
      const dash = hasPct ? ((pct / 100) * circumference).toFixed(1) : "0";
      const gap  = hasPct ? (circumference - +dash).toFixed(1)        : circumference.toFixed(1);
      matchRingHTML = `
        <div style="position:relative;width:48px;height:48px;flex-shrink:0;" title="${hasPct ? pct + "% match" : "Match % unavailable"}">
          <svg width="48" height="48" viewBox="0 0 48 48" style="transform:rotate(-90deg);">
            <circle cx="24" cy="24" r="15" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="3.5"/>
            <circle cx="24" cy="24" r="15" fill="none" stroke="${ringColor}" stroke-width="3.5"
              stroke-dasharray="${dash} ${gap}" stroke-linecap="round"/>
          </svg>
          <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:0;">
            <span style="font-size:${hasPct ? "11" : "10"}px;font-weight:800;color:${ringColor};line-height:1;">${displayPct}${hasPct ? "%" : ""}</span>
          </div>
        </div>`;
    }

    // ── Extra matched jobs (if candidate matches multiple roles) ─
    let extraPillsHTML = "";
    if (isMatch && (cand._matches || []).length > 1) {
      const pills = cand._matches.slice(1).map(m => {
        const c = m.match_percent >= 75 ? "#4ade80" : m.match_percent >= 50 ? "#fbbf24" : "#7aa2ff";
        const pStr = m.match_percent != null ? `${m.match_percent}%` : "?%";
        return `<span style="display:inline-flex;align-items:center;gap:3px;font-size:9px;padding:2px 7px;border-radius:4px;background:rgba(122,162,255,0.07);border:1px solid rgba(122,162,255,0.14);color:#8fa8cc;">
          ${m.job_title}<span style="color:${c};font-weight:700;margin-left:2px;">${pStr}</span>
        </span>`;
      }).join("");
      extraPillsHTML = `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:7px;">${pills}</div>`;
    }

    // ── Card ─────────────────────────────────────────────────
    html += `
      <div class="panel-job-card${isMatch ? " panel-job-matched" : ""}" style="animation-delay:${i * 40}ms;padding:12px 14px;">

        ${isMatch ? `
        <!-- ORG + JOB ROW (what org needs) -->
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:9px;">
          <div style="display:flex;align-items:center;gap:6px;min-width:0;flex:1;">
            <span style="display:inline-block;font-size:9px;font-weight:800;letter-spacing:0.06em;text-transform:uppercase;color:#4ade80;background:rgba(74,222,128,0.1);border:1px solid rgba(74,222,128,0.22);border-radius:4px;padding:1px 7px;flex-shrink:0;">${company}</span>
            <span style="font-size:11px;font-weight:600;color:#c8d8ff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${jobTitle}">↳ ${jobTitle}</span>
          </div>
        </div>` : ""}

        <!-- CANDIDATE ROW -->
        <div style="display:flex;align-items:center;gap:10px;">
          <!-- Avatar -->
          <div style="width:34px;height:34px;border-radius:9px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:#fff;background:${isMatch ? "linear-gradient(135deg,rgba(74,222,128,0.25),rgba(74,222,128,0.1))" : "linear-gradient(135deg,rgba(122,162,255,0.18),rgba(122,162,255,0.06))"};border:1px solid ${isMatch ? "rgba(74,222,128,0.2)" : "rgba(122,162,255,0.12)"};">
            ${candName.charAt(0).toUpperCase()}
          </div>
          <!-- Name + role -->
          <div style="flex:1;min-width:0;">
            <div style="font-size:13px;font-weight:700;color:#e2e8f0;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${candName}</div>
            <div style="font-size:11px;color:#6b7fa8;margin-top:2px;display:flex;align-items:center;gap:4px;">
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/></svg>
              <span>${candRole}</span>
            </div>
          </div>
          ${matchRingHTML}
        </div>

        ${extraPillsHTML}

        <!-- LOCATION -->
        <div style="display:flex;align-items:center;gap:4px;margin-top:9px;margin-bottom:10px;">
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#6b7fa8" stroke-width="2" style="flex-shrink:0;">
            <path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>
          </svg>
          <span style="font-size:10px;color:#6b7fa8;">${location}</span>
        </div>

        <!-- CTA -->
        <button class="panel-apply-btn"
          onclick="openCandidateProfileModal('${cand.candidate_id}','${candName.replace(/'/g,"\\'")}','${jobTitle.replace(/'/g,"\\'")}','${company.replace(/'/g,"\\'")}',${pct ?? "null"})"
          style="${isMatch ? "background:linear-gradient(135deg,rgba(74,222,128,0.15),rgba(74,222,128,0.06));border-color:rgba(74,222,128,0.3);color:#4ade80;" : ""}">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
          View Profile →
        </button>
      </div>`;
  });

  grid.innerHTML = html;
}

window.closeCityPanel = function () {
  document.getElementById("cityPanel")?.classList.add("hidden");
  const grid = document.getElementById("panelGrid");
  if (grid) grid.innerHTML = "";
};


/* =========================================================
   CANDIDATE PROFILE MODAL
   Opens an inline modal mirroring rec-actions profile view.
   Shows Firestore candidate data: name, role, resume snippet,
   email, location, match details, and links to Deep Analysis.
========================================================= */
(function _injectCandProfileModal() {
  if (document.getElementById("bmCandProfileOverlay")) return;

  // ── Styles ──
  const style = document.createElement("style");
  style.textContent = `
    #bmCandProfileOverlay {
      position: fixed; inset: 0; background: rgba(0,0,0,.82);
      backdrop-filter: blur(7px); z-index: 2000;
      display: none; align-items: center; justify-content: center;
      padding: 20px; box-sizing: border-box;
    }
    #bmCandProfileOverlay.open { display: flex; }
    #bmCandProfileModal {
      background: #0f1220; border: 1px solid rgba(122,162,255,.16);
      border-radius: 16px; width: 100%; max-width: 600px;
      max-height: 88vh; overflow-y: auto;
      padding: 30px 28px; box-sizing: border-box;
      position: relative; color: #e2e8f0; font-family: 'DM Sans', sans-serif;
      box-shadow: 0 24px 72px rgba(0,0,0,.7);
    }
    #bmCandProfileModal::-webkit-scrollbar { width: 4px; }
    #bmCandProfileModal::-webkit-scrollbar-thumb { background: rgba(122,162,255,.15); border-radius: 4px; }
    .bm-cpm-close {
      position: absolute; top: 16px; right: 18px;
      background: none; border: none; color: #4a5580;
      font-size: 20px; cursor: pointer; line-height: 1; transition: color .15s;
    }
    .bm-cpm-close:hover { color: #e2e8f0; }
    .bm-cpm-label {
      font-size: 10px; font-weight: 700; letter-spacing: 1px;
      text-transform: uppercase; color: #7aa2ff; margin-bottom: 5px; display: block;
    }
    .bm-cpm-field { margin-bottom: 14px; }
    .bm-cpm-field p { font-size: 13.5px; color: #c9d5e8; margin: 0; line-height: 1.5; }
    .bm-cpm-divider { height: 1px; background: rgba(122,162,255,.09); margin: 18px 0; }
    .bm-cpm-btn-row { display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px; flex-wrap: wrap; }
    .bm-cpm-btn {
      font-family: inherit; font-size: 13px; font-weight: 600;
      padding: 9px 18px; border-radius: 9px; cursor: pointer;
      border: 1px solid rgba(122,162,255,.22);
      background: transparent; color: #7aa2ff; transition: all .18s;
    }
    .bm-cpm-btn:hover { background: rgba(122,162,255,.1); }
    .bm-cpm-btn.primary {
      background: rgba(122,162,255,.14); border-color: rgba(122,162,255,.4);
    }
    .bm-cpm-btn.primary:hover { background: rgba(122,162,255,.22); }
    .bm-cpm-btn.green {
      color: #4ade80; border-color: rgba(74,222,128,.25);
      background: rgba(74,222,128,.08);
    }
    .bm-cpm-btn.green:hover { background: rgba(74,222,128,.16); }
    .bm-cpm-match-pills { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
    .bm-cpm-pill {
      display: inline-flex; align-items: center; gap: 5px;
      font-size: 11px; padding: 3px 10px; border-radius: 20px;
      background: rgba(122,162,255,.07); border: 1px solid rgba(122,162,255,.14);
      color: #8fa8cc;
    }
    .bm-cpm-pill .pct { font-weight: 700; }
    @keyframes bmCpmFadeIn { from { opacity:0; transform:translateY(10px) scale(.98); } to { opacity:1; transform:none; } }
    #bmCandProfileModal { animation: bmCpmFadeIn .22s ease both; }
  `;
  document.head.appendChild(style);

  // ── Overlay HTML ──
  const overlay = document.createElement("div");
  overlay.id = "bmCandProfileOverlay";
  overlay.innerHTML = `
    <div id="bmCandProfileModal">
      <button class="bm-cpm-close" id="bmCandProfileClose">✕</button>
      <span class="bm-cpm-label">Candidate Profile</span>
      <div id="bmCandProfileContent">
        <div style="display:flex;align-items:center;gap:10px;padding:24px 0;color:#6b7280;font-size:14px;">
          <div style="width:18px;height:18px;border-radius:50%;border:2px solid #7aa2ff;border-top-color:transparent;animation:recSpin .8s linear infinite;flex-shrink:0;"></div>
          Loading candidate…
        </div>
        <style>@keyframes recSpin{to{transform:rotate(360deg)}}</style>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.classList.remove("open"); });
  document.getElementById("bmCandProfileClose").addEventListener("click", () => overlay.classList.remove("open"));
})();

window.openCandidateProfileModal = async function(candidateId, nameHint, jobTitleHint, companyHint, matchPct) {
  const overlay = document.getElementById("bmCandProfileOverlay");
  const content = document.getElementById("bmCandProfileContent");
  if (!overlay || !content) return;

  // Reset + open
  content.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;padding:24px 0;color:#6b7280;font-size:14px;">
      <div style="width:18px;height:18px;border-radius:50%;border:2px solid #7aa2ff;border-top-color:transparent;animation:recSpin .8s linear infinite;flex-shrink:0;"></div>
      Loading candidate…
    </div>`;
  overlay.classList.add("open");

  // Fetch Firestore candidate doc
  let cand = {};
  try {
    const { getDoc, doc } = await import("https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js");
    const snap = await getDoc(doc(window.db, "candidates", String(candidateId)));
    if (snap.exists()) cand = snap.data();
  } catch (e) {
  }

  const name       = cand.name         || nameHint    || "Candidate";
  const role       = cand.applied_role || cand.role   || "—";
  const email      = cand.email        || "";
  const location   = cand.location_display || cand.location || cand.city || "Location not specified";
  const resumeText = cand.resume_text  || cand.resumeText || "";

  // Match pills from the in-memory map
  const idStr   = String(candidateId);
  const matches = _candidateMatchMap[idStr] || _candidateMatchMap[String(Number(idStr))] || [];
  const bestJob = matches[0] || null;
  const jobTitle  = bestJob?.job_title  || jobTitleHint || "—";
  const company   = bestJob?.company    || companyHint  || _recruiterOrg || "—";
  const pct       = bestJob?.match_percent ?? matchPct;

  const ringColor = pct == null ? "#6b7fa8" : pct >= 75 ? "#4ade80" : pct >= 50 ? "#fbbf24" : "#7aa2ff";
  const pctLabel  = pct != null ? `${pct}%` : "?%";

  const matchPillsHTML = matches.length ? `
    <div class="bm-cpm-match-pills">
      ${matches.map(m => {
        const c = m.match_percent >= 75 ? "#4ade80" : m.match_percent >= 50 ? "#fbbf24" : "#7aa2ff";
        return `<span class="bm-cpm-pill">
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2.5"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/></svg>
          ${m.job_title}
          <span class="pct" style="color:${c};">${m.match_percent != null ? m.match_percent + "%" : "?%"}</span>
        </span>`;
      }).join("")}
    </div>` : "";

  const resumeHTML = resumeText ? `
    <div class="bm-cpm-field">
      <span class="bm-cpm-label">Resume Snippet</span>
      <div style="background:#090e1c;border:1px solid rgba(122,162,255,.1);border-radius:10px;
                  padding:12px 14px;font-size:12px;color:#a0aec0;line-height:1.6;
                  max-height:130px;overflow-y:auto;">
        ${resumeText.slice(0, 700).replace(/</g,"&lt;").replace(/>/g,"&gt;")}${resumeText.length > 700 ? "…" : ""}
      </div>
    </div>` : "";

  content.innerHTML = `
    <!-- Header -->
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:18px;">
      <div>
        <h2 style="margin:0 0 3px;font-size:20px;color:#e2e8f0;">${name.replace(/</g,"&lt;")}</h2>
        <p style="margin:0;color:#6b7fa8;font-size:13px;display:flex;align-items:center;gap:5px;">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/></svg>
          ${role.replace(/</g,"&lt;")}
        </p>
      </div>
      ${pct != null ? `
      <div style="position:relative;width:54px;height:54px;flex-shrink:0;" title="${pct}% match">
        <svg width="54" height="54" viewBox="0 0 54 54" style="transform:rotate(-90deg);">
          <circle cx="27" cy="27" r="20" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="4"/>
          <circle cx="27" cy="27" r="20" fill="none" stroke="${ringColor}" stroke-width="4"
            stroke-dasharray="${((pct/100)*2*Math.PI*20).toFixed(1)} ${((1-pct/100)*2*Math.PI*20).toFixed(1)}"
            stroke-linecap="round"/>
        </svg>
        <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;">
          <span style="font-size:12px;font-weight:800;color:${ringColor};">${pctLabel}</span>
        </div>
      </div>` : ""}
    </div>

    <!-- Contact + Location -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px;">
      ${email ? `
      <div class="bm-cpm-field">
        <span class="bm-cpm-label">Email</span>
        <p><a href="mailto:${email}" style="color:#7aa2ff;text-decoration:none;">${email}</a></p>
      </div>` : ""}
      <div class="bm-cpm-field">
        <span class="bm-cpm-label">Location</span>
        <p>${location.replace(/</g,"&lt;")}</p>
      </div>
    </div>

    <!-- Org match details -->
    ${matches.length ? `
    <div class="bm-cpm-field">
      <span class="bm-cpm-label">Matched Org Roles</span>
      <div style="font-size:12px;color:#6b7fa8;margin-bottom:4px;">${company.replace(/</g,"&lt;")}</div>
      ${matchPillsHTML}
    </div>` : ""}

    <div class="bm-cpm-divider"></div>

    ${resumeHTML}

    <!-- Action buttons -->
    <div class="bm-cpm-btn-row">
      ${email ? `
      <button class="bm-cpm-btn" onclick="window.location.href='mailto:${email}?subject=Opportunity at ${encodeURIComponent(company)}'">
        ✉ Email
      </button>` : ""}
      <button class="bm-cpm-btn" onclick="
        window.location.href='rec-actions.html';
        sessionStorage.setItem('bm_open_candidate_id','${candidateId}');
      ">
        ⚡ Recruiter Actions
      </button>
      <button class="bm-cpm-btn primary"
        onclick="window.openCandidateAnalysis && window.openCandidateAnalysis('${candidateId}','${nameHint.replace(/'/g,"\\'")}','${bestJob?.job_id || ""}')">
        🔍 Deep Analysis
      </button>
    </div>
  `;
};



if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => { initMap(); loadCandidatesAndMarkers(); });
} else {
  initMap();
  loadCandidatesAndMarkers();
}