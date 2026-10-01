import type { IncomingMessage, ServerResponse } from "node:http";

// Development only: Vite as middleware inside the app server. Imported
// dynamically so the production image never needs Vite installed.
export async function createViteMiddleware(root: string) {
  const { createServer } = await import("vite");
  const vite = await createServer({
    root,
    appType: "spa",
    server: { middlewareMode: true },
  });
  return (req: IncomingMessage, res: ServerResponse, next: () => void) => vite.middlewares(req, res, next);
}
