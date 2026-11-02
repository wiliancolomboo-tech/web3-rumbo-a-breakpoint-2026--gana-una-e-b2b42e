import * as anchor from "@coral-xyz/anchor";
import { Program, Idl } from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { Resend } from "resend";
import axios from "axios";
import * as dotenv from "dotenv";
import * as crypto from "crypto";
import fs from "fs";

dotenv.config();

// Configuration & Environment Bounds
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID || "RumbobREAk202611111111111111111111111111111"
);
const RESEND_API_KEY = process.env.RESEND_API_KEY || "re_test_key_123456789";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const KEYPAIR_PATH = process.env.KEYPAIR_PATH || "./authority-keypair.json";

// Initialize Enterprise Clients
const resend = new Resend(RESEND_API_KEY);
const connection = new Connection(RPC_URL, "confirmed");

// Load Operator Authority Keypair
let authorityKeypair: Keypair;
if (fs.existsSync(KEYPAIR_PATH)) {
  const secret = JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf-8"));
  authorityKeypair = Keypair.fromSecretKey(new Uint8Array(secret));
} else {
  authorityKeypair = Keypair.generate();
  fs.writeFileSync(KEYPAIR_PATH, JSON.stringify(Array.from(authorityKeypair.secretKey)));
}

const wallet = new anchor.Wallet(authorityKeypair);
const provider = new anchor.AnchorProvider(connection, wallet, {
  commitment: "confirmed",
  preflightCommitment: "confirmed",
});
anchor.setProvider(provider);

export class RumboOrchestrator {
  private program: Program;

  constructor(idl: Idl) {
    this.program = new Program(idl, provider);
  }

  /**
   * Publishes critical protocol updates to Superteam LATAM channels
   */
  public async notifyDiscord(title: string, description: string, fields: Array<{ name: string; value: string }>) {
    if (!DISCORD_WEBHOOK_URL) {
      console.log(`[DISCORD DRY RUN] ${title}: ${description}`);
      return;
    }
    try {
      await axios.post(DISCORD_WEBHOOK_URL, {
        embeds: [
          {
            title: `🌴 Rumbo a Breakpoint 2026: ${title}`,
            description,
            color: 0x14f195, // Solana Green
            fields,
            footer: { text: "Solana Ecosystem Travel Grants • Superteam LATAM" },
            timestamp: new Date().toISOString(),
          },
        ],
      });
      console.log(`[DISCORD] Dispatched notification: ${title}`);
    } catch (err: any) {
      console.error("[DISCORD ERROR] Failed to send webhook:", err.message);
    }
  }

  /**
   * Sends transactional ticket & reimbursement confirmation via Resend
   */
  public async sendTravelConfirmationEmail(
    recipientEmail: string,
    builderPubkey: string,
    ticketNumber: number,
    grantAmountSOL: number
  ) {
    try {
      const emailHtml = `
        <div style="font-family: Arial, sans-serif; background: #000; color: #fff; padding: 30px; border-radius: 12px;">
          <h1 style="color: #14F195;">¡Felicidades! Rumbo a Solana Breakpoint 2026 ✈️</h1>
          <p>Tu solicitud de beca de viaje y entrada a <strong>Solana Breakpoint 2026</strong> ha sido verificada satisfactoriamente en la blockchain.</p>
          <hr style="border: 1px solid #333;" />
          <div style="background: #111; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <p><strong>Builder Wallet:</strong> <code>${builderPubkey}</code></p>
            <p><strong>Número de Entrada Breakpoint:</strong> #${ticketNumber}</p>
            <p><strong>Bolsa de Viaje Liberada:</strong> ${grantAmountSOL} SOL</p>
            <p><strong>Estado:</strong> Validado on-chain & Escrow Desbloqueado</p>
          </div>
          <p>Por favor revisa tu itinerario y recuerda registrarte en el stand regional al llegar al evento con tu firma de Solana Pay.</p>
          <br />
          <p style="color: #888;">El equipo de Superteam LATAM & Solana Foundation</p>
        </div>
      `;

      const response = await resend.emails.send({
        from: "Rumbo Breakpoint <grants@solanabuilders.lat>",
        to: recipientEmail,
        subject: `🎟️ Tu Entrada & Apoyo para Breakpoint 2026 están Confirmados (#${ticketNumber})`,
        html: emailHtml,
      });

      console.log(`[RESEND] Sent confirmation email: ID ${response.data?.id}`);
    } catch (err: any) {
      console.error("[RESEND ERROR] Failed to dispatch email:", err.message);
    }
  }

  /**
   * Listens to program-level events and coordinates off-chain workflows
   */
  public async startEventListener() {
    console.log("⚡ Starting Rumbo Protocol Event Automation Listener...");

    this.program.addEventListener("MilestoneApproved", async (event: any, _slot: number) => {
      console.log("🎉 MilestoneApproved Event Detected:", event);
      await this.notifyDiscord(
        "Hito de Beca Aprobado ✅",
        `Un participante ha superado el proceso de revisión de jurados.`,
        [
          { name: "Builder", value: event.builder.toBase58() },
          { name: "Etapa Verificada", value: `Nivel ${event.approvedStage}` },
          { name: "Puntaje Jurado", value: `${event.score}/100` },
        ]
      );
    });

    this.program.addEventListener("TicketVoucherIssued", async (event: any, _slot: number) => {
      console.log("🎟️ TicketVoucherIssued Event Detected:", event);
      const builderStr = event.builder.toBase58();
      const ticketNum = event.ticketNumber;

      // Broadcast on public channels
      await this.notifyDiscord(
        "¡Entrada Oficial Breakpoint 2026 Asignada! 🎟️",
        `Un builder LATAM ha asegurado su entrada y apoyo de viaje.`,
        [
          { name: "Builder", value: builderStr },
          { name: "Entrada Nro", value: `#${ticketNum}` },
        ]
      );

      // Trigger high-deliverability Resend email
      await this.sendTravelConfirmationEmail(
        "builder-contact@domain.dev", // Read from off-chain applicant registry
        builderStr,
        ticketNum,
        15.0 // Sol allocation per builder
      );
    });

    this.program.addEventListener("GrantDisbursed", async (event: any, _slot: number) => {
      console.log("💸 GrantDisbursed Event Detected:", event);
      await this.notifyDiscord(
        "Desembolso de Apoyo de Viaje ✈️",
        `Fondos liberados desde el Vault PDA hacia el Builder.`,
        [
          { name: "Destinatario", value: event.builder.toBase58() },
          { name: "Lamports Liberados", value: event.amount.toString() },
          { name: "Total Reclamado", value: event.totalClaimed.toString() },
        ]
      );
    });
  }
}

// Quick CLI testing entrypoint
if (require.main === module) {
  const dummyIdl = {
    version: "0.1.0",
    name: "rumbo_protocol",
    instructions: [],
    events: [
      { name: "MilestoneApproved", fields: [] },
      { name: "TicketVoucherIssued", fields: [] },
      { name: "GrantDisbursed", fields: [] },
    ],
  };
  const agent = new RumboOrchestrator(dummyIdl as any);
  agent.startEventListener();
}