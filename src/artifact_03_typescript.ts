import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import axios from "axios";
import * as dotenv from "dotenv";

dotenv.config();

// Configuration Interface
interface AppConfig {
  rpcUrl: string;
  programId: string;
  resendApiKey: string;
  discordWebhookUrl: string;
  senderEmail: string;
  relayerPrivateKey: string;
}

const config: AppConfig = {
  rpcUrl: process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
  programId: process.env.PROGRAM_ID || "RumbopasS1111111111111111111111111111111111",
  resendApiKey: process.env.RESEND_API_KEY || "",
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || "",
  senderEmail: process.env.SENDER_EMAIL || "grants@rumbobreakpoint.org",
  relayerPrivateKey: process.env.RELAYER_PRIVATE_KEY || "",
};

// Resend Email Dispatcher
async function dispatchEmail(to: string, subject: string, htmlContent: string): Promise<void> {
  if (!config.resendApiKey) {
    console.warn("[WARN] Resend API key missing. Skipping email dispatch.");
    return;
  }
  try {
    const response = await axios.post(
      "https://api.resend.com/emails",
      {
        from: config.senderEmail,
        to: [to],
        subject,
        html: htmlContent,
      },
      {
        headers: {
          Authorization: `Bearer ${config.resendApiKey}`,
          "Content-Type": "application/json",
        },
      }
    );
    console.log(`[RESEND SUCCESS] Dispatched email ID: ${response.data.id} to ${to}`);
  } catch (error: any) {
    console.error("[RESEND ERROR] Failed to send email:", error.response?.data || error.message);
  }
}

// Discord Webhook Dispatcher
async function dispatchDiscordAlert(title: string, description: string, fields: { name: string; value: string; inline?: boolean }[]) {
  if (!config.discordWebhookUrl) {
    console.warn("[WARN] Discord webhook URL missing. Skipping notification.");
    return;
  }
  try {
    await axios.post(config.discordWebhookUrl, {
      embeds: [
        {
          title: `🎟️ Rumbo a Breakpoint 2026: ${title}`,
          description,
          color: 0x14f195, // Solana Emerald Green
          fields,
          footer: {
            text: "Rumbo Passage Automated Verifier Engine • Solana Mainnet/Devnet",
          },
          timestamp: new Date().toISOString(),
        },
      ],
    });
    console.log(`[DISCORD SUCCESS] Alert dispatched: ${title}`);
  } catch (error: any) {
    console.error("[DISCORD ERROR] Failed to send webhook:", error.message);
  }
}

// Main Daemon Listener
export async function startRumboDaemon() {
  console.log("==================================================");
  console.log("  🚀 RUMBO A BREAKPOINT 2026 AGENT DAEMON ONLINE  ");
  console.log(`  Target Program: ${config.programId}             `);
  console.log("==================================================");

  const connection = new Connection(config.rpcUrl, "confirmed");
  const dummyKeypair = Keypair.generate();
  const wallet = new Wallet(dummyKeypair);
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });

  // Minimal IDL matching emitted events
  const idl: any = {
    version: "0.1.0",
    name: "rumbo_passage",
    events: [
      {
        name: "GrantCreated",
        fields: [
          { name: "campaign", type: "publicKey" },
          { name: "grant", type: "publicKey" },
          { name: "grantee", type: "publicKey" },
          { name: "amount", type: "u64" },
        ],
      },
      {
        name: "MilestoneSubmitted",
        fields: [
          { name: "grant", type: "publicKey" },
          { name: "grantee", type: "publicKey" },
          { name: "milestoneIndex", type: "u8" },
          { name: "proofUri", type: "string" },
        ],
      },
      {
        name: "MilestoneApprovedAndDisbursed",
        fields: [
          { name: "grant", type: "publicKey" },
          { name: "grantee", type: "publicKey" },
          { name: "milestoneIndex", type: "u8" },
          { name: "amountDisbursed", type: "u64" },
        ],
      },
    ],
  };

  const program = new Program(idl, new PublicKey(config.programId), provider);

  // Subscribe to GrantCreated event
  program.addEventListener("GrantCreated", async (event: any) => {
    const granteePubkey = event.grantee.toString();
    const amountUSDC = (event.amount.toNumber() / 1_000_000).toFixed(2);

    console.log(`[EVENT] GrantCreated: Grantee ${granteePubkey} assigned $${amountUSDC} USDC`);

    await dispatchDiscordAlert("New Travel Sponsorship Issued!", `A builder has qualified for Breakpoint 2026 travel support.`, [
      { name: "Grantee Pubkey", value: `\`${granteePubkey}\``, inline: false },
      { name: "Total Stipend", value: `$${amountUSDC} USDC`, inline: true },
      { name: "Grant PDA", value: `\`${event.grant.toString()}\``, inline: true },
    ]);
  });

  // Subscribe to MilestoneSubmitted event
  program.addEventListener("MilestoneSubmitted", async (event: any) => {
    const milestoneNames = ["Flight & Lodging Proof", "Conference Check-in & Badge", "Open Source Hackathon Project"];
    const idx = event.milestoneIndex;
    const name = milestoneNames[idx] || `Milestone #${idx}`;

    console.log(`[EVENT] MilestoneSubmitted: Grantee ${event.grantee.toString()} for ${name}`);

    await dispatchDiscordAlert("Milestone Verification Requested", `Builder has submitted cryptographic proof for verification.`, [
      { name: "Milestone", value: name, inline: true },
      { name: "Grantee", value: `\`${event.grantee.toString()}\``, inline: true },
      { name: "Proof CID / URL", value: `[View Deliverable](${event.proofUri})`, inline: false },
    ]);
  });

  // Subscribe to MilestoneApprovedAndDisbursed event
  program.addEventListener("MilestoneApprovedAndDisbursed", async (event: any) => {
    const granteePubkey = event.grantee.toString();
    const amount = (event.amountDisbursed.toNumber() / 1_000_000).toFixed(2);

    console.log(`[EVENT] MilestoneApprovedAndDisbursed: $${amount} disbursed to ${granteePubkey}`);

    // Enterprise Resend Confirmation
    const emailHtml = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e0e0e0; border-radius: 12px;">
        <h1 style="color: #14f195; margin-bottom: 8px;">¡Rumbo a Breakpoint 2026!</h1>
        <p style="font-size: 16px; color: #333;">Your milestone has been verified and your stipend tranche has been released on-chain.</p>
        <div style="background-color: #f7f9fb; padding: 16px; border-radius: 8px; margin: 20px 0;">
          <p style="margin: 4px 0; color: #555;"><strong>Disbursed Amount:</strong> $${amount} USDC</p>
          <p style="margin: 4px 0; color: #555;"><strong>Beneficiary:</strong> ${granteePubkey}</p>
          <p style="margin: 4px 0; color: #555;"><strong>Milestone Phase:</strong> Stage #${event.milestoneIndex + 1}</p>
        </div>
        <p style="font-size: 14px; color: #777;">Please ensure you carry your official travel documentation and Solana Breakpoint admission credentials.</p>
        <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;" />
        <p style="font-size: 12px; color: #999; text-align: center;">Rumbo Protocol • Solana Foundation Community Grants LATAM</p>
      </div>
    `;

    // In production, resolve email from decentralized profile or grantee registry
    await dispatchEmail("grantee-demo@example.com", "🎉 Breakpoint 2026 Travel Stipend Disbursed!", emailHtml);

    await dispatchDiscordAlert("Stipend Tranche Released!", `Funds have been transferred automatically to builder wallet.`, [
      { name: "Amount Disbursed", value: `$${amount} USDC`, inline: true },
      { name: "Milestone Index", value: `#${event.milestoneIndex}`, inline: true },
      { name: "Grantee Pubkey", value: `\`${granteePubkey}\``, inline: false },
    ]);
  });

  // Keep daemon alive
  process.on("SIGINT", () => {
    console.log("Shutting down Rumbo Agent Daemon cleanly...");
    process.exit(0);
  });
}

// Direct Execution Entrypoint
if (require.main === module) {
  startRumboDaemon().catch((err) => {
    console.error("Fatal Daemon Failure:", err);
    process.exit(1);
  });
}