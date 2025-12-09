import express, { type Request, Response, NextFunction } from "express";
import cors from "cors";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";
import { startScheduler } from "./scheduler";
import { testConnection } from "./db";

const app = express();

const allowedOrigins = [
  "https://jewelhuntrix.netlify.app", // ✅ juiste Netlify-frontend
  "http://localhost:5173",            // voor lokale dev
  "https://vintedgemhuntrix.onrender.com" // optioneel: backend zelf
];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        console.error("❌ CORS blocked:", origin);
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }
      if (logLine.length > 80) logLine = logLine.slice(0, 79) + "…";
      log(logLine);
    }
  });

  next();
});

(async () => {
  const server = await registerRoutes(app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";
    res.status(status).json({ message });
    throw err;
  });

  const isRender = !!process.env.RENDER;

  if (!isRender && app.get("env") === "development") {
    await setupVite(app, server);
  } else if (!isRender) {
    serveStatic(app);
  } else {
    log("Render environment detected — serving backend only (no frontend build).");
  }

  const port = parseInt(process.env.PORT || "5000", 10);
  server.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    async () => {
      log(`🚀 Serving on port ${port}`);
      
      // Test database connection on startup
      log("🔍 Testing database connection...");
      const dbConnected = await testConnection();
      if (!dbConnected) {
        log("❌ Database connection failed! Data persistence will not work.");
      } else {
        log("✅ Database connection successful!");
      }
      
      startScheduler();
    }
  );
})();
