import type { S3Client } from "@aws-sdk/client-s3";
import type { FastifyInstance } from "fastify";
import type { Database } from "@arf-os/db";
import { registerBacktestRunRoutes } from "./backtest-runs.js";
import { registerCampaignRoutes } from "./campaigns.js";
import { registerCommitteeQueueRoutes } from "./committee-queue.js";
import { registerDashboardRoutes } from "./dashboard.js";
import { registerDatasetRoutes } from "./datasets.js";
import { registerForwardRoutes } from "./forward.js";
import { registerOperationsRoutes } from "./operations.js";
import { registerPortfolioResearchRoutes } from "./portfolio-research.js";
import { registerPracticeArenaRoutes } from "./practice-arena.js";
import { registerResearchTaskRoutes } from "./research-tasks.js";
import { registerSseRoutes } from "./sse.js";
import { registerStorefrontAdminRoutes } from "./storefront-admin.js";
import { registerStorefrontCustomerRoutes } from "./storefront-customer.js";
import { registerStorefrontPublicRoutes } from "./storefront-public.js";
import { registerStrategyRoutes } from "./strategies.js";
import { registerVerificationRoutes } from "./verifications.js";
import type { SseHub } from "../lib/sse-hub.js";
import type { BillingProvider } from "../services/storefront/billing-provider.js";

export interface ApiDeps {
  db: Database;
  s3: S3Client;
  bucket: string;
  sseHub: SseHub;
  billing: BillingProvider;
}

export function registerRoutes(app: FastifyInstance, deps: ApiDeps): void {
  registerBacktestRunRoutes(app, { db: deps.db });
  registerCampaignRoutes(app, { db: deps.db });
  registerCommitteeQueueRoutes(app, { db: deps.db });
  registerDashboardRoutes(app, { db: deps.db });
  registerDatasetRoutes(app, { db: deps.db });
  registerForwardRoutes(app, { db: deps.db });
  registerOperationsRoutes(app, { db: deps.db });
  registerPortfolioResearchRoutes(app, { db: deps.db });
  registerPracticeArenaRoutes(app, { db: deps.db });
  registerResearchTaskRoutes(app, { db: deps.db });
  registerSseRoutes(app, { db: deps.db, sseHub: deps.sseHub });
  registerStorefrontAdminRoutes(app, { db: deps.db });
  registerStorefrontCustomerRoutes(app, { db: deps.db, billing: deps.billing });
  registerStorefrontPublicRoutes(app, { db: deps.db });
  registerStrategyRoutes(app, { db: deps.db });
  registerVerificationRoutes(app, { db: deps.db, s3: deps.s3, bucket: deps.bucket });
}
