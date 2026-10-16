// The running build's identity, shown at the bottom of Settings. The version
// is package.json's, bumped only when a release is cut (vYYYY.M.N tag, see
// .github/workflows/docker-publish.yml); every push to main between releases
// still builds :latest, so the commit is shown too — "2026.10.1" alone would
// misdescribe a build that's three commits past that release.
import pkg from "../../package.json";

export const APP_VERSION: string = pkg.version;

export const RELEASES_URL = "https://github.com/jbuxxy/flow/releases";

// Short commit of this image (FLOW_BUILD_SHA, a Docker build arg), or null
// for a local/dev build that wasn't given one.
export function appBuildCommit(): string | null {
  const sha = process.env.FLOW_BUILD_SHA?.trim();
  return sha ? sha.slice(0, 7) : null;
}
