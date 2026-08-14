// Projects registered in the LateShift Files signature viewer
// (lateshift-files repo, server/projects.mjs). Keys are matched against the
// project name and the basename of the project cwd, lowercased.
const FILE_VIEWER_SLUGS: Readonly<Record<string, string>> = {
  "skyjourney-cloud": "skyjourney-cloud",
  skyjourney: "skyjourney-cloud",
  carball: "carball",
  "ronopoly-game": "ronopoly-game",
  "ronopoly-menu": "ronopoly-menu",
};

const FILE_VIEWER_BASE_URL = "https://lateshiftcloud.com/files/";

export function fileViewerUrlForProject(
  projectName: string | undefined,
  projectCwd: string | null,
): string | null {
  const candidates = [projectName, projectCwd?.split(/[\\/]/).filter(Boolean).at(-1)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const slug = FILE_VIEWER_SLUGS[candidate.trim().toLowerCase()];
    if (slug) return `${FILE_VIEWER_BASE_URL}${slug}`;
  }
  return null;
}
