import { Resend } from "resend";
import axios from "axios";
import { CONFIG } from "../config";

const resend = new Resend(CONFIG.RESEND_API_KEY);

export interface NotificationPayload {
  builderPubkey: string;
  githubHandle: string;
  score: number;
  awardedLamports: number;
  txSignature: string;
  recipientEmail?: string;
}

export class EnterpriseNotifier {
  public static async notifyDiscord(payload: NotificationPayload): Promise<void> {
    if (!CONFIG.DISCORD_WEBHOOK_URL) return;

    const solAmount = (payload.awardedLamports / 1e9).toFixed(2);
    const content = {
      username: "Breakpoint 2026 Grant Bot",
      avatar_url: "https://solana.com/src/img/branding/solanaLogoMark.png",
      embeds: [
        {
          title: "🚀 Nuevo Beneficiario: Rumbo a Breakpoint 2026",
          color: 0x14f195, // Solana Green
          fields: [
            { name: "Builder", value: `\`${payload.builderPubkey}\``, inline: false },
            { name: "GitHub", value: `[${payload.githubHandle}](https://github.com/${payload.githubHandle})`, inline: true },
            { name: "Proof Score", value: `${payload.score}/100`, inline: true },
            { name: "Beca de Viaje", value: `${solAmount} SOL + Entrada VIP`, inline: true },
            { name: "Verificación On-Chain", value: `[Solana Explorer](https://explorer.solana.com/tx/${payload.txSignature}?cluster=devnet)`, inline: false }
          ],
          footer: { text: "Solana Foundation Travel Grants • Verificado por Anchor PDA" },
          timestamp: new Date().toISOString()
        }
      ]
    };

    try {
      await axios.post(CONFIG.DISCORD_WEBHOOK_URL, content);
      console.log(`📡 Discord notification broadcast for ${payload.githubHandle}`);
    } catch (err: any) {
      console.error("⚠️ Failed to trigger Discord webhook:", err.message);
    }
  }

  public static async sendTicketEmail(payload: NotificationPayload): Promise<void> {
    if (!payload.recipientEmail) return;

    try {
      const { data, error } = await resend.emails.send({
        from: CONFIG.SENDER_EMAIL,
        to: payload.recipientEmail,
        subject: "🎉 ¡Felicidades! Tu beca y entrada a Solana Breakpoint 2026 están aprobadas",
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 8px;">
            <h1 style="color: #9945FF;">Rumbo a Breakpoint 2026</h1>
            <p>Hola <strong>@${payload.githubHandle}</strong>,</p>
            <p>Tu solicitud de viaje y acreditación para <strong>Solana Breakpoint 2026</strong> ha sido auditada y aprobada por el agente de verificación con un score de <strong>${payload.score}/100</strong>.</p>
            <div style="background-color: #f7f9fa; padding: 15px; border-left: 4px solid #14F195; margin: 20px 0;">
              <p style="margin: 0 0 8px 0;"><strong>Beca Asignada:</strong> ${(payload.awardedLamports / 1e9).toFixed(2)} SOL</p>
              <p style="margin: 0 0 8px 0;"><strong>Entrada:</strong> Breakpoint Conference Pass (Confirmado)</p>
              <p style="margin: 0;"><strong>Transacción:</strong> <a href="https://explorer.solana.com/tx/${payload.txSignature}?cluster=devnet">${payload.txSignature.slice(0, 16)}...</a></p>
            </div>
            <p>Ya puedes reclamar tus fondos directamente conectando tu wallet al protocolo.</p>
            <p style="color: #666; font-size: 12px; margin-top: 30px;">Solana Foundation Community Grants Team</p>
          </div>
        `
      });

      if (error) {
        console.error("⚠️ Resend API Error:", error);
      } else {
        console.log(`📧 Confirmation email delivered via Resend. Message ID: ${data?.id}`);
      }
    } catch (err: any) {
      console.error("⚠️ Exception sending email via Resend:", err.message);
    }
  }
}