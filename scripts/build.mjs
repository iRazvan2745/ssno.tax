import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(projectRoot, "oidc-applications.json");
const shellPath = resolve(projectRoot, "index.html");
const outputDirectory = resolve(projectRoot, "dist");
const outputPath = resolve(outputDirectory, "index.html");
const sitemapPath = resolve(outputDirectory, "sitemap.xml");
const robotsPath = resolve(outputDirectory, "robots.txt");
const stylesheetPath = resolve(projectRoot, "index.css");
const siteUrl = process.env.SITE_URL ?? "https://ssno.tax";

let siteOrigin;
try {
  siteOrigin = new URL(siteUrl);
  if (!["http:", "https:"].includes(siteOrigin.protocol) || siteOrigin.search || siteOrigin.hash) {
    throw new Error();
  }
} catch {
  throw new Error("SITE_URL must be a valid http(s) URL without a query string or hash");
}

const siteBaseUrl = siteOrigin.href.replace(/\/$/, "");
const lowActivityDays = Number(process.env.LOW_ACTIVITY_DAYS ?? 90);
if (!Number.isInteger(lowActivityDays) || lowActivityDays < 1) {
  throw new Error("LOW_ACTIVITY_DAYS must be a positive integer");
}
const filterScriptPath = resolve(projectRoot, "filter.js");
const logoPath = resolve(projectRoot, "taxfree.svg");
const marker = "<!-- OIDC_APPLICATIONS -->";

const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );

const escapeXml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[character],
  );

const safeUrl = (value) => {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol)
      ? escapeHtml(url.href)
      : "#";
  } catch {
    return "#";
  }
};

const externalLink = (url, label) =>
  `<a href="${safeUrl(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;

// Restrictive "source-available" licenses that are not OSI-approved open
// source. Entries must anchor at the start of the license string (e.g.
// "BSL-1.1", "MSCL-1.0 (source-available)").
const restrictiveLicenses = [
  { pattern: /^BSL\b/i, title: "Business Source License" },
  { pattern: /^MSCL\b/i, title: "Source-available community license (not OSI-approved)" },
];

const renderLicense = (license) => {
  const restrictive = restrictiveLicenses.find(({ pattern }) => pattern.test(license));
  if (!restrictive) return escapeHtml(license);

  return `<span class="license-alert" title="${escapeHtml(restrictive.title)}"><span class="license-alert-icon" aria-hidden="true">⚠</span><span><span class="visually-hidden">Warning: </span>${escapeHtml(license)}</span></span>`;
};

const renderOidcStatus = (status = "built_in") => {
  const isExtension = status === "extension";
  const label = isExtension ? "Extension required" : "Built-in";
  const className = isExtension ? "extension" : "built-in";

  return `<span class="oidc-status oidc-status--${className}" role="img" aria-label="${label}" title="${label}"></span>`;
};

const renderStatusLegend = () => `
    <div class="oidc-legend" aria-label="OIDC support legend">
      <span><span class="oidc-status oidc-status--built-in" aria-hidden="true"></span> Built-in</span>
      <span><span class="oidc-status oidc-status--extension" aria-hidden="true"></span> Extension required</span>
    </div>`;

const renderNotes = (notes = []) => {
  if (!notes.length) return "";

  return `
    <aside class="catalog-notes" aria-label="Catalog notes">
      <h2>Notes</h2>
      <ul>
        ${notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("\n        ")}
      </ul>
    </aside>`;
};

const renderRejected = (rejected = []) => {
  if (!rejected.length) return "";

  const sorted = [...rejected].sort((a, b) => a.name.localeCompare(b.name));

  return `
    <section class="rejected-section" aria-labelledby="rejected-heading">
      <h2 id="rejected-heading">Rejected applications (${sorted.length})</h2>
      <p class="rejected-intro">These applications were considered but do not meet the admission criterion: the free self-hosted edition must support OIDC login without a paid SSO add-on. Editions and plans change, so re-check before relying on any of these.</p>
      <dl class="rejected-list">
        ${sorted
          .map(
            (entry) => `
        <div class="rejected-item">
          <dt>${entry.project_url ? externalLink(entry.project_url, entry.name) : escapeHtml(entry.name)}</dt>
          <dd>${escapeHtml(entry.reason)}</dd>
        </div>`,
          )
          .join("")}
      </dl>
    </section>`;
};

const renderRepoHealth = (health = {}) => {
  const color = health.status === "active" ? "green" : health.status === "untracked" ? "gray" : "red";
  const label = health.status === "active" ? "Active repository" : health.status === "low" ? "Low activity" : health.status === "untracked" ? "No GitHub repository" : "Unable to check repository";
  const date = health.lastCommit ? ` Last commit: ${health.lastCommit.slice(0, 10)}.` : "";

  return `<span class="repo-health repo-health--${color}" role="img" aria-label="${label}" title="${escapeHtml(`${label}.${date}`)}"></span><span class="visually-hidden">${escapeHtml(label)}</span>`;
};

const renderFilters = (categoryEntries) => `
    <nav class="category-filters" aria-label="Filter applications by category">
      <span class="filter-label">Filter by category</span>
      <div class="filter-buttons" role="group" aria-label="Application categories">
        <button class="category-filter" type="button" data-category="all" aria-pressed="true">All <span>(${data.applications.length})</span></button>
        ${categoryEntries
          .map(
            ([category, applications]) =>
              `<button class="category-filter" type="button" data-category="${escapeHtml(category)}" aria-pressed="false">${escapeHtml(category)} <span>(${applications.length})</span></button>`,
          )
          .join("\n        ")}
      </div>
    </nav>`;

const renderApplication = (application) => {
  const logo = application.logo_url
    ? `<img class="application-logo" src="${safeUrl(application.logo_url)}" alt="" width="32" height="32" loading="lazy" decoding="async" />`
    : "";

  return `
          <tr>
            <th scope="row">
              <a class="application-name" href="${safeUrl(application.project_url)}" target="_blank" rel="noopener noreferrer">
                ${logo}
                <span>${escapeHtml(application.name)}</span>
              </a>
            </th>
            <td data-label="OIDC support">${renderOidcStatus(application.oidc_status)}</td>
            <td data-label="Repo health">${renderRepoHealth(application.repo_health)}</td>
            <td data-label="License">${renderLicense(application.license)}</td>
            <td data-label="Description">${escapeHtml(application.description)}</td>
            <td data-label="Links">${externalLink(application.documentation_url, "Documentation")}</td>
          </tr>`;
};

const renderCategory = ([category, applications]) => `
    <section class="category-section" data-category="${escapeHtml(category)}">
      <h2>${escapeHtml(category)}</h2>
      <div class="table-wrapper">
        <table class="application-table">
          <caption class="visually-hidden">${escapeHtml(category)} applications</caption>
          <thead>
            <tr>
              <th scope="col">Application</th>
              <th scope="col">OIDC support</th>
              <th scope="col">Repo health</th>
              <th scope="col">License</th>
              <th scope="col">Description</th>
              <th scope="col">Links</th>
            </tr>
          </thead>
          <tbody>
            ${applications.map(renderApplication).join("\n")}
          </tbody>
        </table>
      </div>
    </section>`;

const data = JSON.parse(await readFile(sourcePath, "utf8"));
const shell = await readFile(shellPath, "utf8");

if (!Array.isArray(data.applications)) {
  throw new Error("oidc-applications.json must contain an applications array");
}

if (data.rejected !== undefined) {
  if (!Array.isArray(data.rejected)) {
    throw new Error("oidc-applications.json must contain a rejected array when the key is present");
  }
  for (const entry of data.rejected) {
    if (!entry.name || !entry.reason) {
      throw new Error("Every rejected entry must have a name and reason");
    }
  }
}

const githubRepositoryFromUrl = (value) => {
  try {
    const url = new URL(value);
    if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return null;

    const [owner, repository] = url.pathname.split("/").filter(Boolean);
    if (!owner || !repository) return null;
    return `${owner}/${repository.replace(/\\.git$/, "")}`;
  } catch {
    return null;
  }
};

const fetchRepoHealth = async (application) => {
  const repository = githubRepositoryFromUrl(application.github_url ?? application.project_url);
  if (!repository) {
    return { status: "untracked" };
  }

  try {
    let lastCommit;
    if (process.env.GITHUB_TOKEN) {
      const response = await fetch(
        `https://api.github.com/repos/${repository}/commits?per_page=1`,
        {
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
            "User-Agent": "oidc-applications-catalog-build",
          },
        },
      );
      if (!response.ok) throw new Error(`GitHub API returned ${response.status}`);

      const commits = await response.json();
      lastCommit = commits[0]?.commit?.committer?.date ?? commits[0]?.commit?.author?.date;
    } else {
      // The Atom feed avoids consuming the unauthenticated GitHub API rate limit
      // during public Cloudflare Pages builds.
      const response = await fetch(`https://github.com/${repository}/commits.atom`);
      if (!response.ok) throw new Error(`GitHub feed returned ${response.status}`);

      const feed = await response.text();
      lastCommit = feed.match(/<entry>[\s\S]*?<updated>([^<]+)<\/updated>/)?.[1];
    }
    if (!lastCommit || Number.isNaN(Date.parse(lastCommit))) throw new Error("No valid commit date returned");

    const ageInDays = (Date.now() - Date.parse(lastCommit)) / 86_400_000;
    return {
      status: ageInDays >= lowActivityDays ? "low" : "active",
      lastCommit,
      repository,
    };
  } catch (error) {
    return {
      status: "unavailable",
      reason: error.message,
      repository,
    };
  }
};

const repoHealthResults = await Promise.all(
  data.applications.map(async (application) => {
    application.repo_health = await fetchRepoHealth(application);
    return application.repo_health;
  }),
);
const unavailableRepoCount = repoHealthResults.filter(({ status }) => status === "unavailable").length;
if (unavailableRepoCount) {
  console.warn(`Could not fetch repository activity for ${unavailableRepoCount} application(s).`);
}

const categories = new Map();
for (const application of data.applications) {
  if (!application.name || !application.category) {
    throw new Error("Every application must have a name and category");
  }

  const categoryApplications = categories.get(application.category) ?? [];
  categoryApplications.push(application);
  categories.set(application.category, categoryApplications);
}

for (const applications of categories.values()) {
  applications.sort((a, b) => a.name.localeCompare(b.name));
}

const categoryEntries = [...categories.entries()].sort(([a], [b]) =>
  a.localeCompare(b),
);

const generatedContent = `
  <div class="oidc-catalog" data-application-count="${data.applications.length}">
    <p class="catalog-count">${data.applications.length} applications</p>
    ${renderStatusLegend()}
    ${renderFilters(categoryEntries)}
    ${categoryEntries.map(renderCategory).join("\n")}
    ${renderNotes(data.notes)}
    ${renderRejected(data.rejected)}
  </div>`;

const markerCount = shell.split(marker).length - 1;
if (markerCount !== 1) {
  throw new Error(`Expected exactly one ${marker} marker in index.html`);
}

const output = shell.replace(marker, generatedContent.trim());
await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await writeFile(outputPath, output);

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${escapeXml(`${siteBaseUrl}/`)}</loc>
  </url>
</urlset>
`;
await writeFile(sitemapPath, sitemap);
await writeFile(
  robotsPath,
  `User-agent: *\nAllow: /\nSitemap: ${siteBaseUrl}/sitemap.xml\n`,
);

for (const [sourceFile, outputFile] of [
  [stylesheetPath, "index.css"],
  [filterScriptPath, "filter.js"],
  [logoPath, "taxfree.svg"],
]) {
  try {
    await copyFile(sourceFile, resolve(outputDirectory, outputFile));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

console.log(`Built ${outputPath} from ${data.applications.length} applications.`);
console.log(`Generated ${sitemapPath} for ${siteBaseUrl}.`);
