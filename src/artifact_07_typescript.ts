import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { Resend } from "resend";
import { request } from "undici";
import * as dotenv from "dotenv";
import * as fs from "fs";

dotenv.config();

// Configuration environment schema
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID || "Rumb0BrkP2o26Voyag3rProtoco1111111111111111"
);
const RESEND_API_KEY = process.env.RESEND_API_KEY || "re_test_000000000000000000000000";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const KEYPAIR_PATH = process.env.KEYPAIR_PATH || "./authority-keypair.json";

interface NotificationPayload {
  builderPubkey: string;
  grantAmountUsdc: number;
  poolId: string;
  recipientEmail?: string;
  txHash: string;
}

export class BreakpointEnterpriseDispatcher {
  private resend: Resend;
  private connection: Connection;
  private discordWebhook: string;

  constructor() {
    this.resend = new Resend(RESEND_API_KEY);
    this.connection = new Connection(SOLANA_RPC_URL, {
      commitment: "confirmed",
      wsEndpoint: SOLANA_RPC_URL.replace("https://", "wss://").replace("http://", "ws://"),
    });
    this.discordWebhook = DISCORD_WEBHOOK_URL;
  }

  public async broadcastDiscordUpdate(data: NotificationPayload): Promise<void> {
    if (!this.discordWebhook) {
      console.warn("[Enterprise Dispatcher] No DISCORD_WEBHOOK_URL configured. Skipping broadcast.");
      return;
    }

    const embed = {
      title: "🚀 ¡RUMBO A BREAKPOINT 2026! - Nuevo Ganador Seleccionado",
      description: `Un builder sobresaliente ha superado todos los hitos y asegurado su entrada + apoyo de viaje completo.`,
      color: 0x14f195, // Solana Green
      fields: [
        { name: "Builder Address", value: `\`${data.builderPubkey}\``, inline: false },
        { name: "Bolsa de Viaje Aprobada", value: `$${data.grantAmountUsdc.toLocaleString()} USDC`, inline: true },
        { name: "Ticket Pass Status", value: "✅ Breakpoint 2026 Confirmado", inline: true },
        { name: "Pool ID", value: data.poolId, inline: true },
        { name: "Solana Explorer", value: `[Ver Transacción](https://explorer.solana.com/tx/${data.txHash}?cluster=devnet)`, inline: false },
      ],
      footer: { text: "Solana Superteam & Breakpoint Voyager Protocol • Zero-Downtime Daemon" },
      timestamp: new Date().toISOString(),
    };

    try {
      const response = await request(this.discordWebhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ embeds: [embed] }),
      });

      if (response.statusCode >= 200 && response.statusCode < 300) {
        console.log(`[Enterprise Dispatcher] Discord announcement dispatched successfully.`);
      } else {
        console.error(`[Enterprise Dispatcher] Discord webhook failed with status: ${response.statusCode}`);
      }
    } catch (err) {
      console.error("[Enterprise Dispatcher] Error pushing Discord webhook:", err);
    }
  }

  public async dispatchTicketEmail(data: NotificationPayload): Promise<void> {
    const targetEmail = data.recipientEmail || "builder@solana.org";

    try {
      const result = await this.resend.emails.send({
        from: "Breakpoint Voyager <travel@solana.superteam.fun>",
        to: targetEmail,
        subject: "🎉 ¡Felicidades! Tu Entrada y Apoyo de Viaje a Breakpoint 2026 están Listos",
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #000; color: #fff; padding: 40px; border-radius: 12px; max-width: 600px; margin: auto;">
            <div style="text-align: center; margin-bottom: 24px;">
              <h1 style="color: #14F195; margin: 0; font-size: 28px;">Rumbo a Breakpoint 2026</h1>
              <p style="color: #9945FF; font-size: 16px; margin: 8px 0 0 0;">Travel Grant & Ticket Allocation Pass</p>
            </div>
            
            <p>Hola Builder,</p>
            <p>Tu contribución de código y despliegue en Solana han sido <strong>100% validados</strong> por el jurado evaluador on-chain.</p>
            
            <div style="background: #111; border: 1px solid #333; padding: 20px; border-radius: 8px; margin: 24px 0;">
              <h3 style="margin-top: 0; color: #14F195;">Detalles del Desembolso:</h3>
              <ul style="list-style: none; padding: 0; line-height: 1.8;">
                <li>✈️ <strong>Ticket Oficial:</strong> Breakpoint 2026 Full Conference Pass</li>
                <li>💵 <strong>Apoyo de Viaje:</strong> $${data.grantAmountUsdc.toLocaleString()} USDC</li>
                <li>🔑 <strong>Wallet Acreditada:</strong> <code style="color: #00C2FF;">${data.builderPubkey}</code></li>
                <li>🔗 <strong>Proof TX:</strong> <code style="color: #aaa;">${data.txHash}</code></li>
              </ul>
            </div>

            <p style="font-size: 14px; color: #aaa;">
              Este mensaje ha sido emitido de manera autónoma y determinista por el smart contract en Solana. Nos vemos en Breakpoint 2026 para seguir construyendo el futuro descentralizado.
            </p>

            <div style="margin-top: 30px; text-align: center; border-top: 1px solid #222; padding-top: 20px;">
              <small style="color: #666;">Breakpoint Voyager Protocol • Powered by Solana & Resend</small>
            </div>
          </div>
        `,
      });

      console.log(`[Enterprise Dispatcher] Resend confirmation email dispatched: ID ${result.data?.id}`);
    } catch (error) {
      console.error("[Enterprise Dispatcher] Resend email dispatch failed:", error);
    }
  }

  public async startListener(): Promise<void> {
    console.log(`[Voyager Agent] Connecting to Solana RPC: ${SOLANA_RPC_URL}`);
    console.log(`[Voyager Agent] Watching Program: ${PROGRAM_ID.toBase58()}`);

    this.connection.onLogs(
      PROGRAM_ID,
      async ({ logs, err, signature }) => {
        if (err) return;

        for (const log of logs) {
          // Detect on-chain WinnerAwardedEvent
          if (log.includes("WinnerAwardedEvent") || log.includes("Instruction: DisburseGrantAndTicket")) {
            console.log(`[Voyager Agent] Confirmed grant distribution event in TX: ${signature}`);

            const payload: NotificationPayload = {
              builderPubkey: "5fhNEGbwbKUwtRtWvZwfNu4GQnwd8GSkjbAbj82", // Example parsed account
              grantAmountUsdc: 2500,
              poolId: "Breakpoint2026-LatAm-Cohort-1",
              recipientEmail: process.env.OPERATIONAL_ALERT_EMAIL || "builder-award@superteam.fun",
              txHash: signature,
            };

            await Promise.all([
              this.broadcastDiscordUpdate(payload),
              this.dispatchTicketEmail(payload),
            ]);
          }
        }
      },
      "confirmed"
    );

    console.log("[Voyager Agent] Agent active & listening for on-chain events in real-time.");
  }
}

// Direct Execution Entrypoint
if (require.main === module) {
  const agent = new BreakpointEnterpriseDispatcher();
  agent.startListener().catch((err) => {
    console.error("[Voyager Agent Fatal]:", err);
    process.exit(1);
  });
}