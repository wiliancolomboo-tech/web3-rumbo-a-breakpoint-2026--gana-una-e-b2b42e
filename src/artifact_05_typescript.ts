import * as anchor from "@coral-xyz/anchor";
import { Program, Wallet } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  clusterApiUrl,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  createMint,
} from "@solana/spl-token";
import axios from "axios";
import { Resend } from "resend";
import * as dotenv from "dotenv";

dotenv.config();

// Contract interface
const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID || "RumboeB1GKT1W417FkWsAevjPzDk36UuG2iZ1s6hZhn"
);
const RESEND_API_KEY = process.env.RESEND_API_KEY || "re_test_000000000000000000000000";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";

const resend = new Resend(RESEND_API_KEY);

export class BreakpointPathfinderClient {
  public connection: Connection;
  public wallet: Wallet;
  public provider: anchor.AnchorProvider;
  public program: Program;

  constructor(rpcUrl: string, keypair: Keypair) {
    this.connection = new Connection(rpcUrl, "confirmed");
    this.wallet = new Wallet(keypair);
    this.provider = new anchor.AnchorProvider(this.connection, this.wallet, {
      commitment: "confirmed",
    });
    // Anchor IDL reflection
    const idl = require("../target/idl/rumbo_breakpoint.json");
    this.program = new Program(idl, this.provider);
  }

  public getCampaignPda(campaignId: anchor.BN): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("campaign"), campaignId.toArrayLike(Buffer, "le", 8)],
      PROGRAM_ID
    );
  }

  public getVaultPda(campaignPda: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("campaign_vault"), campaignPda.toBuffer()],
      PROGRAM_ID
    );
  }

  public getApplicantPda(campaignPda: PublicKey, applicant: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("applicant"), campaignPda.toBuffer(), applicant.toBuffer()],
      PROGRAM_ID
    );
  }

  /**
   * Initializes a Breakpoint grant pool campaign.
   */
  async initializeCampaign(
    campaignId: number,
    name: string,
    grantAmount: number,
    threshold: number,
    committeePubkeys: PublicKey[],
    mint: PublicKey
  ): Promise<string> {
    const cId = new anchor.BN(campaignId);
    const [campaignPda] = this.getCampaignPda(cId);
    const [vaultPda] = this.getVaultPda(campaignPda);

    const tx = await this.program.methods
      .initializeCampaign(
        cId,
        name,
        threshold,
        new anchor.BN(grantAmount),
        committeePubkeys
      )
      .accounts({
        campaign: campaignPda,
        vault: vaultPda,
        tokenMint: mint,
        admin: this.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    await this.notifyDiscord(
      `🎉 **Nueva Campaña Creada: Rumbo a Breakpoint 2026**\n- **Nombre:** ${name}\n- **Beca por Ganador:** ${grantAmount / 1_000_000} USDC\n- **Umbral de Jurado:** ${threshold} firmas\n- **Tx:** \`${tx}\``
    );

    return tx;
  }

  /**
   * Candidate applies with proposal IPFS CID.
   */
  async applyForGrant(campaignId: number, metadataCid: string): Promise<string> {
    const cId = new anchor.BN(campaignId);
    const [campaignPda] = this.getCampaignPda(cId);
    const [applicantPda] = this.getApplicantPda(campaignPda, this.wallet.publicKey);

    const tx = await this.program.methods
      .registerApplicant(cId, metadataCid)
      .accounts({
        campaign: campaignPda,
        applicantRecord: applicantPda,
        applicant: this.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    await this.notifyDiscord(
      `📝 **Nueva Aplicación Registrada**\n- **Candidato:** \`${this.wallet.publicKey.toBase58()}\`\n- **Propuesta (IPFS):** \`${metadataCid}\`\n- **Tx:** \`${tx}\``
    );

    return tx;
  }

  /**
   * Claims milestone payout and triggers real ticket dispatch off-chain.
   */
  async claimMilestone(
    campaignId: number,
    milestoneIndex: 1 | 2,
    applicantAta: PublicKey,
    recipientEmail?: string
  ): Promise<string> {
    const cId = new anchor.BN(campaignId);
    const [campaignPda] = this.getCampaignPda(cId);
    const [vaultPda] = this.getVaultPda(campaignPda);
    const [applicantPda] = this.getApplicantPda(campaignPda, this.wallet.publicKey);

    let tx: string;
    if (milestoneIndex === 1) {
      tx = await this.program.methods
        .claimMilestone1(cId)
        .accounts({
          campaign: campaignPda,
          applicantRecord: applicantPda,
          vault: vaultPda,
          applicantTokenAccount: applicantAta,
          applicant: this.wallet.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
    } else {
      tx = await this.program.methods
        .claimMilestone2(cId)
        .accounts({
          campaign: campaignPda,
          applicantRecord: applicantPda,
          vault: vaultPda,
          applicantTokenAccount: applicantAta,
          applicant: this.wallet.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
    }

    // Enterprise notification dispatch
    if (recipientEmail) {
      await this.sendTicketNotification(recipientEmail, milestoneIndex, tx);
    }

    await this.notifyDiscord(
      `✈️ **Hito ${milestoneIndex} Desembolsado con Éxito**\n- **Beneficiario:** \`${this.wallet.publicKey.toBase58()}\`\n- **Fase:** ${
        milestoneIndex === 1 ? "50% Vuelos / Viáticos" : "50% Entrada Oficial + Check-in Presencial"
      }\n- **Tx:** \`${tx}\``
    );

    return tx;
  }

  /**
   * Enterprise Resend email integration.
   */
  public async sendTicketNotification(
    email: string,
    milestone: number,
    signature: string
  ): Promise<void> {
    try {
      if (!RESEND_API_KEY || RESEND_API_KEY.includes("dummy")) {
        console.log(`[DRY-RUN] Sending Breakpoint ticket confirmation to ${email}`);
        return;
      }

      await resend.emails.send({
        from: "Breakpoint Pathfinder <grants@solanabreakpoint.org>",
        to: email,
        subject: `🎟️ ¡Confirmación Oficial: Rumbo a Breakpoint 2026 - Hito ${milestone} Aprobado!`,
        html: `
          <div style="font-family: Arial, sans-serif; background-color: #0b0e14; color: #fff; padding: 24px; border-radius: 8px;">
            <h1 style="color: #14F195;">¡Felicidades, Builder!</h1>
            <p>Tu solicitud para <strong>Rumbo a Breakpoint 2026</strong> ha superado la validación criptográfica en Solana.</p>
            <p><strong>Hito Desembolsado:</strong> ${milestone} de 2</p>
            <p><strong>Identificador de Transacción:</strong> <a href="https://explorer.solana.com/tx/${signature}?cluster=devnet" style="color: #9945FF;">${signature}</a></p>
            <hr style="border: 1px solid #222;" />
            <p>Tu entrada y voucher de viaje están asegurados en la tesorería on-chain. Nos vemos en Breakpoint 2026.</p>
          </div>
        `,
      });
      console.log(`[Resend] Email ticket confirmation sent to: ${email}`);
    } catch (err) {
      console.error("[Resend Error] Failed to dispatch email:", err);
    }
  }

  /**
   * Discord audit stream for community transparency.
   */
  public async notifyDiscord(content: string): Promise<void> {
    if (!DISCORD_WEBHOOK_URL) {
      console.log(`[Webhook Mock]: ${content}`);
      return;
    }
    try {
      await axios.post(DISCORD_WEBHOOK_URL, {
        username: "Solana Breakpoint Pathfinder",
        avatar_url: "https://solana.com/src/img/branding/solanaLogoMark.png",
        content,
      });
    } catch (e: any) {
      console.error("[Discord Webhook Error]:", e.message);
    }
  }
}