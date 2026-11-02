import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { Resend } from "resend";
import axios from "axios";
import * as dotenv from "dotenv";

dotenv.config();

const RESEND_API_KEY = process.env.RESEND_API_KEY || "re_mock_test_key";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

const resend = new Resend(RESEND_API_KEY);

export interface GrantNotificationPayload {
  applicant: string;
  github: string;
  approvedStipendLamports: number;
  ticketNumber?: number;
}

export class RumboNotificationDispatcher {
  /**
   * Dispatches branded HTML travel verification & ticket pass to the grantee.
   */
  public static async sendGranteePassEmail(
    toEmail: string,
    payload: GrantNotificationPayload
  ): Promise<boolean> {
    const stipendSol = (payload.approvedStipendLamports / 1e9).toFixed(2);
    try {
      const response = await resend.emails.send({
        from: "Breakpoint Travel Engine <rumbo@solanabreakpoint.org>",
        to: [toEmail],
        subject: `🎉 Congratulations! Your Rumbo a Breakpoint 2026 Pass is Confirmed!`,
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #0d0e12; color: #ffffff; padding: 40px; border-radius: 12px; max-width: 600px; margin: auto;">
            <h1 style="color: #14F195; font-size: 26px; text-transform: uppercase; margin-bottom: 8px;">Rumbo a Breakpoint 2026</h1>
            <p style="color: #9945FF; font-size: 16px; font-weight: bold;">Verified On-Chain Travel Grant & Ticket Confirmation</p>
            <hr style="border: 0; border-top: 1px solid #282c37; margin: 24px 0;" />
            <p>Hey <strong>${payload.github}</strong>,</p>
            <p>The Grant Evaluation Committee has verified your contributions on-chain. Your travel stipend and conference pass for <strong>Breakpoint 2026</strong> have been authorized!</p>
            <div style="background-color: #1a1b23; border: 1px solid #333842; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <p style="margin: 0 0 10px 0;">🎟️ <strong>Conference Ticket:</strong> Confirmed Pass (Soulbound)</p>
              <p style="margin: 0 0 10px 0;">💸 <strong>Disbursed Travel Grant:</strong> ${stipendSol} SOL</p>
              <p style="margin: 0;">🔑 <strong>On-Chain Recipient:</strong> <code style="color: #14F195;">${payload.applicant}</code></p>
            </div>
            <p style="font-size: 13px; color: #8a8f98;">Show this on-chain proof at badge pickup or verify your wallet directly on arrival.</p>
          </div>
        `,
      });

      console.log(`[Resend] Successfully dispatched email. ID: ${response.data?.id}`);
      return true;
    } catch (err) {
      console.error(`[Resend Error] Failed to send email to ${toEmail}:`, err);
      return false;
    }
  }

  /**
   * Pushes real-time governance notification to Discord.
   */
  public static async pushDiscordBroadcast(payload: GrantNotificationPayload): Promise<void> {
    if (!DISCORD_WEBHOOK_URL) return;

    const stipendSol = (payload.approvedStipendLamports / 1e9).toFixed(2);
    const body = {
      embeds: [
        {
          title: "🚀 Rumbo a Breakpoint 2026: Grant Disbursed!",
          color: 0x14f195,
          fields: [
            { name: "Builder", value: `[${payload.github}](https://github.com/${payload.github})`, inline: true },
            { name: "Stipend (SOL)", value: `${stipendSol} SOL`, inline: true },
            { name: "Wallet", value: `\`${payload.applicant.slice(0, 4)}...${payload.applicant.slice(-4)}\``, inline: false },
          ],
          footer: { text: "Solana Verifiable Travel Allocator • On-Chain Event Verified" },
          timestamp: new Date().toISOString(),
        },
      ],
    };

    try {
      await axios.post(DISCORD_WEBHOOK_URL, body);
      console.log(`[Discord] Broadcast pushed successfully.`);
    } catch (err: any) {
      console.error(`[Discord Error] Failed to dispatch webhook:`, err.message);
    }
  }
}