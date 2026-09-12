import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

/** `initial` publishes the current version; the others bump it first. */
const RELEASE_TYPES = ["initial", "major", "minor", "patch"] as const;
type ReleaseType = (typeof RELEASE_TYPES)[number];

interface PackageManifest {
  name: string;
  version: string;
}

interface ReleaseOptions {
  dryRun: boolean;
  releaseType: ReleaseType;
  yes: boolean;
}

async function main(): Promise<void> {
  process.chdir(fileURLToPath(new URL("..", import.meta.url)));
  const options = parseArguments(process.argv.slice(2));
  const manifest = await readManifest();
  const nextVersion =
    options.releaseType === "initial"
      ? manifest.version
      : incrementVersion(manifest.version, options.releaseType);
  const tag = `v${nextVersion}`;

  console.log(
    options.releaseType === "initial"
      ? `Preparing first release: ${manifest.name} ${nextVersion}`
      : `Preparing ${options.releaseType} release: ${manifest.name} ${manifest.version} -> ${nextVersion}`,
  );

  const releaseBranch = ensureReleaseBranch();
  ensureCleanWorkingTree("The working tree must be clean before releasing.");

  run("git", ["fetch", "origin", "--prune"]);
  ensureLocalBranchMatchesUpstream();
  ensureTagDoesNotExist(tag);
  ensureNpmAuthentication();
  ensureRegistryVersion(manifest.name, manifest.version, options.releaseType);

  run("bun", ["run", "lint"]);
  // Vitest through the package script; `bun test` would use Bun's runner.
  run("bun", ["run", "test"]);
  run("npm", ["pack", "--dry-run"]);
  ensureCleanWorkingTree(
    "Release checks modified tracked files. Review and commit those changes before releasing.",
  );

  if (options.dryRun) {
    console.log(
      `Dry run completed. ${manifest.name} is ready for ${tag}; no version, tag, push, or publish was created.`,
    );
    return;
  }

  await confirmRelease(manifest.name, nextVersion, options.yes);
  ensurePushWillSucceed(releaseBranch);

  if (options.releaseType === "initial") {
    run("git", ["tag", "-a", tag, "-m", `Release ${tag}`]);
  } else {
    run("npm", ["version", options.releaseType, "-m", "Release v%s"]);
  }
  ensureCreatedVersion(nextVersion, tag);

  try {
    run("git", ["push", "origin", releaseBranch, "--follow-tags"]);
  } catch (error) {
    throw new Error(
      `${tag} exists locally, but the push failed. Nothing was published to npm. Fix the push problem, then push the current branch and tag manually.`,
      { cause: error },
    );
  }

  try {
    run("npm", ["publish", "--access", "public"]);
  } catch (error) {
    throw new Error(
      `${tag} was pushed, but npm publication failed. Do not create another version. Resolve the npm error and retry: npm publish --access public`,
      { cause: error },
    );
  }

  await verifyPublishedVersion(manifest.name, nextVersion);
  console.log(`Published ${manifest.name}@${nextVersion} and pushed ${tag}.`);
}

function parseArguments(args: string[]): ReleaseOptions {
  const normalized = args.filter((argument) => argument !== "--");
  if (normalized.includes("--help") || normalized.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  const releaseTypes = normalized.filter((argument): argument is ReleaseType =>
    RELEASE_TYPES.includes(argument as ReleaseType),
  );
  const unknown = normalized.filter(
    (argument) =>
      !RELEASE_TYPES.includes(argument as ReleaseType) &&
      argument !== "--dry-run" &&
      argument !== "--yes" &&
      argument !== "-y",
  );

  if (releaseTypes.length !== 1 || unknown.length > 0) {
    printUsage();
    throw new Error(
      unknown.length > 0
        ? `Unknown argument(s): ${unknown.join(", ")}`
        : "Specify exactly one release type: initial, major, minor, or patch.",
    );
  }

  return {
    dryRun: normalized.includes("--dry-run"),
    releaseType: releaseTypes[0] as ReleaseType,
    yes: normalized.includes("--yes") || normalized.includes("-y"),
  };
}

function printUsage(): void {
  console.log(`Usage: bun run release -- <initial|major|minor|patch> [options]

Release types:
  initial         Publish the version already in package.json. Only valid
                  while the package does not exist on npm.
  major/minor/patch
                  Bump package.json with npm version, then publish.

Options:
  --dry-run       Run all preflight checks without changing or publishing anything.
  --yes, -y       Skip the interactive release confirmation.
  --help, -h      Show this help.

Examples:
  bun run release -- initial --dry-run
  bun run release -- patch
  bun run release -- minor --yes`);
}

async function readManifest(): Promise<PackageManifest> {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as Partial<PackageManifest>;
  if (!manifest.name || !manifest.version) {
    throw new Error("package.json must contain name and version fields.");
  }
  return { name: manifest.name, version: manifest.version };
}

function incrementVersion(version: string, releaseType: ReleaseType): string {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    throw new Error(
      `Unsupported package version ${version}; expected a stable x.y.z version.`,
    );
  }

  const major = Number.parseInt(match[1] || "", 10);
  const minor = Number.parseInt(match[2] || "", 10);
  const patch = Number.parseInt(match[3] || "", 10);

  if (releaseType === "major") return `${major + 1}.0.0`;
  if (releaseType === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function ensureReleaseBranch(): string {
  const branch = capture("git", ["branch", "--show-current"]);
  if (branch !== "main" && branch !== "master") {
    throw new Error(
      `Releases must run from main or master; current branch is ${branch || "detached HEAD"}.`,
    );
  }
  return branch;
}

function ensureCleanWorkingTree(message: string): void {
  if (capture("git", ["status", "--porcelain"])) throw new Error(message);
}

function ensureLocalBranchMatchesUpstream(): void {
  let upstream: string;
  try {
    upstream = capture("git", [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{upstream}",
    ]);
  } catch (error) {
    throw new Error("The release branch must have a configured upstream.", {
      cause: error,
    });
  }

  const localHead = capture("git", ["rev-parse", "HEAD"]);
  const upstreamHead = capture("git", ["rev-parse", upstream]);
  if (localHead !== upstreamHead) {
    throw new Error(
      `Local HEAD must exactly match ${upstream} before releasing. Pull or push pending commits first.`,
    );
  }
}

function ensureTagDoesNotExist(tag: string): void {
  const localTag = capture("git", ["tag", "--list", tag]);
  const remoteTag = capture("git", [
    "ls-remote",
    "--tags",
    "origin",
    `refs/tags/${tag}`,
  ]);
  if (localTag || remoteTag) {
    throw new Error(`Release tag ${tag} already exists.`);
  }
}

function ensureNpmAuthentication(): void {
  try {
    const user = capture("npm", ["whoami"]);
    console.log(`npm authenticated as ${user}.`);
  } catch (error) {
    throw new Error("npm authentication failed. Run npm login, then retry.", {
      cause: error,
    });
  }
}

/** Reads the published version, or undefined when the package is unknown. */
function readRegistryVersion(packageName: string): string | undefined {
  try {
    const output = capture("npm", ["view", packageName, "version", "--json"]);
    const version = parseJsonOutput(output);
    return typeof version === "string" ? version : undefined;
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    const details = [
      error instanceof Error ? error.message : String(error),
      typeof stderr === "string" ? stderr : "",
    ].join("\n");
    if (details.includes("E404") || details.includes("404 Not Found")) {
      return undefined;
    }
    throw new Error(`Could not read ${packageName} from npm.`, {
      cause: error,
    });
  }
}

function ensureRegistryVersion(
  packageName: string,
  localVersion: string,
  releaseType: ReleaseType,
): void {
  const publishedVersion = readRegistryVersion(packageName);
  if (publishedVersion === undefined) {
    if (releaseType !== "initial") {
      throw new Error(
        `${packageName} is not on npm yet. Use "bun run release -- initial" to publish ${localVersion}.`,
      );
    }
    console.log(
      `${packageName} is not on npm yet; publishing ${localVersion}.`,
    );
    return;
  }
  if (releaseType === "initial") {
    throw new Error(
      `${packageName}@${publishedVersion} is already on npm. Use major, minor, or patch instead of initial.`,
    );
  }
  if (publishedVersion !== localVersion) {
    throw new Error(
      `Local package version ${localVersion} does not match npm version ${publishedVersion}. Synchronize the repository before releasing.`,
    );
  }
}

function ensurePushWillSucceed(branch: string): void {
  run("git", ["push", "--dry-run", "origin", branch]);
}

function ensureCreatedVersion(version: string, tag: string): void {
  const manifestVersion = parseJsonOutput(
    capture("node", [
      "-p",
      "JSON.stringify(require('./package.json').version)",
    ]),
  );
  if (manifestVersion !== version) {
    throw new Error(
      `Expected package.json to be at ${version}, found ${String(manifestVersion)}.`,
    );
  }
  if (capture("git", ["tag", "--list", tag]) !== tag) {
    throw new Error(`The expected ${tag} tag was not created.`);
  }
  ensureCleanWorkingTree("Versioning left unexpected uncommitted changes.");
}

async function confirmRelease(
  packageName: string,
  version: string,
  skipConfirmation: boolean,
): Promise<void> {
  if (skipConfirmation) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "Interactive confirmation requires a TTY. Pass --yes to continue non-interactively.",
    );
  }

  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await readline.question(
      `Release ${packageName}@${version}, push its tag, and publish to npm? [y/N] `,
    );
    if (!/^y(?:es)?$/i.test(answer.trim())) {
      throw new Error("Release cancelled.");
    }
  } finally {
    readline.close();
  }
}

async function verifyPublishedVersion(
  packageName: string,
  version: string,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      const publishedVersion = parseJsonOutput(
        capture("npm", [
          "view",
          `${packageName}@${version}`,
          "version",
          "--json",
        ]),
      );
      const distTags = parseJsonOutput(
        capture("npm", ["view", packageName, "dist-tags", "--json"]),
      ) as Record<string, unknown>;
      if (publishedVersion === version && distTags.latest === version) return;
      lastError = new Error(
        `Registry returned version=${String(publishedVersion)} latest=${String(distTags.latest)}.`,
      );
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(
    `npm publication completed, but registry verification for ${packageName}@${version} did not converge. Check npm manually.`,
    { cause: lastError },
  );
}

function run(command: string, args: string[]): void {
  console.log(`\n$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited with status ${String(result.status)}.`,
    );
  }
}

function capture(command: string, args: string[]): string {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function parseJsonOutput(output: string): unknown {
  return JSON.parse(output) as unknown;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
