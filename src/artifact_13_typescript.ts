import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { Resend } from "resend";
import axios from "axios";
import * as dotenv from "dotenv";
import * as fs from "fs";

dotenv.config();

// Contract IDL placeholder definition for strong typing
const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID || "RumboxQx6Zt3K6m1pB4uTfV2YvN8WpZ9cDeFgHjK1Mn"
);

const RESEND_API_KEY = process.env.RESEND_API_KEY || "re_test_dummy_key";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const RPC_ENDPOINT = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

const resend = new Resend(RESEND_API_KEY);

interface MilestoneApprovedEventPayload {
  campaign: PublicKey;
  scholar: PublicKey;
  milestonesApproved: number;
  totalMilestones: number;
  isFullyVerified: boolean;
}

interface StipendDisbursedEventPayload {
  campaign: PublicKey;
  scholar: PublicKey;
  amount: anchor.BN;
  timestamp: anchor.BN;
}

export class RumboOrchestrator {
  private connection: Connection;
  private program: Program;

  constructor(keypairPath?: string) {
    this.connection = new Connection(RPC_ENDPOINT, {
      commitment: "confirmed",
      wsEndpoint: RPC_ENDPOINT.replace("https://", "wss://").replace("http://", "ws://"),
    });

    let walletKeypair: Keypair;
    if (keypairPath && fs.existsSync(keypairPath)) {
      const secret = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
      walletKeypair = Keypair.fromSecretKey(new Uint8Array(secret));
    } else {
      walletKeypair = Keypair.generate();
    }

    const wallet = new anchor.Wallet(walletKeypair);
    const provider = new anchor.AnchorProvider(this.connection, wallet, {
      commitment: "confirmed",
    });
    anchor.setProvider(provider);

    // Load IDL directly
    const idl = JSON.parse(
      fs.readFileSync("./target/idl/rumbo_protocol.json", "utf8")
    );
    this.program = new Program(idl, provider);
  }

  public async startListener(): Promise<void> {
    console.log(`[RUMBO AGENT] Active and listening on Program: ${PROGRAM_ID.toBase58()}`);
    console.log(`[RPC WORKER] Connected to: ${RPC_ENDPOINT}`);

    // Listen to MilestoneApprovedEvent
    this.program.addEventListener(
      "MilestoneApprovedEvent",
      async (event: any, slot: number, signature: string) => {
        const payload = event as MilestoneApprovedEventPayload;
        console.log(
          `\n[EVENT CAUGHT] MilestoneApproved at slot ${slot} | Sig: ${signature}`
        );
        console.log(`Scholar: ${payload.scholar.toBase58()}`);
        console.log(`Milestone Status: ${payload.milestonesApproved}/${payload.totalMilestones}`);

        await this.handleMilestoneApproval(payload, signature);
      }
    );

    // Listen to StipendDisbursedEvent
    this.program.addEventListener(
      "StipendDisbursedEvent",
      async (event: any, slot: number, signature: string) => {
        const payload = event as StipendDisbursedEventPayload;
        console.log(
          `\n[EVENT CAUGHT] StipendDisbursed at slot ${slot} | Sig: ${signature}`
        );
        console.log(`Disbursed to: ${payload.scholar.toBase58()} | Amount: ${payload.amount.toString()}`);

        await this.handleStipendDisbursed(payload, signature);
      }
    );
  }

  private async handleMilestoneApproval(
    event: MilestoneApprovedEventPayload,
    txSignature: string
  ): Promise<void> {
    const explorerLink = `https://explorer.solana.com/tx/${txSignature}?cluster=devnet`;

    // 1. Post to Discord / Slack Operational Ops
    if (DISCORD_WEBHOOK_URL) {
      try {
        await axios.post(DISCORD_WEBHOOK_URL, {
          embeds: [
            {
              title: event.isFullyVerified
                ? "🎉 Rumbo a Breakpoint 2026: Scholar Fully Qualified!"
                : "⚡ Rumbo a Breakpoint 2026: Milestone Approved",
              color: event.isFullyVerified ? 0x14f195 : 0x9945ff,
              fields: [
                { name: "Scholar Pubkey", value: `\`${event.scholar.toBase58()}\``, inline: false },
                { name: "Progress", value: `${event.milestonesApproved} / ${event.totalMilestones} Milestones`, inline: true },
                { name: "Ticket Granted", value: event.isFullyVerified ? "✅ Breakpoint 2026 Access PASS" : "⏳ Pending Final Milestone", inline: true },
                { name: "Transaction", value: `[View on Explorer](${explorerLink})`, inline: false },
              ],
              footer: { text: "Rumbo Protocol • Solana Breakpoint Automation" },
              timestamp: new Date().toISOString(),
            },
          ],
        });
        console.log("[AUDIT LOG] Operational alert successfully dispatched to Discord.");
      } catch (err: any) {
        console.error("[ERROR] Discord alert dispatch failed:", err.message);
      }
    }

    // 2. Dispatch Enterprise Email via Resend if fully qualified
    if (event.isFullyVerified && RESEND_API_KEY && !RESEND_API_KEY.includes("dummy")) {
      try {
        await resend.emails.send({
          from: "Rumbo Protocol <grants@solanabreakpoint.org>",
          to: "scholar-notifications@gmail.com", // Dynamic look-up in production DB
          subject: "✈️ Rumbo a Breakpoint 2026: Has ganado tu entrada y beca de viaje!",
          html: `
            <div style="font-family: Arial, sans-serif; background: #0b0e14; color: #ffffff; padding: 24px; border-radius: 8px;">
              <h1 style="color: #14f195;">¡Felicitaciones, Scholar!</h1>
              <p>Tu progreso de desarrollo y milestones han sido verificados criptográficamente en Solana.</p>
              <div style="background: #1a1f2c; padding: 16px; border-left: 4px solid #9945ff; margin: 16px 0;">
                <p><strong>Entrada Breakpoint 2026:</strong> Acreditada (Acceso Total)</p>
                <p><strong>Beca de Viaje:</strong> Habilitada para reclamo inmediato on-chain</p>
                <p><strong>Firma de Verificación:</strong> <code>${txSignature}</code></p>
              </div>
              <p>Para transferir tus fondos de viaje en USDC a tu wallet, ejecuta la instrucción de retiro en nuestra DApp o CLI.</p>
              <a href="https://rumbo.solana.com/claim" style="display:inline-block; background:#14f195; color:#000; padding:12px 24px; font-weight:bold; text-decoration:none; border-radius:4px;">Reclamar Beca de Viaje</a>
            </div>
          `,
        });
        console.log("[RESEND] Grant confirmation email sent to scholar.");
      } catch (err: any) {
        console.error("[ERROR] Resend dispatch failed:", err.message);
      }
    }
  }

  private async handleStipendDisbursed(
    event: StipendDisbursedEventPayload,
    txSignature: string
  ): Promise<void> {
    console.log(`[SETTLEMENT] Successfully registered USDC disbursement of ${event.amount.toString()} base units.`);
  }
}

// Direct Execution Entrypoint
if (require.main === module) {
  const agent = new RumboOrchestrator(process.env.ANCHOR_WALLET);
  agent.startListener().catch((err) => {
    console.error("[FATAL ERROR] Daemon collapsed:", err);
    process.exit(1);
  });
}