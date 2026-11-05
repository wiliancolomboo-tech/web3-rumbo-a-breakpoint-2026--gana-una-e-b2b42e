import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { Resend } from "resend";
import axios from "axios";
import * as dotenv from "dotenv";

dotenv.config();

// Ensure all enterprise env variables exist
const RPC_ENDPOINT = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID || "RumbocFh9JvWkmFq9vY9qg8yV7qN5u8kL2vX4Xo1QWz"
);
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

if (!RESEND_API_KEY) {
  console.warn("⚠️ RESEND_API_KEY missing! Email dispatches will be simulated.");
}

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

// Minimal IDL Definition for event listener
const IDL: any = {
  version: "0.1.0",
  name: "rumbo_protocol",
  instructions: [],
  events: [
    {
      name: "FundsDisbursedEvent",
      fields: [
        { name: "applicant", type: "publicKey", index: false },
        { name: "milestoneIndex", type: "u8", index: false },
        { name: "amountDisbursed", type: "u64", index: false },
        { name: "ticketAwarded", type: "bool", index: false },
      ],
    },
    {
      name: "MilestoneProofSubmittedEvent",
      fields: [
        { name: "applicant", type: "publicKey", index: false },
        { name: "milestoneIndex", type: "u8", index: false },
        { name: "proofHash", type: { array: ["u8", 32] }, index: false },
      ],
    },
  ],
};

export class RumboEnterpriseAgent {
  private connection: Connection;
  private provider: AnchorProvider;
  private program: Program;

  constructor() {
    this.connection = new Connection(RPC_ENDPOINT, {
      commitment: "confirmed",
      wsEndpoint: RPC_ENDPOINT.replace("https://", "wss://"),
    });

    // Read-only ephemeral wallet for event listening
    const dummyKey = Keypair.generate();
    const wallet = new Wallet(dummyKey);
    this.provider = new AnchorProvider(this.connection, wallet, {
      commitment: "confirmed",
    });
    this.program = new Program(IDL, PROGRAM_ID, this.provider);
  }

  public async start(): Promise<void> {
    console.log("=====================================================");
    console.log("🚀 Rumbo a Breakpoint 2026 Enterprise Agent Running");
    console.log(`📍 RPC Target: ${RPC_ENDPOINT}`);
    console.log(`📜 Monitoring Program: ${PROGRAM_ID.toBase58()}`);
    console.log("=====================================================");

    this.program.addEventListener(
      "MilestoneProofSubmittedEvent",
      async (event: any, slot: number, signature: string) => {
        await this.handleMilestoneProof(event, signature);
      }
    );

    this.program.addEventListener(
      "FundsDisbursedEvent",
      async (event: any, slot: number, signature: string) => {
        await this.handleFundsDisbursed(event, signature);
      }
    );
  }

  private async handleMilestoneProof(event: any, signature: string): Promise<void> {
    const applicant = event.applicant.toBase58();
    const milestoneIdx = event.milestoneIndex;
    const proofHex = Buffer.from(event.proofHash).toString("hex");

    console.log(`\n🔔 [EVENT] New Proof Submitted for Milestone #${milestoneIdx}`);
    console.log(`Applicant: ${applicant}`);
    console.log(`Proof SHA: ${proofHex}`);

    // Dispatch Discord Ops Alert
    await this.notifyDiscord({
      title: "📋 Milestone Proof Submitted - Rumbo a Breakpoint",
      color: 0x3b82f6, // Blue
      fields: [
        { name: "Applicant", value: `\`${applicant}\``, inline: true },
        { name: "Milestone", value: `#${milestoneIdx + 1}`, inline: true },
        { name: "Proof Hash", value: `\`${proofHex.slice(0, 16)}...\``, inline: false },
        {
          name: "Solana Explorer",
          value: `[View Transaction](https://explorer.solana.com/tx/${signature}?cluster=devnet)`,
        },
      ],
      timestamp: new Date().toISOString(),
    });
  }

  private async handleFundsDisbursed(event: any, signature: string): Promise<void> {
    const applicant = event.applicant.toBase58();
    const milestoneIdx = event.milestoneIndex;
    const amountUSDC = (Number(event.amountDisbursed) / 1_000_000).toFixed(2);
    const ticketAwarded = event.ticketAwarded;

    console.log(`\n💰 [EVENT] Funds Disbursed: $${amountUSDC} USDC to ${applicant}`);

    // 1. Post to Discord Channel
    await this.notifyDiscord({
      title: ticketAwarded
        ? "🎟️ BREAKPOINT 2026 TICKET & GRANT UNLOCKED!"
        : "💸 Travel Stipend Disbursed!",
      color: ticketAwarded ? 0x10b981 : 0xf59e0b, // Green or Amber
      fields: [
        { name: "Recipient", value: `\`${applicant}\``, inline: true },
        { name: "Disbursement", value: `$${amountUSDC} USDC`, inline: true },
        { name: "Milestone Cleared", value: `Gate ${milestoneIdx + 1}/3`, inline: true },
        {
          name: "Ticket Confirmed",
          value: ticketAwarded ? "✅ Breakpoint 2026 Pass Granted" : "⏳ Pending Final Gate",
        },
        {
          name: "Proof of Payment",
          value: `[View on Explorer](https://explorer.solana.com/tx/${signature}?cluster=devnet)`,
        },
      ],
      timestamp: new Date().toISOString(),
    });

    // 2. Dispatch High-Deliverability Email via Resend
    await this.sendEmailNotification(applicant, amountUSDC, ticketAwarded, signature);
  }

  private async notifyDiscord(embed: object): Promise<void> {
    if (!DISCORD_WEBHOOK_URL) return;
    try {
      await axios.post(DISCORD_WEBHOOK_URL, {
        username: "Rumbo Breakpoint Bot",
        avatar_url: "https://solana.com/src/img/branding/solanaLogoMark.png",
        embeds: [embed],
      });
    } catch (err: any) {
      console.error("❌ Failed to push Discord webhook:", err.message);
    }
  }

  private async sendEmailNotification(
    recipientWallet: string,
    amountUSDC: string,
    ticketAwarded: boolean,
    txSignature: string
  ): Promise<void> {
    if (!resend) {
      console.log(`[DRY-RUN RESEND] Simulated email to wallet contact: ${recipientWallet}`);
      return;
    }

    const recipientEmail = process.env.OPS_NOTIFICATION_EMAIL || "grants@solana.org";

    const emailSubject = ticketAwarded
      ? "🎉 ¡Felicidades! Tu Entrada a Breakpoint 2026 y Apoyo de Viaje están Listos"
      : `✈️ Rumbo a Breakpoint: Pago de $${amountUSDC} USDC Liberado`;

    const htmlContent = `
      <div style="font-family: Arial, sans-serif; background-color: #0b0e14; color: #ffffff; padding: 30px; border-radius: 10px;">
        <h1 style="color: #14f195;">Rumbo a Breakpoint 2026</h1>
        <p>Hola dev,</p>
        <p>Se ha verificado tu hito satisfactoriamente y los fondos han sido liberados en Solana:</p>
        <div style="background-color: #1b1f2b; padding: 20px; border-left: 4px solid #9945ff; margin: 20px 0;">
          <p><strong>Monto:</strong> $${amountUSDC} USDC</p>
          <p><strong>Billetera Receptora:</strong> ${recipientWallet}</p>
          <p><strong>Transacción On-Chain:</strong> <a href="https://explorer.solana.com/tx/${txSignature}?cluster=devnet" style="color: #00c2ff;">Ver en Solana Explorer</a></p>
          ${
            ticketAwarded
              ? '<p style="color: #14f195; font-weight: bold;">🎟️ ¡Tu entrada general a Breakpoint 2026 ha sido reservada con éxito!</p>'
              : ""
          }
        </div>
        <p>Asegúrate de reservar tus vuelos y subir tu comprobante para el siguiente desembolso.</p>
        <br/>
        <p style="font-size: 12px; color: #888;">Solana Latin America Developer Fellowship &bull; Breakpoint 2026</p>
      </div>
    `;

    try {
      await resend.emails.send({
        from: "Rumbo a Breakpoint <onboarding@resend.dev>",
        to: recipientEmail,
        subject: emailSubject,
        html: htmlContent,
      });
      console.log(`📧 Transactional confirmation email dispatched to ${recipientEmail}`);
    } catch (error: any) {
      console.error("❌ Resend error:", error.message);
    }
  }
}

// Start daemon if executed directly
if (require.main === module) {
  const agent = new RumboEnterpriseAgent();
  agent.start().catch((err) => {
    console.error("Fatal agent error:", err);
    process.exit(1);
  });
}