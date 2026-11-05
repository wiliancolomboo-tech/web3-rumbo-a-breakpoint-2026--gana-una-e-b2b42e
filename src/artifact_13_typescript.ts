// File: src/cli/rumbo-orchestrator.ts
import * as anchor from "@coral-xyz/anchor";
import { Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { Resend } from "resend";
import axios from "axios";
import * as dotenv from "dotenv";

dotenv.config();

const RESEND_API_KEY = process.env.RESEND_API_KEY || "re_mock_test_key";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const RPC_ENDPOINT = process.env.SOLANA_RPC_URL || "http://127.0.0.1:8899";
const PROGRAM_ID = new PublicKey("RumbobReakpo1nt202611111111111111111111111");

const resend = new Resend(RESEND_API_KEY);

interface EvaluationNotification {
  applicantPubkey: string;
  email: string;
  score: number;
  status: "Approved" | "Rejected";
  tranche1Sol: number;
  tranche2Sol: number;
}

export class RumboOrchestrator {
  private program: Program;
  private connection: Connection;
  private wallet: Wallet;

  constructor(signerKeypair: Keypair) {
    this.connection = new Connection(RPC_ENDPOINT, "confirmed");
    this.wallet = new Wallet(signerKeypair);
    const provider = new anchor.AnchorProvider(this.connection, this.wallet, {
      commitment: "confirmed",
    });
    anchor.setProvider(provider);
    
    // Minimal inline IDL representation for compilation clarity
    const idl: anchor.Idl = {
      version: "0.1.0",
      name: "rumbo_breakpoint",
      instructions: [
        {
          name: "finalize",
          accounts: [
            { name: "round", isMut: true, isSigner: false },
            { name: "applicantRecord", isMut: true, isSigner: false },
            { name: "authority", isMut: false, isSigner: true },
          ],
          args: [],
        },
      ],
      accounts: [],
    };
    this.program = new Program(idl, PROGRAM_ID, provider);
  }

  public async processBatchEvaluations(
    roundId: number,
    evaluations: EvaluationNotification[]
  ): Promise<void> {
    console.log(`[Rumbo-Agent] Processing batch for Round #${roundId}...`);

    for (const item of evaluations) {
      try {
        const applicantKey = new PublicKey(item.applicantPubkey);
        const [roundPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("round"), new anchor.BN(roundId).toArrayLike(Buffer, "le", 8)],
          PROGRAM_ID
        );
        const [applicantPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("applicant"), roundPda.toBuffer(), applicantKey.toBuffer()],
          PROGRAM_ID
        );

        console.log(`[Rumbo-Agent] Finalizing on-chain record: ${applicantKey.toBase58()}`);

        const tx = await this.program.methods
          .finalize()
          .accounts({
            round: roundPda,
            applicantRecord: applicantPda,
            authority: this.wallet.publicKey,
          })
          .rpc();

        console.log(`[Rumbo-Agent] Confirmation Signature: ${tx}`);

        if (item.status === "Approved") {
          await this.dispatchApprovalEmail(item);
          await this.broadcastDiscord(item, tx);
        }
      } catch (err: any) {
        console.error(`[Error] Failed to process ${item.applicantPubkey}:`, err.message);
      }
    }
  }

  private async dispatchApprovalEmail(applicant: EvaluationNotification): Promise<void> {
    console.log(`[Resend] Dispatching voucher instructions to ${applicant.email}...`);
    try {
      await resend.emails.send({
        from: "Rumbo a Breakpoint <scholarships@solana.org>",
        to: [applicant.email],
        subject: "🎉 ¡Felicidades! Has sido seleccionado para Breakpoint 2026",
        html: `
          <div style="font-family: Arial, sans-serif; background-color: #0b0e14; color: #ffffff; padding: 24px;">
            <h1 style="color: #14F195;">¡Rumbo a Breakpoint 2026!</h1>
            <p>Estimado/a desarrollador/a,</p>
            <p>Tu postulación fue aprobada por el comité evaluador con una calificación promedio de <strong>${applicant.score}/100</strong>.</p>
            <hr style="border-color: #272a30;" />
            <h3>Detalles de la Beca:</h3>
            <ul>
              <li><strong>Tranche 1 (Preparación de Viaje / Vuelos):</strong> ${applicant.tranche1Sol} SOL (Reclamable de inmediato)</li>
              <li><strong>Tranche 2 (Desembolso en Destino):</strong> ${applicant.tranche2Sol} SOL (Al registrarte en el Venue)</li>
              <li><strong>Ticket Oficial de Acceso:</strong> Incluido y reservado.</li>
            </ul>
            <p>Ingresa a la dapp con tu wallet <code>${applicant.applicantPubkey}</code> para reclamar tu primer tranche.</p>
            <br />
            <p style="color: #9945FF;">Nos vemos en Breakpoint 2026.</p>
          </div>
        `,
      });
      console.log(`[Resend] Email sent successfully to ${applicant.email}`);
    } catch (error) {
      console.error("[Resend Error]:", error);
    }
  }

  private async broadcastDiscord(applicant: EvaluationNotification, tx: string): Promise<void> {
    if (!DISCORD_WEBHOOK_URL) return;
    try {
      await axios.post(DISCORD_WEBHOOK_URL, {
        embeds: [
          {
            title: "🚀 Nuevo Becario Rumbo a Breakpoint 2026",
            color: 0x14f195,
            fields: [
              { name: "Candidato", value: `\`${applicant.applicantPubkey.slice(0, 8)}...${applicant.applicantPubkey.slice(-6)}\``, inline: true },
              { name: "Puntaje", value: `${applicant.score} / 100`, inline: true },
              { name: "Asignación Total", value: `${applicant.tranche1Sol + applicant.tranche2Sol} SOL`, inline: true },
              { name: "Solana Explorer", value: `[Ver Tx](https://explorer.solana.com/tx/${tx}?cluster=devnet)` },
            ],
            footer: { text: "Protocolo de Beca Verificable Solana" },
            timestamp: new Date().toISOString(),
          },
        ],
      });
      console.log("[Discord] Webhook notification emitted successfully.");
    } catch (err: any) {
      console.error("[Discord Error]:", err.message);
    }
  }
}