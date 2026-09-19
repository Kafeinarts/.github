// Generate "Team Activity" panel (stat tiles + commit heatmap) for a GitHub organization.
// Usage: GH_TOKEN=xxx GH_ORG=Kafeinarts node scripts/org-stats.mjs
// Test without token: MOCK=1 node scripts/org-stats.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const ORG = process.env.GH_ORG || "Kafeinarts";
const TOKEN = process.env.GH_TOKEN;
const OUT = process.env.OUT || "asset/org-stats.svg";
const MOCK = process.env.MOCK === "1";
const UTC_OFFSET = Number(process.env.UTC_OFFSET ?? 7); // WIB
const EXCLUDE_REPOS = (process.env.EXCLUDE_REPOS ?? ".github").split(",").map((s) => s.trim()).filter(Boolean);

const COLORS = ["#161b22", "#0e4429", "#006d32", "#26a641", "#39d353"];
const WEEKS = 53;

async function gql(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${TOKEN}`, "Content-Type": "application/json", "User-Agent": "org-stats" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

const isBot = (a) => /\[bot\]$/i.test(a?.name || "") || /\[bot\]$/i.test(a?.user?.login || "");

async function fetchData(since) {
  if (MOCK) return mockData();
  if (!TOKEN) throw new Error("GH_TOKEN belum di-set");

  // 1) daftar repo org (public, non-fork)
  const repos = [];
  let cursor = null;
  do {
    const d = await gql(
      `query($org:String!,$cursor:String){
        organization(login:$org){
          repositories(first:50, privacy:PUBLIC, isFork:false, after:$cursor){
            nodes{ name primaryLanguage{ name } }
            pageInfo{ hasNextPage endCursor }
          }
        }
      }`,
      { org: ORG, cursor }
    );
    const r = d.organization.repositories;
    repos.push(...r.nodes);
    cursor = r.pageInfo.hasNextPage ? r.pageInfo.endCursor : null;
  } while (cursor);

  const used = repos.filter((r) => !EXCLUDE_REPOS.includes(r.name));

  // 2) riwayat commit per repo (dengan pagination)
  const commits = [];
  for (const repo of used) {
    let c = null;
    do {
      const d = await gql(
        `query($org:String!,$name:String!,$since:GitTimestamp!,$cursor:String){
          repository(owner:$org,name:$name){
            defaultBranchRef{ target{ ... on Commit{
              history(since:$since, first:100, after:$cursor){
                nodes{ committedDate author{ name user{ login } } }
                pageInfo{ hasNextPage endCursor }
              }
            } } }
          }
        }`,
        { org: ORG, name: repo.name, since, cursor: c }
      );
      const h = d.repository?.defaultBranchRef?.target?.history;
      if (!h) break;
      for (const n of h.nodes) {
        if (isBot(n.author)) continue;
        commits.push({ date: n.committedDate, who: n.author?.user?.login || n.author?.name || "unknown" });
      }
      c = h.pageInfo.hasNextPage ? h.pageInfo.endCursor : null;
    } while (c);
  }
  return { repos: used, commits };
}

function mockData() {
  const repos = [{ name: "a", primaryLanguage: { name: "Vue" } }, { name: "b", primaryLanguage: { name: "PHP" } }, { name: "c", primaryLanguage: { name: "CSS" } }, { name: "d", primaryLanguage: { name: "Python" } }];
  const commits = [];
  const now = Date.now();
  const people = ["alfa", "budi", "citra", "dewi"];
  for (let i = 0; i < 365; i++) {
    if (Math.random() < 0.6) continue;
    const n = 1 + Math.floor(Math.random() * 5);
    for (let k = 0; k < n; k++) commits.push({ date: new Date(now - i * 86400000).toISOString(), who: people[Math.floor(Math.random() * people.length)] });
  }
  return { repos, commits };
}

const shifted = (iso) => new Date(new Date(iso).getTime() + UTC_OFFSET * 3600000);
const dayKey = (d) => d.toISOString().slice(0, 10);

function build({ repos, commits }, start, today) {
  const byDay = new Map();
  const people = new Set();
  for (const c of commits) {
    const k = dayKey(shifted(c.date));
    byDay.set(k, (byDay.get(k) || 0) + 1);
    people.add(c.who);
  }
  // grid days
  const days = [];
  for (let d = new Date(start); dayKey(d) <= dayKey(today); d.setUTCDate(d.getUTCDate() + 1)) {
    const k = dayKey(d);
    days.push({ date: k, count: byDay.get(k) || 0, weekday: d.getUTCDay() });
  }
  const total = days.reduce((s, d) => s + d.count, 0);
  const active = days.filter((d) => d.count > 0).length;
  let longest = 0, run = 0;
  for (const d of days) { run = d.count > 0 ? run + 1 : 0; longest = Math.max(longest, run); }
  const langs = new Set(repos.map((r) => r.primaryLanguage?.name).filter(Boolean));
  return { days, total, active, longest, repoCount: repos.length, contributors: people.size, languages: langs.size };
}

function render(s) {
  const CELL = 10, GAP = 3, PITCH = 13, PAD = 24, LEFT = 32;
  const gridW = WEEKS * PITCH - GAP;
  const W = PAD + LEFT + gridW + PAD;
  const TILE_Y = 58, TILE_H = 66;
  const MONTH_Y = 150, GRID_Y = 162;
  const H = GRID_Y + 7 * PITCH - GAP + 46;
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const max = Math.max(1, ...s.days.map((d) => d.count));
  const level = (c) => (c === 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((c / max) * 4))));

  let o = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Team activity of ${ORG}">`;
  o += `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="6" fill="#0d1117" stroke="#30363d"/>`;
  o += `<g font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">`;
  o += `<text x="${PAD}" y="34" fill="#58a6ff" font-size="18">Team Activity</text>`;
  o += `<text x="${W - PAD}" y="34" fill="#8b949e" font-size="12" text-anchor="end">${ORG} · last 12 months</text>`;

  // tiles
  const tiles = [
    [s.repoCount, "Repositories"],
    [s.total, "Commits"],
    [s.contributors, "Contributors"],
    [s.active, "Active days"],
    [s.longest, "Longest streak"],
  ];
  const tgap = 10;
  const tw = (W - 2 * PAD - tgap * (tiles.length - 1)) / tiles.length;
  tiles.forEach(([v, label], i) => {
    const x = PAD + i * (tw + tgap);
    o += `<rect x="${x}" y="${TILE_Y}" width="${tw}" height="${TILE_H}" rx="6" fill="#161b22" stroke="#30363d"/>`;
    o += `<text x="${x + 16}" y="${TILE_Y + 34}" fill="#e6edf3" font-size="24" font-weight="600">${v}</text>`;
    o += `<text x="${x + 16}" y="${TILE_Y + 54}" fill="#8b949e" font-size="12">${label}</text>`;
  });

  // months
  const first = new Date(s.days[0].date + "T00:00:00Z");
  let prev = -1, lastX = -100;
  for (let w = 0; w < WEEKS; w++) {
    const d = new Date(first); d.setUTCDate(d.getUTCDate() + w * 7);
    const m = d.getUTCMonth();
    if (m !== prev) {
      const x = PAD + LEFT + w * PITCH;
      if (x - lastX >= 3 * PITCH) { o += `<text x="${x}" y="${MONTH_Y}" fill="#8b949e" font-size="11">${MONTHS[m]}</text>`; lastX = x; }
      prev = m;
    }
  }
  [[1, "Mon"], [3, "Wed"], [5, "Fri"]].forEach(([d, t]) => {
    o += `<text x="${PAD}" y="${GRID_Y + d * PITCH + CELL - 1}" fill="#8b949e" font-size="11">${t}</text>`;
  });

  // cells
  s.days.forEach((d, i) => {
    const w = Math.floor((i + s.days[0].weekday) / 7);
    const x = PAD + LEFT + w * PITCH;
    const y = GRID_Y + d.weekday * PITCH;
    const t = `${d.count} commit${d.count === 1 ? "" : "s"} on ${d.date}`;
    o += `<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="2" fill="${COLORS[level(d.count)]}" stroke="#ffffff" stroke-opacity="0.05"><title>${t}</title></rect>`;
  });

  // legend
  const ly = GRID_Y + 7 * PITCH + 10;
  const lx = W - PAD - (5 * PITCH + 70);
  o += `<text x="${lx}" y="${ly + 9}" fill="#8b949e" font-size="11">Less</text>`;
  COLORS.forEach((c, i) => { o += `<rect x="${lx + 30 + i * PITCH}" y="${ly}" width="${CELL}" height="${CELL}" rx="2" fill="${c}" stroke="#ffffff" stroke-opacity="0.05"/>`; });
  o += `<text x="${lx + 30 + 5 * PITCH + 4}" y="${ly + 9}" fill="#8b949e" font-size="11">More</text>`;
  o += `</g></svg>`;
  return o;
}

// jendela: 53 minggu, dimulai hari Minggu
const today = shifted(new Date().toISOString());
const start = new Date(today);
start.setUTCDate(start.getUTCDate() - (WEEKS - 1) * 7 - start.getUTCDay());
const since = new Date(start.getTime() - UTC_OFFSET * 3600000).toISOString();

const data = await fetchData(since);
const stats = build(data, start, today);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, render(stats));
console.log(`OK: ${stats.repoCount} repos, ${stats.total} commits, ${stats.contributors} contributors -> ${OUT}`);
