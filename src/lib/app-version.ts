// The running build's identity, shown at the bottom of Settings. The version
// is the release tag's (FLOW_VERSION, a Docker build arg — the nightly
// release in .github/workflows/release.yml tags without bumping
// package.json; a main build gets the latest release's), falling back to
// package.json's for a local build. Every push to main between releases
// still builds :latest, so the commit is shown too — "2026.10.1" alone would
// misdescribe a build that's three commits past that release.
import pkg from "../../package.json";

export const APP_VERSION: string = process.env.FLOW_VERSION?.trim() || pkg.version;

export const RELEASES_URL = "https://github.com/jbuxxy/flow/releases";

// Short commit of this image (FLOW_BUILD_SHA, a Docker build arg), or null
// for a local/dev build that wasn't given one.
export function appBuildCommit(): string | null {
  const sha = process.env.FLOW_BUILD_SHA?.trim();
  return sha ? sha.slice(0, 7) : null;
}
