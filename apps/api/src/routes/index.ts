import type { S3Client } from "@aws-sdk/client-s3";
import type { FastifyInstance } from "fastify";
import type { Database } from "@arf-os/db";
import type { WorkflowService } from "@arf-os/workflow";
import { registerCampaignRoutes } from "./campaigns.js";
import { registerStrategyRoutes } from "./strategies.js";
import { registerVerificationRoutes } from "./verifications.js";

export interface ApiDeps {
  db: Database;
  s3: S3Client;
  bucket: string;
  workflow: WorkflowService;
}

export function registerRoutes(app: FastifyInstance, deps: ApiDeps): void {
  registerCampaignRoutes(app, { db: deps.db });
  registerStrategyRoutes(app, { db: deps.db, workflow: deps.workflow });
  registerVerificationRoutes(app, { db: deps.db, s3: deps.s3, bucket: deps.bucket });
}
