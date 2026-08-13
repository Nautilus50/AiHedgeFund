import type { S3Client } from "@aws-sdk/client-s3";
import type { FastifyInstance } from "fastify";
import type { Database } from "@arf-os/db";
import { registerBacktestRunRoutes } from "./backtest-runs.js";
import { registerCampaignRoutes } from "./campaigns.js";
import { registerDashboardRoutes } from "./dashboard.js";
import { registerDatasetRoutes } from "./datasets.js";
import { registerForwardRoutes } from "./forward.js";
import { registerStrategyRoutes } from "./strategies.js";
import { registerVerificationRoutes } from "./verifications.js";

export interface ApiDeps {
  db: Database;
  s3: S3Client;
  bucket: string;
}

export function registerRoutes(app: FastifyInstance, deps: ApiDeps): void {
  registerBacktestRunRoutes(app, { db: deps.db });
  registerCampaignRoutes(app, { db: deps.db });
  registerDashboardRoutes(app, { db: deps.db });
  registerDatasetRoutes(app, { db: deps.db });
  registerForwardRoutes(app, { db: deps.db });
  registerStrategyRoutes(app, { db: deps.db });
  registerVerificationRoutes(app, { db: deps.db, s3: deps.s3, bucket: deps.bucket });
}
