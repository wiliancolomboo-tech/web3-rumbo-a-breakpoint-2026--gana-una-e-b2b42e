import { Command } from "commander";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { RumboNotificationDispatcher } from "./relayer";
import * as crypto from "crypto";

const programId = new PublicKey("RumbokZ3JcQWjC1E4uV4bZzK9f4w4hE2n8z1yX7pL5q");

async function main() {
  console.log("=== RUMBO A BREAKPOINT 2026: AUTOMATION CLI ===");
  const connection = new anchor.web3.Connection(
    process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
    "confirmed"
  );

  console.log(`Connected to Solana cluster. Program ID: ${programId.toBase58()}`);

  // Test Resend integration directly
  if (process.env.TEST_EMAIL) {
    console.log(`Executing test notification to: ${process.env.TEST_EMAIL}`);
    await RumboNotificationDispatcher.sendGranteePassEmail(process.env.TEST_EMAIL, {
      applicant: "73kY...w4hE",
      github: "solana-builder",
      approvedStipendLamports: 2.5 * LAMPORTS_PER_SOL,
    });
  }
}

main().catch(console.error);