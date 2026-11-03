// GitHub GraphQL access and pull request sorting for the GitHub Pull Requests plugin.

const { execFile } = require("node:child_process");

const API = "https://api.github.com/graphql";
const TIMEOUT_MS = 15_000;

// --------------------------------------------------------------------------- token

let ghToken = null; // cached `gh auth token` output

function ghAuthToken() {
  return new Promise((resolve) => {
    execFile("gh", ["auth", "token"], { timeout: 5_000 }, (err, stdout) => resolve(err ? null : stdout.trim() || null));
  });
}

// A token from the settings wins; otherwise borrow the GitHub CLI's login.
async function token(configured, { fresh = false } = {}) {
  if (configured) return configured.trim();
  if (!ghToken || fresh) ghToken = await ghAuthToken();
  return ghToken;
}

// --------------------------------------------------------------------------- query

const PR_FIELDS = `
fragment pr on PullRequest {
  number title url createdAt updatedAt
  repository { nameWithOwner }
  author { login }
  mergeable
  reviewDecision
  latestOpinionatedReviews(first: 30, writersOnly: true) { nodes { state author { login } } }
  reviewRequests(first: 20) {
    nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } } }
  }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}`;

const QUERY = `
query($mine: String!, $review: String!) {
  viewer { login }
  mine: search(type: ISSUE, query: $mine, first: 50) { nodes { ...pr } }
  review: search(type: ISSUE, query: $review, first: 50) { nodes { ...pr } }
}
${PR_FIELDS}`;

// "acme, other" -> ["acme", "other"]; repeated org: qualifiers are ORed by GitHub search.
const parseOrgs = (orgs) => String(orgs || "").split(/[\s,]+/).map((o) => o.trim()).filter(Boolean);
const scope = (orgs) => parseOrgs(orgs).map((o) => `org:${o}`).join(" ");

// Draft PRs are never counted: they aren't ready for review or merging yet.
function queries(orgs) {
  const base = `is:pr is:open draft:false archived:false ${scope(orgs)}`.trim();
  return {
    mine: `${base} author:@me sort:updated-desc`,
    review: `${base} review-requested:@me -author:@me sort:created-asc`,
  };
}

async function graphql(tok, query, variables) {
  const res = await fetch(API, {
    method: "POST",
    headers: { Authorization: `bearer ${tok}`, "Content-Type": "application/json", "User-Agent": "deckd-github-prs" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 401) throw Object.assign(new Error("bad token"), { code: "auth" });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { code: res.status === 403 ? "limit" : "offline" });
  const body = await res.json();
  if (body.errors?.length && !body.data) throw Object.assign(new Error(body.errors[0].message), { code: "error" });
  return body.data;
}

// Fetch the open PRs that involve the viewer in the given orgs.
async function fetchPrs(tok, orgs) {
  const data = await graphql(tok, QUERY, queries(orgs));
  const clean = (nodes) => (nodes || []).filter((n) => n && n.number);
  return { login: data.viewer.login, mine: clean(data.mine.nodes).map(simplify), review: clean(data.review.nodes).map(simplify) };
}

function simplify(pr) {
  const approvers = new Set();
  let changesRequested = false;
  for (const r of pr.latestOpinionatedReviews?.nodes || []) {
    if (r.state === "APPROVED") approvers.add(r.author?.login);
    if (r.state === "CHANGES_REQUESTED") changesRequested = true;
  }
  const reviewers = (pr.reviewRequests?.nodes || []).map((n) => n.requestedReviewer).filter(Boolean);
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    repo: pr.repository.nameWithOwner,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    approvals: approvers.size,
    changesRequested: changesRequested || pr.reviewDecision === "CHANGES_REQUESTED",
    reviewDecision: pr.reviewDecision, // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null
    mergeable: pr.mergeable, // MERGEABLE | CONFLICTING | UNKNOWN
    ci: pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state || null, // SUCCESS | FAILURE | ERROR | PENDING | EXPECTED | null
    requestedUsers: reviewers.filter((r) => r.__typename === "User").map((r) => r.login),
    requestedTeams: reviewers.filter((r) => r.__typename === "Team").map((r) => r.slug),
  };
}

// --------------------------------------------------------------------------- sorting

// Why one of the viewer's PRs needs them: failed CI, merge conflict or requested changes.
function attentionReasons(pr) {
  const reasons = [];
  if (pr.ci === "FAILURE" || pr.ci === "ERROR") reasons.push("CI");
  if (pr.mergeable === "CONFLICTING") reasons.push("conflict");
  if (pr.changesRequested) reasons.push("changes");
  return reasons;
}

// Split the fetched PRs into the four lists the buttons show. A PR of yours lands in at most one of
// attention / ready / needsReviews; one with pending CI and enough approvals is in none until CI settles.
function categorize(data, minApprovals) {
  const min = Math.max(1, Number(minApprovals) || 1);
  const out = { review: [], needsReviews: [], attention: [], ready: [] };
  if (!data) return out;

  for (const pr of data.review) {
    out.review.push({ ...pr, direct: pr.requestedUsers.includes(data.login) });
  }
  for (const pr of data.mine) {
    const reasons = attentionReasons(pr);
    if (reasons.length) out.attention.push({ ...pr, reasons });
    else if (pr.approvals < min || pr.reviewDecision === "REVIEW_REQUIRED") out.needsReviews.push({ ...pr, missing: Math.max(1, min - pr.approvals) });
    else if (pr.mergeable === "MERGEABLE" && (pr.ci === "SUCCESS" || pr.ci === null)) out.ready.push(pr);
  }
  return out;
}


module.exports = { token, fetchPrs, categorize, simplify, PR_FIELDS };
