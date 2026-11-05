import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet, Idl, BN } from "@coral-xyz/anchor";
import axios from "axios";
import * as crypto from "crypto";

// -----------------------------------------------------------------------------
// INTERFACES & CONFIG
// -----------------------------------------------------------------------------

export interface SentinelConfig {
  solanaRpcUrl: string;
  programId: string;
  resendApiKey: string;
  discordWebhookUrl: string;
  adminKeypair: Keypair;
}

export interface GrantInitPayload {
  grantId: number;
  builderPubkey: string;
  totalSol: number;
  milestone1Sol: number; // Flight & Ticket
  milestone2Sol: number; // Visa & Transit
  milestone3Sol: number; // On-site Attendance & Demo
  expiryDays: number;
  builderEmail: string;
}

export class RumboSentinelEngine {
  private connection: Connection;
  private provider: AnchorProvider;
  private program: Program;
  private resendApiKey: string;
  private discordWebhookUrl: string;

  constructor(config: SentinelConfig, idl: Idl) {
    this.connection = new Connection(config.solanaRpcUrl, "confirmed");
    const wallet = new Wallet(config.adminKeypair);
    this.provider = new AnchorProvider(this.connection, wallet, { commitment: "confirmed" });
    this.program = new Program(idl, config.programId, this.provider);
    this.resendApiKey = config.resendApiKey;
    this.discordWebhookUrl = config.discordWebhookUrl;
  }

  // Derive Grant Escrow PDA
  public findGrantPda(builder: PublicKey, grantId: BN): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("grant"), builder.toBuffer(), grantId.toArrayLike(Buffer, "le", 8)],
      this.program.programId
    );
  }

  // Derive Vault PDA
  public findVaultPda(grantPda: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), grantPda.toBuffer()],
      this.program.programId
    );
  }

  // Calculate SHA-256 digest of travel receipts or ticket PDFs
  public static hashReceipt(documentBuffer: Buffer): number[] {
    const hash = crypto.createHash("sha256").update(documentBuffer).digest();
    return Array.from(hash);
  }

  // Initialize and Fund a Rumbo Escrow
  public async setupAndFundGrant(
    payload: GrantInitPayload,
    sponsorKeypair: Keypair
  ): Promise<string> {
    const builder = new PublicKey(payload.builderPubkey);
    const grantIdBN = new BN(payload.grantId);
    const [grantPda] = this.findGrantPda(builder, grantIdBN);
    const [vaultPda] = this.findVaultPda(grantPda);
    const [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      this.program.programId
    );

    const totalLamports = new BN(payload.totalSol * 1e9);
    const m1 = new BN(payload.milestone1Sol * 1e9);
    const m2 = new BN(payload.milestone2Sol * 1e9);
    const m3 = new BN(payload.milestone3Sol * 1e9);

    const nowSeconds = Math.floor(Date.now() / 1000);
    const expiryTimestamp = new BN(nowSeconds + payload.expiryDays * 86400);

    console.log(`[RUMBO SENTINEL] Registering Grant #${payload.grantId} for ${payload.builderPubkey}...`);

    // 1. Create Grant
    const createTx = await this.program.methods
      .createGrant(grantIdBN, totalLamports, [m1, m2, m3], expiryTimestamp)
      .accounts({
        config: configPda,
        grantEscrow: grantPda,
        vault: vaultPda,
        builder: builder,
        sponsor: sponsorKeypair.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([sponsorKeypair])
      .rpc();

    console.log(`[RUMBO SENTINEL] Created Grant Escrow on-chain. Tx: ${createTx}`);

    // 2. Fund Grant
    const fundTx = await this.program.methods
      .fundGrant(grantIdBN)
      .accounts({
        grantEscrow: grantPda,
        vault: vaultPda,
        sponsor: sponsorKeypair.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([sponsorKeypair])
      .rpc();

    console.log(`[RUMBO SENTINEL] Escrow PDA Vault funded with ${payload.totalSol} SOL. Tx: ${fundTx}`);

    // 3. Dispatch Enterprise Alerts
    await this.notifyDiscord({
      title: "🚀 Nuevo Apoyo de Viaje Asignado: Rumbo a Breakpoint 2026",
      color: 0x14f195, // Solana Green
      fields: [
        { name: "Grant ID", value: `#${payload.grantId}`, inline: true },
        { name: "Beneficiario", value: `${payload.builderPubkey.slice(0, 6)}...${payload.builderPubkey.slice(-4)}`, inline: true },
        { name: "Fondo Total", value: `${payload.totalSol} SOL`, inline: true },
        { name: "Bolsa Hito 1 (Vuelos/Ticket)", value: `${payload.milestone1Sol} SOL`, inline: false },
        { name: "Bolsa Hito 2 (Visado/Tránsito)", value: `${payload.milestone2Sol} SOL`, inline: false },
        { name: "Bolsa Hito 3 (Breakpoint On-Site)", value: `${payload.milestone3Sol} SOL`, inline: false },
      ],
      txSignature: fundTx,
    });

    await this.sendEmail(
      payload.builderEmail,
      "¡Felicidades! Tu beca de viaje 'Rumbo a Breakpoint 2026' ha sido reservada",
      `<p>Hola Builder,</p>
       <p>Tu apoyo financiero para asistir a <strong>Solana Breakpoint 2026</strong> ha sido depositado en el contrato de depósito en garantía (Escrow) de Solana.</p>
       <ul>
         <li><strong>Monto Total:</strong> ${payload.totalSol} SOL</li>
         <li><strong>Fondo en Custodia (Vault PDA):</strong> <code>${vaultPda.toBase58()}</code></li>
       </ul>
       <p>Para desbloquear tu primer 50% (${payload.milestone1Sol} SOL), ingresa a la CLI o Portal de Rumbo Sentinel y carga tu comprobante de pasaje aéreo y entrada a Breakpoint.</p>
       <p>¡Nos vemos en Breakpoint 2026!</p>`
    );

    return fundTx;
  }

  // Verifies and triggers automatic release of milestone funds
  public async evaluateAndDisburse(
    grantId: number,
    milestoneIndex: number,
    builderPubkey: string,
    builderEmail: string,
    jurorKeypair: Keypair
  ): Promise<string> {
    const builder = new PublicKey(builderPubkey);
    const grantIdBN = new BN(grantId);
    const [grantPda] = this.findGrantPda(builder, grantIdBN);
    const [vaultPda] = this.findVaultPda(grantPda);
    const [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      this.program.programId
    );

    const [voteRecordPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("vote"),
        grantPda.toBuffer(),
        Buffer.from([milestoneIndex]),
        jurorKeypair.publicKey.toBuffer(),
      ],
      this.program.programId
    );

    console.log(`[RUMBO SENTINEL] Casting Jury Quorum Vote for Grant #${grantId}, Milestone ${milestoneIndex}...`);

    // 1. Cast Jury Vote
    const voteTx = await this.program.methods
      .castJuryVote(grantIdBN, milestoneIndex, true)
      .accounts({
        grantEscrow: grantPda,
        voteRecord: voteRecordPda,
        juror: jurorKeypair.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([jurorKeypair])
      .rpc();

    console.log(`[RUMBO SENTINEL] Juror vote recorded: ${voteTx}`);

    // 2. Disburse Milestone Payout
    console.log(`[RUMBO SENTINEL] Executing programmatic disbursement to builder...`);
    const disburseTx = await this.program.methods
      .disburseMilestone(grantIdBN, milestoneIndex)
      .accounts({
        config: configPda,
        grantEscrow: grantPda,
        vault: vaultPda,
        builder: builder,
        caller: jurorKeypair.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([jurorKeypair])
      .rpc();

    console.log(`[RUMBO SENTINEL] Disbursement completed! Tx: ${disburseTx}`);

    // 3. Dispatch Enterprise Alerts
    await this.notifyDiscord({
      title: `💸 Hito #${milestoneIndex + 1} Verificado & Fondos Transferidos`,
      color: 0x9945ff, // Solana Purple
      fields: [
        { name: "Grant ID", value: `#${grantId}`, inline: true },
        { name: "Hito", value: `Fase ${milestoneIndex + 1}`, inline: true },
        { name: "Receptor", value: `${builderPubkey.slice(0, 6)}...${builderPubkey.slice(-4)}`, inline: true },
      ],
      txSignature: disburseTx,
    });

    await this.sendEmail(
      builderEmail,
      `Fondos Transferidos: Hito #${milestoneIndex + 1} Rumbo a Breakpoint 2026`,
      `<p>Tus comprobantes han sido aprobados por el comité de selección.</p>
       <p>Se ha transferido la porción correspondiente de tu beca de viaje directamente a tu wallet de Solana.</p>
       <p><strong>Hash de Transacción:</strong> <a href="https://explorer.solana.com/tx/${disburseTx}?cluster=devnet">${disburseTx}</a></p>`
    );

    return disburseTx;
  }

  // Internal: Discord Webhook Integration
  private async notifyDiscord(payload: {
    title: string;
    color: number;
    fields: { name: string; value: string; inline?: boolean }[];
    txSignature: string;
  }): Promise<void> {
    if (!this.discordWebhookUrl) return;
    try {
      await axios.post(this.discordWebhookUrl, {
        embeds: [
          {
            title: payload.title,
            color: payload.color,
            fields: [
              ...payload.fields,
              {
                name: "Explorer",
                value: `[Ver Transacción](https://explorer.solana.com/tx/${payload.txSignature}?cluster=devnet)`,
              },
            ],
            footer: { text: "Solana Rumbo Sentinel • Breakpoint 2026 Delegation Engine" },
            timestamp: new Date().toISOString(),
          },
        ],
      });
    } catch (err: any) {
      console.error("[TELEMETRY WARNING] Failed to post to Discord webhook:", err.message);
    }
  }

  // Internal: Resend Transactional Email API Integration
  private async sendEmail(to: string, subject: string, htmlContent: string): Promise<void> {
    if (!this.resendApiKey) return;
    try {
      await axios.post(
        "https://api.resend.com/emails",
        {
          from: "Breakpoint Travel Grants <grants@solana-rumbo.dev>",
          to: [to],
          subject: subject,
          html: htmlContent,
        },
        {
          headers: {
            Authorization: `Bearer ${this.resendApiKey}`,
            "Content-Type": "application/json",
          },
        }
      );
      console.log(`[RESEND EMAIL SENT] Confirmation delivered to ${to}`);
    } catch (err: any) {
      console.error("[RESEND EMAIL ERROR] Failed to send email:", err.response?.data || err.message);
    }
  }
}