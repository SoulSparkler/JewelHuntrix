// Netlify catch-all function — proxies all /api/* requests through the existing
// Express app so the dashboard works without a separate Render backend.
//
// serverless-http wraps Express into a single Request → Response handler that
// Netlify functions can serve. No code changes to routes.ts needed.

import serverless from "serverless-http";
import express, { type Request, Response, NextFunction } from "express";
import cors from "cors";
import { registerRoutes } from "../../server/routes";

const app = express();

app.use(
  cors({
    origin: true, // Netlify handles its own origin via _redirects
    credentials: true,
  }),
);
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  const status = err.status || err.statusCode || 500;
  const message = err.message || "Internal Server Error";
  res.status(status).json({ message });
});

// registerRoutes returns an http.Server but serverless-http only needs the app.
// We call it once at module scope (reused across warm invocations).
await registerRoutes(app);

const handler = serverless(app);

export default async (req: Request) => {
  return handler(req as any, {} as any);
};
