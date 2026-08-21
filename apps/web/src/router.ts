import { createRouter, RouterHistory } from "@tanstack/react-router";

import { routeTree } from "./routeTree.gen";

// import.meta.env.BASE_URL is the Vite `base` config value: "/" for the
// live root-path build (no-op here, matching prior behavior with no
// basepath override) or e.g. "/app/" for a path-prefixed hosted build.
// TanStack Router wants a basepath with no trailing slash, or none at all.
function resolveRouterBasepath(): string | null {
  const baseUrl = import.meta.env.BASE_URL;
  if (baseUrl === "/" || baseUrl === "") {
    return null;
  }
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

export function getRouter(history: RouterHistory) {
  const basepath = resolveRouterBasepath();
  return createRouter({
    routeTree,
    history,
    context: {},
    ...(basepath === null ? {} : { basepath }),
  });
}

export type AppRouter = ReturnType<typeof getRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
