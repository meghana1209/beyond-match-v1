/**
 * BeyondMatch — LLM Integration Test Suite
 * Tests all 3 LLM use cases against the real proxy endpoint.
 *
 * Run with: node test-llm.js
 * Requires: node-fetch (npm install node-fetch)
 */

const LLM_ENDPOINT = "https://2bcj60lax1.execute-api.eu-north-1.amazonaws.com/prod/llm";

// ─── Colour helpers (no deps) ─────────────────────────────────────────────────
const C = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  green:  "\x1b[32m",
  red:    "\x1b[31m",
  yellow: "\x1b[33m",
  blue:   "\x1b[34m",
  cyan:   "\x1b[36m",
  gray:   "\x1b[90m",
};
const g  = s => `${C.green}${s}${C.reset}`;
const r  = s => `${C.red}${s}${C.reset}`;
const y  = s => `${C.yellow}${s}${C.reset}`;
const b  = s => `${C.blue}${s}${C.reset}`;
const gr = s => `${C.gray}${s}${C.reset}`;
const h  = s => `${C.bold}${C.cyan}${s}${C.reset}`;

// ─── callGemini (mirrors gemini.js) ──────────────────────────────────────────
async function callGemini(prompt) {
  const fetch = (await import("node-fetch")).default;
  const start = Date.now();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(LLM_ENDPOINT, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ prompt }),
        signal:  AbortSignal.timeout(30000),
      });
      const elapsed = Date.now() - start;
      if (res.ok) {
        const data = await res.json();
        return { raw: data?.result || "", elapsed, error: null };
      }
      if (attempt === 0) await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      if (attempt === 1) return { raw: "", elapsed: Date.now() - start, error: err.message };
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  return { raw: "", elapsed: Date.now() - start, error: "Failed after retry" };
}

// ─── Results tracker ──────────────────────────────────────────────────────────
const results = [];

function record(useCase, testName, status, details) {
  results.push({ useCase, testName, status, details });
  const icon = status === "PASS" ? g("✓ PASS") : status === "WARN" ? y("⚠ WARN") : r("✗ FAIL");
  console.log(`  ${icon}  ${testName}`);
  if (details.note) console.log(`         ${gr(details.note)}`);
}

// ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ──
//  USE CASE 1 — Job Match Enrichment (candidate side)
//  Mirrors: enrichMatchesWithLLM() in candidate.js
// ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ──

const TEST_USERS = [
  {
    name: "Priya Sharma — Senior Frontend Developer",
    matches: [
      { index:0, job_id:"JOB001", title:"Senior React Developer",       company:"TechCorp",      location:"Bangalore, India", salary_min:1800000, salary_max:2500000, description_snippet:"Build scalable React apps with TypeScript, Redux, and REST APIs. 5+ years experience required.", match_percent:92, existing_reason:"Strong React and TypeScript skills" },
      { index:1, job_id:"JOB002", title:"Full Stack Engineer",           company:"StartupXYZ",    location:"Remote",           salary_min:1500000, salary_max:2000000, description_snippet:"Node.js backend, React frontend. Work with cross-functional teams in an agile environment.",    match_percent:78, existing_reason:"Full stack background" },
      { index:2, job_id:"JOB003", title:"UI/UX Engineer",                company:"DesignStudio",  location:"Mumbai, India",    salary_min:1200000, salary_max:1800000, description_snippet:"Design and implement pixel-perfect interfaces. Figma proficiency required.",                   match_percent:65, existing_reason:"Frontend experience" },
      { index:3, job_id:"JOB004", title:"DevOps Engineer",               company:"CloudBase",     location:"Hyderabad, India", salary_min:2000000, salary_max:2800000, description_snippet:"Manage Kubernetes clusters, CI/CD pipelines, AWS infrastructure.",                            match_percent:30, existing_reason:"" },
    ]
  },
  {
    name: "James Okafor — Data Scientist",
    matches: [
      { index:0, job_id:"JOB010", title:"Senior Data Scientist",         company:"AnalyticsCo",   location:"London, UK",       salary_min:70000,   salary_max:90000,   description_snippet:"Build ML models in Python/TensorFlow. Work with large datasets and stakeholders.",           match_percent:89, existing_reason:"Strong Python and ML background" },
      { index:1, job_id:"JOB011", title:"Machine Learning Engineer",     company:"AIVentures",    location:"Remote",           salary_min:80000,   salary_max:110000,  description_snippet:"Deploy ML models at scale using MLflow, Docker. AWS SageMaker experience preferred.",       match_percent:74, existing_reason:"Machine learning experience" },
      { index:2, job_id:"JOB012", title:"Data Analyst",                  company:"RetailCorp",    location:"Manchester, UK",   salary_min:40000,   salary_max:55000,   description_snippet:"SQL, Tableau, Excel. Generate weekly reports and dashboards for business teams.",            match_percent:55, existing_reason:"Data skills" },
      { index:3, job_id:"JOB013", title:"Software Engineer (Backend)",   company:"FinTechPlus",   location:"London, UK",       salary_min:65000,   salary_max:85000,   description_snippet:"Java Spring Boot microservices. PostgreSQL, Kafka, Docker.",                               match_percent:28, existing_reason:"" },
    ]
  },
  {
    name: "Sofia Martinez — Junior Marketing Graduate",
    matches: [
      { index:0, job_id:"JOB020", title:"Marketing Coordinator",         company:"BrandAgency",   location:"Madrid, Spain",    salary_min:22000,   salary_max:28000,   description_snippet:"Coordinate social media campaigns, assist with content creation and analytics reporting.",   match_percent:81, existing_reason:"Marketing degree and social media skills" },
      { index:1, job_id:"JOB021", title:"Content Writer",                company:"MediaHouse",    location:"Remote",           salary_min:18000,   salary_max:24000,   description_snippet:"Write blog posts, email newsletters, and social content. SEO knowledge helpful.",          match_percent:68, existing_reason:"Writing experience" },
      { index:2, job_id:"JOB022", title:"Sales Development Rep",         company:"SaasCo",        location:"Barcelona, Spain", salary_min:25000,   salary_max:35000,   description_snippet:"Cold outreach, qualify leads, book demos. CRM experience preferred.",                        match_percent:45, existing_reason:"Communication skills" },
    ]
  },
];

async function runJobMatchTests() {
  console.log(`\n${h("━━ USE CASE 1: Job Match Enrichment (Candidate Side)")}`);
  console.log(gr("   Mirrors enrichMatchesWithLLM() in candidate.js\n"));

  for (const user of TEST_USERS) {
    console.log(`  ${b("User:")} ${user.name}`);

    const prompt = `You are a career advisor AI inside a recruitment platform.
Given these job matches for a candidate, do two things:
1. Re-rank them from best to worst fit (consider match %, role clarity, salary, growth potential).
2. For each job write a single friendly sentence (max 20 words) explaining WHY it suits the candidate. Start with "Great fit because" or "Strong match —" etc.

IMPORTANT: Return ONLY a raw JSON array. No markdown, no backticks, no explanation. Just the JSON.
Each item: { "index": <number>, "job_id": "...", "ai_rank": 1, "ai_insight": "..." }

Matches:
${JSON.stringify(user.matches.map(m=>({index:m.index,job_id:m.job_id,title:m.title,company:m.company,match_percent:m.match_percent,existing_reason:m.existing_reason})))}`;

    const { raw, elapsed, error } = await callGemini(prompt);

    // Test 1: Connectivity
    if (error) {
      record("Job Match", `[${user.name}] API connectivity`, "FAIL", { note: error });
      continue;
    }
    record("Job Match", `[${user.name}] API responded`, "PASS", { note: `${elapsed}ms` });

    // Test 2: Non-empty response
    if (!raw || raw.trim().length === 0) {
      record("Job Match", `[${user.name}] Response not empty`, "FAIL", { note: "Empty response from LLM" });
      continue;
    }
    record("Job Match", `[${user.name}] Response not empty`, "PASS", { note: `${raw.length} chars` });

    // Test 3: Valid JSON
    let parsed;
    try {
      const clean = raw.replace(/```json|```/g, "").trim();
const jsonStr = clean.match(/\[[\s\S]*\]|\{[\s\S]*\}/)?.[0] || clean;
parsed = JSON.parse(jsonStr);
      record("Job Match", `[${user.name}] Valid JSON returned`, "PASS", { note: `${parsed.length} items` });
    } catch {
      record("Job Match", `[${user.name}] Valid JSON returned`, "FAIL", { note: `Could not parse: ${raw.slice(0, 80)}` });
      continue;
    }

    // Test 4: All job_ids present
    const returnedIds = new Set(parsed.map(p => p.job_id));
    const allPresent  = user.matches.every(m => returnedIds.has(m.job_id));
    record("Job Match", `[${user.name}] All job_ids returned`, allPresent ? "PASS" : "WARN",
      { note: allPresent ? "All IDs accounted for" : `Missing: ${user.matches.filter(m=>!returnedIds.has(m.job_id)).map(m=>m.job_id).join(", ")}` });

    // Test 5: ai_rank fields present and are numbers
    const hasRanks = parsed.every(p => typeof p.ai_rank === "number" && p.ai_rank > 0);
    record("Job Match", `[${user.name}] ai_rank fields valid`, hasRanks ? "PASS" : "WARN",
      { note: hasRanks ? "All ranks are positive numbers" : "Some items missing or invalid ai_rank" });

    // Test 6: ai_insight fields present and non-empty
    const hasInsights = parsed.filter(p => p.ai_insight && p.ai_insight.trim().length > 5).length;
    record("Job Match", `[${user.name}] ai_insight quality`, hasInsights >= user.matches.length - 1 ? "PASS" : "WARN",
      { note: `${hasInsights}/${user.matches.length} items have meaningful insights` });

    // Test 7: Ranking logic — top match % item should be rank 1 or 2
    const topMatchJob = user.matches.reduce((a, b) => a.match_percent > b.match_percent ? a : b);
    const topRanked   = parsed.find(p => p.job_id === topMatchJob.job_id);
    const rankingOk   = topRanked && topRanked.ai_rank <= 2;
    record("Job Match", `[${user.name}] Ranking logic sensible`, rankingOk ? "PASS" : "WARN",
      { note: rankingOk ? `Highest match (${topMatchJob.title}) ranked #${topRanked.ai_rank}` : `Highest match job ranked #${topRanked?.ai_rank ?? "?"}` });

    // Test 8: Low-relevance job ranked last
    const lowestMatch = user.matches.reduce((a, b) => a.match_percent < b.match_percent ? a : b);
    const lowestRanked = parsed.find(p => p.job_id === lowestMatch.job_id);
    const lowestOk     = lowestRanked && lowestRanked.ai_rank === user.matches.length;
    record("Job Match", `[${user.name}] Low relevance job ranked last`, lowestOk ? "PASS" : "WARN",
      { note: lowestOk ? `${lowestMatch.title} correctly ranked last` : `${lowestMatch.title} ranked #${lowestRanked?.ai_rank ?? "?"}` });

    // Show sample insights
    console.log(`         ${gr("Sample insights:")}`);
    parsed.sort((a,b)=>a.ai_rank-b.ai_rank).slice(0,2).forEach(p => {
      const job = user.matches.find(m=>m.job_id===p.job_id);
      console.log(`         ${gr(`  #${p.ai_rank} ${job?.title||p.job_id}: "${p.ai_insight}"`)}`);
    });
    console.log();
  }
}

// ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ──
//  USE CASE 2 — Recruiter Candidate Ranking (recruiter side)
//  Mirrors: enrichCandidatesWithLLM() in api.js
// ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ──

const RECRUITER_TESTS = [
  {
    jobTitle: "Senior React Developer",
    candidates: [
      { id:"CAND001", skills:["React","TypeScript","Redux","GraphQL"],      pct:91 },
      { id:"CAND002", skills:["React","JavaScript","CSS","Bootstrap"],      pct:78 },
      { id:"CAND003", skills:["Angular","Java","Spring","Hibernate"],       pct:42 },
      { id:"CAND004", skills:["React","Node.js","MongoDB","AWS"],           pct:85 },
      { id:"CAND005", skills:["Vue.js","Nuxt","Tailwind","TypeScript"],     pct:61 },
    ]
  },
  {
    jobTitle: "Data Scientist — NLP Focus",
    candidates: [
      { id:"CAND010", skills:["Python","NLP","HuggingFace","PyTorch"],      pct:94 },
      { id:"CAND011", skills:["Python","Pandas","scikit-learn","SQL"],      pct:72 },
      { id:"CAND012", skills:["R","Statistics","SPSS","Excel"],             pct:55 },
      { id:"CAND013", skills:["Python","LLM","LangChain","OpenAI"],         pct:88 },
    ]
  },
];

async function runRecruiterTests() {
  console.log(`\n${h("━━ USE CASE 2: Recruiter Candidate Ranking (Recruiter Side)")}`);
  console.log(gr("   Mirrors enrichCandidatesWithLLM() in api.js\n"));

  for (const test of RECRUITER_TESTS) {
    console.log(`  ${b("Job:")} ${test.jobTitle}`);

    const slim = test.candidates.map(m => ({ id: m.id, skills: m.skills, pct: m.pct }));
    const prompt = `Rank these candidates. Return ONLY a JSON array, no markdown.
Each: {"candidate_id":"<id>","recruiter_summary":"1 sentence max 12 words","shortlist_flag":true/false}
Top 2 get shortlist_flag true.
${JSON.stringify(slim)}`;

    const { raw, elapsed, error } = await callGemini(prompt);

    if (error) {
      record("Recruiter", `[${test.jobTitle}] API connectivity`, "FAIL", { note: error });
      continue;
    }
    record("Recruiter", `[${test.jobTitle}] API responded`, "PASS", { note: `${elapsed}ms` });

    let parsed;
    try {
      let clean = raw.replace(/```json|```/g, "").trim();
      if (!clean.endsWith("]")) {
        const lastComplete = clean.lastIndexOf("},");
        const lastObj      = clean.lastIndexOf("}");
        const cutAt        = lastComplete > -1 ? lastComplete + 1 : lastObj + 1;
        clean = clean.slice(0, cutAt) + "]";
      }
      parsed = JSON.parse(clean);
      record("Recruiter", `[${test.jobTitle}] Valid JSON`, "PASS", { note: `${parsed.length} candidates ranked` });
    } catch {
      record("Recruiter", `[${test.jobTitle}] Valid JSON`, "FAIL", { note: `Parse failed: ${raw.slice(0,80)}` });
      continue;
    }

    // Exactly 2 shortlisted
    const shortlisted = parsed.filter(p => p.shortlist_flag === true);
    record("Recruiter", `[${test.jobTitle}] Exactly 2 shortlisted`, shortlisted.length === 2 ? "PASS" : "WARN",
      { note: `${shortlisted.length} candidates marked shortlist_flag:true (expected 2)` });

    // Top % candidates are shortlisted
    const sortedByPct   = [...test.candidates].sort((a,b) => b.pct - a.pct).slice(0,2).map(c=>c.id);
    const shortlistIds  = shortlisted.map(p => p.candidate_id);
    const topShortlisted = sortedByPct.every(id => shortlistIds.includes(id));
    record("Recruiter", `[${test.jobTitle}] Best candidates shortlisted`, topShortlisted ? "PASS" : "WARN",
      { note: topShortlisted ? `Correctly shortlisted top matches` : `Expected ${sortedByPct.join(",")} — got ${shortlistIds.join(",")}` });

    // Summaries present and concise
    const goodSummaries = parsed.filter(p => p.recruiter_summary && p.recruiter_summary.split(" ").length <= 14).length;
    record("Recruiter", `[${test.jobTitle}] Summaries concise (≤14 words)`, goodSummaries === parsed.length ? "PASS" : "WARN",
      { note: `${goodSummaries}/${parsed.length} summaries within word limit` });

    console.log(`         ${gr("Shortlisted:")}`);
    shortlisted.forEach(p => console.log(`         ${gr(`  ${p.candidate_id}: "${p.recruiter_summary}"`)}`));
    console.log();
  }
}

// ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ──
//  USE CASE 3 — Know More (job deep-dive for candidate)
//  Mirrors: openKnowMoreModal() in candidate.js
// ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ──

const KNOW_MORE_TESTS = [
  {
    label: "Senior React Dev + relevant resume",
    job: { title:"Senior React Developer", company:"TechCorp India", location:"Bangalore", salary:"₹20L–₹25L",
      description:"We are looking for a senior React developer to lead our frontend team. You will architect scalable component libraries, mentor junior developers, conduct code reviews, and work closely with product managers. Must have TypeScript, Redux Toolkit, and REST API integration experience. GraphQL is a plus." },
    resume: "Priya Sharma. 5 years experience in frontend development. Proficient in React, TypeScript, Redux. Built component libraries at previous company. Experience with REST APIs and some GraphQL. Led a team of 3 junior devs."
  },
  {
    label: "Data Scientist role + mismatched resume",
    job: { title:"Senior Data Scientist", company:"AnalyticsCo", location:"London, UK", salary:"£70K–£90K",
      description:"We need a data scientist to build and deploy ML models. Python, scikit-learn, TensorFlow required. Experience with A/B testing, statistical analysis, and stakeholder communication essential. MLflow and cloud deployment a bonus." },
    resume: "James is a marketing graduate with 2 years in digital marketing. Skills include Google Analytics, Facebook Ads, Canva, and Excel. No programming experience."
  },
  {
    label: "Generic role with no resume",
    job: { title:"Product Manager", company:"SaaSStart", location:"Remote", salary:"$90K–$120K",
      description:"Own the product roadmap for our B2B SaaS platform. Work with engineering, design, and sales. Define requirements, prioritise features, conduct user research. 3+ years PM experience required." },
    resume: ""
  },
];

async function runKnowMoreTests() {
  console.log(`\n${h("━━ USE CASE 3: Know More — Job Deep Dive (Candidate Side)")}`);
  console.log(gr("   Mirrors openKnowMoreModal() in candidate.js\n"));

  for (const test of KNOW_MORE_TESTS) {
    console.log(`  ${b("Test:")} ${test.label}`);

    const prompt = `You are a career coach helping a candidate understand a job and prepare for it.

Job Title: ${test.job.title}
Company: ${test.job.company}
Location: ${test.job.location}
Salary: ${test.job.salary}
Job Description:
${test.job.description}

${test.resume ? `Candidate Resume Snippet:\n${test.resume}` : ""}

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

    const { raw, elapsed, error } = await callGemini(prompt);

    if (error) {
      record("Know More", `[${test.label}] API connectivity`, "FAIL", { note: error });
      continue;
    }
    record("Know More", `[${test.label}] API responded`, "PASS", { note: `${elapsed}ms` });

    let parsed;
    try {
      const clean = raw.replace(/```json|```/g, "").trim();
const jsonStr = clean.match(/\[[\s\S]*\]|\{[\s\S]*\}/)?.[0] || clean;
parsed = JSON.parse(jsonStr);
      record("Know More", `[${test.label}] Valid JSON`, "PASS", { note: "Parsed successfully" });
    } catch {
      record("Know More", `[${test.label}] Valid JSON`, "FAIL", { note: `Parse failed: ${raw.slice(0,100)}` });
      continue;
    }

    // summary field
    const hasSummary = parsed.summary && parsed.summary.trim().length > 20;
    record("Know More", `[${test.label}] summary field present`, hasSummary ? "PASS" : "WARN",
      { note: hasSummary ? `${parsed.summary.split(" ").length} words` : "Summary missing or too short" });

    // what_youll_do array
    const hasBullets = Array.isArray(parsed.what_youll_do) && parsed.what_youll_do.length >= 2;
    record("Know More", `[${test.label}] what_youll_do bullets`, hasBullets ? "PASS" : "WARN",
      { note: hasBullets ? `${parsed.what_youll_do.length} bullets` : "Missing or empty array" });

    // tips array with title + detail
    const hasValidTips = Array.isArray(parsed.tips) && parsed.tips.length >= 2 &&
      parsed.tips.every(t => t.title && t.detail);
    record("Know More", `[${test.label}] tips array valid`, hasValidTips ? "PASS" : "WARN",
      { note: hasValidTips ? `${parsed.tips.length} tips with title+detail` : "Tips missing or malformed" });

    // Personalisation check — if resume provided, tips should differ from no-resume case
    if (test.resume) {
      const tipsText = JSON.stringify(parsed.tips).toLowerCase();
      const resumeWords = test.resume.toLowerCase().split(/\s+/).filter(w => w.length > 4);
      const personalised = resumeWords.some(w => tipsText.includes(w));
      record("Know More", `[${test.label}] Tips personalised to resume`, personalised ? "PASS" : "WARN",
        { note: personalised ? "Tips reference resume content" : "Tips appear generic — not personalised" });
    }

    console.log(`         ${gr(`Summary: "${(parsed.summary||"").slice(0,90)}..."`)}`);
    console.log(`         ${gr(`Tip 1: "${parsed.tips?.[0]?.title}" — ${parsed.tips?.[0]?.detail?.slice(0,60)}`)}`);
    console.log();
  }
}

// ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ──
//  EDGE CASE TESTS
// ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ──
async function runEdgeCaseTests() {
  console.log(`\n${h("━━ USE CASE 4: Edge Cases & Robustness")}\n`);

  // Edge 1: Single job match
  {
    console.log(`  ${b("Edge:")} Single job match (minimum input)`);
    const prompt = `You are a career advisor AI inside a recruitment platform.
Given these job matches for a candidate, do two things:
1. Re-rank them from best to worst fit.
2. For each job write a single friendly sentence (max 20 words). Start with "Great fit because" or "Strong match —".
Return ONLY a raw JSON array. No markdown. Each item: { "index": <number>, "job_id": "...", "ai_rank": 1, "ai_insight": "..." }
Matches:
${JSON.stringify([{ index:0, job_id:"SOLO001", title:"Backend Engineer", company:"Solo Inc", match_percent:88, existing_reason:"Good backend skills" }])}`;
    const { raw, elapsed, error } = await callGemini(prompt);
    if (!error) {
      try {
        const p = JSON.parse(raw.replace(/```json|```/g,"").trim());
        record("Edge Cases", "Single job — valid JSON", p.length === 1 ? "PASS" : "WARN", { note: `${elapsed}ms, ${p.length} items` });
        record("Edge Cases", "Single job — ai_rank is 1", p[0]?.ai_rank === 1 ? "PASS" : "WARN", { note: `ai_rank = ${p[0]?.ai_rank}` });
      } catch { record("Edge Cases", "Single job — valid JSON", "FAIL", { note: "Parse failed" }); }
    } else { record("Edge Cases", "Single job — API call", "FAIL", { note: error }); }
    console.log();
  }

  // Edge 2: Response format compliance (no markdown leakage)
  {
    console.log(`  ${b("Edge:")} No markdown leakage in response`);
    const prompt = `Rank these candidates. Return ONLY a JSON array, no markdown.
Each: {"candidate_id":"<id>","recruiter_summary":"1 sentence max 12 words","shortlist_flag":true/false}
Top 2 get shortlist_flag true.
${JSON.stringify([{id:"X1",skills:["Python","ML"],pct:90},{id:"X2",skills:["Java"],pct:60}])}`;
    const { raw, error } = await callGemini(prompt);
    if (!error) {
      const hasBackticks = raw.includes("```");
      const hasMarkdown  = /^#{1,3}\s/m.test(raw);
      record("Edge Cases", "No markdown backticks in response", !hasBackticks ? "PASS" : "WARN", { note: hasBackticks ? "Response contains ``` — needs client-side stripping" : "Clean JSON, no backticks" });
      record("Edge Cases", "No markdown headers in response",   !hasMarkdown  ? "PASS" : "WARN", { note: hasMarkdown  ? "Response contains # headers"                    : "No markdown headers" });
    } else { record("Edge Cases", "Markdown leakage test", "FAIL", { note: error }); }
    console.log();
  }

  // Edge 3: Response speed benchmark
  {
    console.log(`  ${b("Edge:")} Response latency benchmark`);
    const timings = [];
    for (let i = 0; i < 2; i++) {
      const { elapsed, error } = await callGemini(`Return the single word: hello`);
      if (!error) timings.push(elapsed);
    }
    if (timings.length > 0) {
      const avg = Math.round(timings.reduce((a,b)=>a+b,0)/timings.length);
      record("Edge Cases", "Latency acceptable (<15s)", avg < 15000 ? "PASS" : "WARN", { note: `Avg: ${avg}ms over ${timings.length} calls` });
    }
    console.log();
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${"═".repeat(65)}`);
  console.log(h("  BeyondMatch — LLM Integration Test Suite"));
  console.log(`  Endpoint: ${LLM_ENDPOINT}`);
  console.log(`  Date:     ${new Date().toISOString()}`);
  console.log(`${"═".repeat(65)}`);

  await runJobMatchTests();
  await runRecruiterTests();
  await runKnowMoreTests();
  await runEdgeCaseTests();

  // ─── Summary ──────────────────────────────────────────────────────────────
  const pass = results.filter(r=>r.status==="PASS").length;
  const warn = results.filter(r=>r.status==="WARN").length;
  const fail = results.filter(r=>r.status==="FAIL").length;
  const total = results.length;
  const score = Math.round((pass/total)*100);

  console.log(`\n${"═".repeat(65)}`);
  console.log(h("  LLM TEST SUMMARY"));
  console.log(`${"═".repeat(65)}`);
  console.log(`  Total Tests  : ${total}`);
  console.log(`  ${g("✓ Pass")}        : ${pass}`);
  console.log(`  ${y("⚠ Warn")}        : ${warn}`);
  console.log(`  ${r("✗ Fail")}        : ${fail}`);
  console.log(`  Score        : ${score >= 80 ? g(score+"%") : score >= 60 ? y(score+"%") : r(score+"%")}`);
  console.log(`${"═".repeat(65)}`);

  if (fail > 0) {
    console.log(`\n${r("  Failures:")}`);
    results.filter(t=>t.status==="FAIL").forEach(t => console.log(`  ${r("✗")} [${t.useCase}] ${t.testName} — ${t.details.note}`));
  }
  if (warn > 0) {
    console.log(`\n${y("  Warnings:")}`);
    results.filter(t=>t.status==="WARN").forEach(t => console.log(`  ${y("⚠")} [${t.useCase}] ${t.testName} — ${t.details.note}`));
  }

  // Save JSON for report generation
  const outPath = require('path').join(__dirname, 'llm_test_results.json');
  require('fs').writeFileSync(outPath, JSON.stringify({ results, summary:{ total, pass, warn, fail, score }, testedAt: new Date().toISOString() }, null, 2));
  console.log(`\n✓ Results saved to ${outPath}`);
}

main().catch(console.error);