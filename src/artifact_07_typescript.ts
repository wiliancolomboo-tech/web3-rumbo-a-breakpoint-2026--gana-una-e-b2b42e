import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import * as dotenv from "dotenv";
import { EnterpriseNotifier, logger } from "./notifier";
import * as fs from "fs";

dotenv.config();

const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID || "Cam1no1111111111111111111111111111111111111"
);
const RPC_URL = process.env.SOLANA_RPC_URL || "http://127.0.0.1:8899";

export class CaminoWorker {
  private connection: Connection;
  private notifier: EnterpriseNotifier;

  constructor() {
    this.connection = new Connection(RPC_URL, "confirmed");
    this.notifier = new EnterpriseNotifier();
  }

  public async start(): Promise<void> {
    logger.info("Starting Camino Event Listener Daemon", {
      programId: PROGRAM_ID.toBase58(),
      rpc: RPC_URL,
    });

    // Listen to Program Logs / Events
    this.connection.onLogs(
      PROGRAM_ID,
      async (logs) => {
        if (logs.err) return;

        for (const log of logs.logs) {
          if (log.includes("ApplicationSubmittedEvent")) {
            await this.handleApplicationSubmitted(log);
          } else if (log.includes("TrancheDisbursedEvent")) {
            await this.handleTrancheDisbursed(log);
          } else if (log.includes("CampaignFundedEvent")) {
            await this.handleCampaignFunded(log);
          }
        }
      },
      "confirmed"
    );

    logger.info("Worker actively listening for Solana events...");
  }

  private async handleApplicationSubmitted(logEntry: string): Promise<void> {
    logger.info("Processing ApplicationSubmitted log", { logEntry });
    await this.notifier.sendWebhook("NEW_APPLICATION_SUBMITTED", {
      detail: "A new builder has applied for Breakpoint 2026 travel support!",
      timestamp: new Date().toISOString(),
    });
  }

  private async handleTrancheDisbursed(logEntry: string): Promise<void> {
    logger.info("Processing TrancheDisbursed log", { logEntry });
    await this.notifier.sendWebhook("TRANCHE_DISBURSED", {
      status: "USDC Funds released to applicant wallet for travel logistics.",
      timestamp: new Date().toISOString(),
    });
  }

  private async handleCampaignFunded(logEntry: string): Promise<void> {
    logger.info("Processing CampaignFunded log", { logEntry });
    await this.notifier.sendWebhook("CAMPAIGN_ESCROW_FUNDED", {
      status: "Sponsor has deposited fresh grant funds to the Camino Escrow Vault.",
      timestamp: new Date().toISOString(),
    });
  }
}

if (require.main === module) {
  const worker = new CaminoWorker();
  worker.start().catch((err) => {
    logger.error("Fatal in worker loop", { err });
    process.exit(1);
  });
}