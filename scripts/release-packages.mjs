import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Select unpublished versions and recover publications made by this same revision. */
export async function planReleases(packages, head, operations, recorded) {
  if (
    recorded !== undefined &&
    (recorded.head !== head ||
      !Array.isArray(recorded.packages) ||
      recorded.packages.some(
        (entry) =>
          !packages.some(
            (pkg) => !pkg.private && pkg.name === entry.name && pkg.version === entry.version,
          ),
      ))
  ) {
    throw new Error("Recorded release plan does not match this revision and its public packages");
  }
  const selected = new Set(recorded?.packages.map(({ name, version }) => `${name}@${version}`));
  const plan = [];
  for (const pkg of packages) {
    if (pkg.private) continue;
    const tag = `${pkg.name}@${pkg.version}`;
    const published = await operations.published(pkg);
    const tagged = await operations.tagCommit(tag);
    if (
      published !== null &&
      selected.has(tag) &&
      published.gitHead &&
      published.gitHead !== head
    ) {
      throw new Error(`${tag} was published from a different commit`);
    }
    if (published !== null && published.gitHead !== head && !selected.has(tag)) {
      // Historical publications stay associated with their original revision. Legacy v* tags
      // remain untouched; a missing gitHead cannot prove that a publication belongs to HEAD.
      if (published.gitHead && tagged && published.gitHead !== tagged) {
        throw new Error(`${tag} does not match the published revision`);
      }
      continue;
    }
    if (tagged !== null && tagged !== head) {
      throw new Error(`${tag} already points to a different commit`);
    }
    plan.push({ ...pkg, tag, publish: published === null });
  }
  return plan;
}

/** Preflight the whole plan before any publication; every completed step is safe to retry. */
export async function releasePackages(packages, head, operations, recorded) {
  const plan = await planReleases(packages, head, operations, recorded);
  if (plan.some((pkg) => pkg.publish)) await operations.publish();
  for (const pkg of plan) {
    const published = await operations.published(pkg);
    if (published === null)
      throw new Error(`${pkg.tag} is not visible on npm yet; retry this revision`);
    if (published.gitHead && published.gitHead !== head) {
      throw new Error(`${pkg.tag} was published from a different commit`);
    }
    // Recheck after publication rather than allowing a concurrent tag change to be overwritten.
    const tagged = await operations.tagCommit(pkg.tag);
    if (tagged !== null && tagged !== head) {
      throw new Error(`${pkg.tag} already points to a different commit`);
    }
    await operations.pushTag(pkg.tag, head, tagged !== null);
    if (!(await operations.releaseExists(pkg.tag))) await operations.createRelease(pkg.tag);
  }
  return plan;
}

function run(command, args) {
  return execFileSync(command, args, { encoding: "utf8" }).trim();
}

function optionalGitRef(ref) {
  try {
    return run("git", ["rev-parse", "--verify", `${ref}^{commit}`]);
  } catch (error) {
    if (error.status === 128) return null;
    throw error;
  }
}

async function published(pkg) {
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}`,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`npm lookup for ${pkg.name} failed: HTTP ${response.status}`);
  const metadata = await response.json();
  if (
    metadata.name !== pkg.name ||
    metadata.version !== pkg.version ||
    (metadata.gitHead !== undefined && typeof metadata.gitHead !== "string")
  ) {
    throw new Error(`Invalid npm metadata for ${pkg.name}@${pkg.version}`);
  }
  return metadata;
}

async function main() {
  const mode = process.argv[2];
  if (!["--plan", "--prepare", "--execute"].includes(mode)) {
    throw new Error(
      "Use --plan for a read-only plan; --prepare/--execute are reserved for release.yml",
    );
  }
  const head = run("git", ["rev-parse", "HEAD"]);
  if (
    mode !== "--plan" &&
    (process.env.GITHUB_ACTIONS !== "true" ||
      process.env.GITHUB_REF_NAME !== "main" ||
      process.env.GITHUB_SHA !== head)
  ) {
    throw new Error("Publication must run from the reviewed main revision in GitHub Actions");
  }
  const packages = readdirSync("packages")
    .sort()
    .map((directory) => JSON.parse(readFileSync(`packages/${directory}/package.json`, "utf8")));
  const operations = {
    published,
    tagCommit: async (tag) => optionalGitRef(`refs/tags/${tag}`),
    publish: async () => {
      execFileSync("pnpm", ["-r", "publish", "--provenance", "--no-git-checks"], {
        stdio: "inherit",
      });
    },
    pushTag: async (tag, revision, exists) => {
      if (!exists) run("git", ["tag", tag, revision]);
      run("git", ["push", "origin", `refs/tags/${tag}`]);
    },
    releaseExists: async (tag) => {
      // The complete release list distinguishes absence from authentication or transport failure.
      const releases = JSON.parse(
        run("gh", ["api", "--paginate", "--slurp", "repos/{owner}/{repo}/releases?per_page=100"]),
      ).flat();
      return releases.some((release) => release.tag_name === tag);
    },
    createRelease: async (tag) => {
      run("gh", ["release", "create", tag, "--verify-tag", "--title", tag, "--generate-notes"]);
    },
  };
  const planPath = ".release/plan.json";
  const recorded = existsSync(planPath) ? JSON.parse(readFileSync(planPath, "utf8")) : undefined;
  if (mode === "--execute" && recorded === undefined) {
    throw new Error("Prepare and persist the release plan before publishing");
  }
  const plan =
    mode === "--execute"
      ? await releasePackages(packages, head, operations, recorded)
      : await planReleases(packages, head, operations, recorded);
  if (mode === "--prepare") {
    mkdirSync(".release", { recursive: true });
    writeFileSync(
      planPath,
      JSON.stringify(
        { head, packages: plan.map(({ name, version }) => ({ name, version })) },
        null,
        2,
      ) + "\n",
    );
  }
  console.log(
    JSON.stringify(
      plan.map(({ name, version, tag, publish }) => ({ name, version, tag, publish })),
      null,
      2,
    ),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
