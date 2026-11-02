import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Resend } from "resend";
import axios from "axios";
import * as dotenv from "dotenv";
import * as fs from "fs";

dotenv.config();

const RPC_ENDPOINT = process.env.SOLANA_RPC_ENDPOINT || "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID || "Rumbob3gKqC742q5JbA8tE685U2zH1n3M4FqL9W9Vbp");
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || "";

const resend = new Resend(RESEND_API_KEY);

interface EvaluationNotificationPayload {
  candidate: string;
  cohort: string;
  stipendReleased: number;
  txHash: string;
}

export class NotificationDispatcher {
  public static async dispatchSlack(payload: EvaluationNotificationPayload) {
    if (!SLACK_WEBHOOK_URL) return;
    const body = {
      text: `🚀 *Rumbo a Breakpoint 2026: Grant Approved!*`,
      attachments: [
        {
          color: "#14F195",
          fields: [
            { title: "Candidate Wallet", value: `\`${payload.candidate}\``, short: false },
            { title: "Grant Released", value: `$${payload.stipendReleased.toLocaleString()} USDC`, short: true },
            { title: "Cohort", value: payload.cohort, short: true },
            { title: "Solana Explorer", value: `https://explorer.solana.com/tx/${payload.txHash}?cluster=devnet`, short: false }
          ]
        }
      ]
    };
    await axios.post(SLACK_WEBHOOK_URL, body).catch(e => console.error("Slack webhook error:", e.message));
  }

  public static async dispatchDiscord(payload: EvaluationNotificationPayload) {
    if (!DISCORD_WEBHOOK_URL) return;
    const embed = {
      title: "🌴 Rumbo a Breakpoint 2026 - Milestone Approved & Travel Grant Released!",
      color: 0x9945FF,
      fields: [
        { name: "Candidate", value: `\`${payload.candidate}\``, inline: false },
        { name: "Amount Released", value: `$${payload.stipendReleased} USDC`, inline: true },
        { name: "Status", value: "Verified by Multi-Sig Council", inline: true },
        { name: "Transaction Hash", value: `[View on Solana Explorer](https://explorer.solana.com/tx/${payload.txHash}?cluster=devnet)`, inline: false }
      ],
      footer: { text: "Solana Breakpoint 2026 Automated Protocol" },
      timestamp: new Date().toISOString()
    };
    await axios.post(DISCORD_WEBHOOK_URL, { embeds: [embed] }).catch(e => console.error("Discord webhook error:", e.message));
  }

  public static async sendTravelTicketEmail(candidateEmail: string, candidateWallet: string) {
    if (!RESEND_API_KEY) return;
    try {
      await resend.emails.send({
        from: "Breakpoint Pass <grants@breakpoint2026.solana.com>",
        to: candidateEmail,
        subject: "🎉 ¡Felicidades! Rumbo a Breakpoint 2026: Tu entrada y beca de viaje están listas",
        html: `
          <div style="font-family: Arial, sans-serif; background: #000; color: #fff; padding: 30px; border-radius: 8px;">
            <h1 style="color: #14F195;">¡Tu viaje a Breakpoint 2026 está confirmado!</h1>
            <p>Hola Builder,</p>
            <p>Tus hitos técnicos han sido aprobados por el comité evaluador de la comunidad Solana.</p>
            <div style="background: #111; padding: 20px; border: 1px solid #333; border-radius: 6px; margin: 20px 0;">
              <p><strong>Billetera Beneficiaria:</strong> <code style="color: #9945FF;">${candidateWallet}</code></p>
              <p><strong>Estado:</strong> Travel Grant ($2,500 USDC) acreditado on-chain.</p>
              <p><strong>Entrada:</strong> Token-2022 Soulbound Pass acuñado.</p>
            </div>
            <p>Por favor consulta el portal de Solana FlightDeck para coordinar tus vuelos y credencial de acceso.</p>
            <br/>
            <p style="color: #888;">El equipo de Solana Breakpoint 2026</p>
          </div>
        `
      });
      console.log(`[Resend] Successfully dispatched travel kit email to ${candidateEmail}`);
    } catch (err: any) {
      console.error("[Resend] Failed to send email:", err.message);
    }
  }
}

async function main() {
  console.log("⚡ Starting RumboProtocol Event Daemon...");
  const connection = new Connection(RPC_ENDPOINT, "confirmed");

  // Load Relayer Authority Keypair
  const relayerKeyPath = process.env.RELAYER_KEYPAIR_PATH || "./relayer-keypair.json";
  let relayerKeypair: Keypair;
  if (fs.existsSync(relayerKeyPath)) {
    const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(relayerKeyPath, "utf-8")));
    relayerKeypair = Keypair.fromSecretKey(secretKey);
  } else {
    relayerKeypair = Keypair.generate();
    console.warn(`[WARN] Using ephemeral relayer key: ${relayerKeypair.publicKey.toBase58()}`);
  }

  const wallet = new anchor.Wallet(relayerKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });

  // Minimal IDL for parsing log events
  const idl = await anchor.Program.fetchIdl(PROGRAM_ID, provider);
  if (!idl) {
    throw new Error(`Could not fetch IDL for program ${PROGRAM_ID.toBase58()}`);
  }
  const program = new anchor.Program(idl, provider);

  console.log(`[Connected] Listening on Program: ${PROGRAM_ID.toBase58()}`);

  program.addEventListener("milestoneApprovedEvent", async (event: any, slot: number, signature: string) => {
    console.log(`[EVENT] MilestoneApproved detected in tx: ${signature}`);
    const stipendReleased = event.stipendReleased ? Number(event.stipendReleased) / 1_000_000 : 2500;
    const payload: EvaluationNotificationPayload = {
      candidate: event.candidate.toBase58(),
      cohort: event.cohort.toBase58(),
      stipendReleased,
      txHash: signature,
    };

    await Promise.all([
      NotificationDispatcher.dispatchSlack(payload),
      NotificationDispatcher.dispatchDiscord(payload),
      NotificationDispatcher.sendTravelTicketEmail("builder@solanadev.io", payload.candidate)
    ]);
  });

  program.addEventListener("milestoneSubmittedEvent", (event: any, slot: number, signature: string) => {
    console.log(`[EVENT] New Milestone Submitted by ${event.candidate.toBase58()}: ${event.proofUrl} (TX: ${signature})`);
  });

  // Keep alive
  setInterval(() => {
    console.log(`[Heartbeat] RumboProtocol Relayer active at slot check. Relayer pubkey: ${relayerKeypair.publicKey.toBase58()}`);
  }, 60000);
}

main().catch((err) => {
  console.error("Fatal daemon error:", err);
  process.exit(1);
});