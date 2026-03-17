let map;
let markersLayer;

const CACHE_KEY = "bm_geocode_cache_v1";

function loadGeoCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || "{}"); } catch { return {}; }
}
function saveGeoCache(cache) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch {}
}

async function nominatim(locationStr) {
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(locationStr)}&format=json&limit=1`;
    const res  = await fetch(url, { headers: { "Accept-Language": "en" } });
    const data = await res.json();
    return data[0] ? { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) } : null;
  } catch { return null; }
}

/* ── Country name resolver ───────────────────────────────────────────────── */
const COUNTRY_CODES = {
  US:"United States", GB:"United Kingdom", AU:"Australia", IN:"India",
  CA:"Canada", DE:"Germany", FR:"France", NL:"Netherlands", SG:"Singapore",
  AE:"UAE", NZ:"New Zealand", IE:"Ireland", PK:"Pakistan", NG:"Nigeria",
  ZA:"South Africa", KE:"Kenya", BR:"Brazil", MX:"Mexico", JP:"Japan",
  CN:"China", KR:"South Korea", SE:"Sweden", NO:"Norway", DK:"Denmark",
  FI:"Finland", CH:"Switzerland", ES:"Spain", IT:"Italy", PL:"Poland",
  PT:"Portugal", PH:"Philippines", MY:"Malaysia", TH:"Thailand",
};

function resolveCountryLabel(jobs) {
  // Try country code first
  const countryCodes = jobs.map(j => (j.country || "").toUpperCase()).filter(Boolean);
  const freq = {};
  countryCodes.forEach(c => { freq[c] = (freq[c] || 0) + 1; });
  const topCode = Object.entries(freq).sort((a,b) => b[1]-a[1])[0]?.[0];
  if (topCode && COUNTRY_CODES[topCode]) return COUNTRY_CODES[topCode];
  if (topCode && topCode.length === 2) return topCode;
  // Fallback: try to strip state-like suffixes from location strings
  const locs = jobs.map(j => j.location_display || j.location || "").filter(Boolean);
  if (locs[0]) {
    const parts = locs[0].split(",").map(s => s.trim());
    return parts[parts.length - 1] || locs[0];
  }
  return "Unknown";
}

/* ── Tooltip ─────────────────────────────────────────────────────────────── */
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
  tip.innerHTML = html;
  tip.style.display = "block";
  requestAnimationFrame(() => {
    tip.style.opacity = "1";
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
  tip.style.left = x + "px";
  tip.style.top  = y + "px";
}

function _hideTip() {
  const tip = getTip();
  tip.style.opacity = "0";
  tip.style.transform = "translateY(8px)";
  setTimeout(() => { if (tip.style.opacity === "0") tip.style.display = "none"; }, 180);
}

document.addEventListener("mousemove", e => {
  if (_tipEl && _tipEl.style.display !== "none") _moveTip(e);
});

/* ── Build compact tooltip HTML ─────────────────────────────────────────── */
function _buildTipHTML(jobs) {
  const country = resolveCountryLabel(jobs);
  const count   = jobs.length;

  // Top roles by frequency
  const roleFreq = {};
  jobs.forEach(j => { if (j.title) roleFreq[j.title] = (roleFreq[j.title] || 0) + 1; });
  const topRoles = Object.entries(roleFreq)
    .sort((a,b) => b[1]-a[1])
    .slice(0, 3)
    .map(([role, n]) => ({ role, n }));

  // Avg salary
  const withSal = jobs.filter(j => j.salary_min || j.salary_max);
  const avgSal  = withSal.length
    ? Math.round(withSal.reduce((s,j) => s + (j.salary_max || j.salary_min || 0), 0) / withSal.length)
    : null;

  const s = (v) => `style="${v}"`;  // shorthand

  const rolesHTML = topRoles.map(({role, n}) => `
    <div ${s("display:flex;justify-content:space-between;align-items:center;padding:4px 8px;background:rgba(122,162,255,0.05);border:1px solid rgba(122,162,255,0.1);border-radius:6px;")}>
      <span ${s("font-size:11.5px;font-weight:600;color:#c8d8ff;")}>${role}</span>
      <span ${s("font-size:10px;color:#7aa2ff;font-weight:700;margin-left:8px;")}>${n}</span>
    </div>`).join("");

  const salHTML = avgSal
    ? `<div ${s("margin-top:8px;padding:4px 8px;background:rgba(74,222,128,0.06);border:1px solid rgba(74,222,128,0.15);border-radius:6px;display:flex;justify-content:space-between;align-items:center;")}>
        <span ${s("font-size:10.5px;color:#6b7fa8;")}>Avg. salary</span>
        <span ${s("font-size:11.5px;font-weight:700;color:#4ade80;")}>~$${avgSal.toLocaleString()}</span>
       </div>`
    : "";

  return `
    <div ${s([
      "background:#0b0e1a",
      "border:1px solid rgba(122,162,255,0.18)",
      "border-radius:12px",
      "padding:12px 14px",
      "width:210px",
      "box-shadow:0 16px 48px rgba(0,0,0,0.7),0 0 0 1px rgba(122,162,255,0.05),inset 0 1px 0 rgba(122,162,255,0.08)",
      "font-family:'DM Sans',sans-serif",
      "backdrop-filter:blur(12px)",
    ].join(";"))}>

      <!-- header -->
      <div ${s("display:flex;align-items:center;gap:7px;margin-bottom:10px;")}>
        <div ${s("width:24px;height:24px;border-radius:7px;background:rgba(122,162,255,0.1);border:1px solid rgba(122,162,255,0.2);display:flex;align-items:center;justify-content:center;flex-shrink:0;")}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="#7aa2ff"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>
        </div>
        <div>
          <div ${s("font-size:13px;font-weight:700;color:#e2e8f0;letter-spacing:-0.01em;")}>${country}</div>
          <div ${s("font-size:10px;color:#7aa2ff;margin-top:1px;")}>${count} open position${count !== 1 ? "s" : ""}</div>
        </div>
      </div>

      <!-- divider -->
      <div ${s("height:1px;background:rgba(122,162,255,0.08);margin-bottom:8px;")}></div>

      <!-- top roles -->
      <div ${s("font-size:9.5px;font-weight:700;color:#4a5580;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:6px;")}>Top Roles</div>
      <div ${s("display:flex;flex-direction:column;gap:4px;")}>${rolesHTML}</div>

      ${salHTML}

      <!-- cta -->
      <div ${s("margin-top:9px;text-align:right;font-size:10px;color:#3a4568;letter-spacing:0.03em;")}>Click to explore →</div>
    </div>`;
}

/* ── Map init ────────────────────────────────────────────────────────────── */
function initMap() {
  map = L.map("map").setView([20, 0], 2);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap"
  }).addTo(map);

  markersLayer = L.markerClusterGroup({
    maxClusterRadius: 40,
    iconCreateFunction(cluster) {
      // Sum _bmJobs across all child markers — same source as tooltip count
      const totalJobs = cluster.getAllChildMarkers()
        .reduce((sum, m) => sum + (m._bmJobs?.length || 1), 0);
      return L.divIcon({
        html: `<div class="cluster-icon">${totalJobs}</div>`,
        className: "",
        iconSize: L.point(36, 36)
      });
    }
  });

  /* Cluster hover */
  markersLayer.on("clustermouseover", e => {
    const allJobs = e.layer.getAllChildMarkers().flatMap(m => m._bmJobs || []);
    _showTip(e.originalEvent || window.event, _buildTipHTML(allJobs));
  });
  markersLayer.on("clustermousemove", e => _moveTip(e.originalEvent || window.event));
  markersLayer.on("clustermouseout",  ()  => _hideTip());

  markersLayer.addTo(map);
}

/* ── Place markers helper ────────────────────────────────────────────────── */
function _makeMarker(loc) {
  const marker = L.marker([loc.lat, loc.lng]);
  marker._bmJobs  = loc.jobs;
  marker._bmTitle = loc.title;
  marker.on("mouseover", e => _showTip(e.originalEvent || window.event, _buildTipHTML(loc.jobs)));
  marker.on("mousemove", e => _moveTip(e.originalEvent || window.event));
  marker.on("mouseout",  ()  => _hideTip());
  marker.on("click", () => showJobsForLocation(loc.title, loc.jobs));
  return marker;
}

async function loadJobsAndMarkers() {
  let attempts = 0;
  while (!window.apiFetch && attempts < 50) {
    await new Promise(r => setTimeout(r, 100));
    attempts++;
  }
  if (!window.apiFetch) return;

  const res = await window.apiFetch("/jobs");
  let jobs = [];
  if (Array.isArray(res))            jobs = res;
  else if (Array.isArray(res?.jobs)) jobs = res.jobs;
  else if (res?.body) {
    try { const p = JSON.parse(res.body); jobs = Array.isArray(p) ? p : (p.jobs || []); } catch {}
  }
  if (!jobs.length) return;

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

  for (const loc of cacheHits) {
    const coords = geoCache[loc.locStr.toLowerCase()];
    if (coords) { loc.lat = coords.lat; loc.lng = coords.lng; }
  }

  // Render already-resolved markers
  [
    ...Object.values(locationMap).filter(l => !l.needsGeocode),
    ...cacheHits.filter(l => l.lat && l.lng)
  ].forEach(loc => _makeMarker(loc).addTo(markersLayer));

  // Geocode unknowns progressively
  let cacheUpdated = false;
  for (let i = 0; i < cacheMiss.length; i++) {
    const loc    = cacheMiss[i];
    const key    = loc.locStr.toLowerCase();
    const coords = await nominatim(loc.locStr);
    geoCache[key] = coords;
    cacheUpdated  = true;
    if (coords) {
      loc.lat = coords.lat;
      loc.lng = coords.lng;
      _makeMarker(loc).addTo(markersLayer);
    }
    if (i < cacheMiss.length - 1) await new Promise(r => setTimeout(r, 1100));
  }
  if (cacheUpdated) saveGeoCache(geoCache);
}

/* ── Right panel ─────────────────────────────────────────────────────────── */
function showJobsForLocation(title, jobs) {
  const panel   = document.getElementById("cityPanel");
  const grid    = document.getElementById("panelGrid");
  const heading = document.getElementById("panelTitle");
  const count   = document.getElementById("panelCount");

  panel.classList.remove("hidden");
  heading.textContent = title;
  if (count) count.textContent = `${jobs.length} job${jobs.length === 1 ? '' : 's'} available`;

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

  jobs.forEach((job, i) => {
    const location = job.location_display || job.location || job.city || "Location not specified";
    const hasApply = job.apply_url && job.apply_url !== '#';
    grid.innerHTML += `
      <div class="panel-job-card" style="animation-delay:${i * 45}ms">
        <div class="panel-job-title">${job.title || "Job Role"}</div>
        <div class="panel-job-company">${job.company || "Company not available"}</div>
        <div class="panel-job-meta">
          <span class="panel-job-loc">
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>
            </svg>
            ${location}
          </span>
          ${job.source ? `<span class="panel-job-source">${job.source}</span>` : ''}
        </div>
        ${hasApply
          ? `<a class="panel-apply-btn" href="${job.apply_url}" target="_blank" rel="noopener noreferrer">
               <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                 <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                 <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
               </svg>
               Apply Now
             </a>`
          : ''}
      </div>`;
  });
}

window.closeCityPanel = function () {
  document.getElementById("cityPanel")?.classList.add("hidden");
  const grid = document.getElementById("panelGrid");
  if (grid) grid.innerHTML = "";
};

// Boot
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => { initMap(); loadJobsAndMarkers(); });
} else {
  initMap();
  loadJobsAndMarkers();
}