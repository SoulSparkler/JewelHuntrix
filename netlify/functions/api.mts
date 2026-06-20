// Netlify catch-all function — proxies all /api/* requests through the existing
// Express app so the dashboard works without a separate Render backend.
//
// serverless-http wraps Express into a single Request → Response handler that
// Netlify functions can serve. No code changes to routes.ts needed.

import serverless from "serverless-http";
import express, { type Request as ExpressRequest, Response, NextFunction } from "express";
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

app.use((err: any, _req: ExpressRequest, res: Response, _next: NextFunction) => {
  const status = err.status || err.statusCode || 500;
  const message = err.message || "Internal Server Error";
  res.status(status).json({ message });
});

// registerRoutes returns an http.Server but serverless-http only needs the app.
// We call it once at module scope (reused across warm invocations).
await registerRoutes(app);

const handler = serverless(app);

// Convert web standard Request to a Lambda-style event object because
// serverless-http tries to mutate `body` which is a read-only getter
// on the web Request API.
export default async (req: Request) => {
  const url = new URL(req.url);

  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    headers[key] = value;
  });

  // Netlify rewrites /api/* → /.netlify/functions/api/*; map back to /api/*
  const path = url.pathname.replace(/^\/.netlify\/functions\/api/, "/api");

  const body = ["GET", "HEAD"].includes(req.method) ? null : await req.text();

  const event = {
    httpMethod: req.method,
    path,
    headers,
    body,
    isBase64Encoded: false,
    queryStringParameters: Object.fromEntries(url.searchParams),
    requestContext: {},
  };

  const result: any = await handler(event, {});

  return new Response(result.body, {
    status: result.statusCode,
    headers: result.headers,
  });
};
