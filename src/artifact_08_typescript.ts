import { Command } from "commander";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import * as fs from "fs";
import * as dotenv from "dotenv";
import { EnterpriseNotifier } from "./notifier";

dotenv.config();

const programId = new PublicKey(
  process.env.PROGRAM_ID || "Cam1no1111111111111111111111111111111111111"
);
const idl = JSON.parse(fs.readFileSync("./target/idl/camino_escrow.json", "utf8"));

function loadWallet(path: string): Keypair {
  const secretKey = JSON.parse(fs.readFileSync(path, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(secretKey));
}

const programCli = new Command();
programCli
  .name("camino-cli")
  .description("Camino Protocol - Rumbo a Breakpoint 2026 Admin CLI")
  .version("1.0.0");

programCli
  .command("init-campaign")
  .requiredOption("-k, --keypair <path>", "Path to admin keypair JSON")
  .requiredOption("-i, --id <number>", "Campaign ID (u64)", "2026")
  .requiredOption("-t, --title <string>", "Title", "Rumbo a Breakpoint 2026")
  .requiredOption("-s, --stipend <amount>", "Stipend in token base units", "2500000000") // 2500 USDC
  .requiredOption("-m, --max-grantees <number>", "Max grantees", "10")
  .requiredOption("-mint, --token-mint <pubkey>", "SPL Token Mint Address (e.g. USDC)")
  .action(async (opts) => {
    const admin = loadWallet(opts.keypair);
    const connection = new Connection(process.env.SOLANA_RPC_URL || "http://127.0.0.1:8899", "confirmed");
    const wallet = new anchor.Wallet(admin);
    const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
    const program = new anchor.Program(idl, provider);

    const campaignId = new anchor.BN(opts.id);
    const tokenMint = new PublicKey(opts.tokenMint);

    const [campaignPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("campaign"), campaignId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    const [vaultPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), campaignId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    console.log(`Initializing Campaign: ${opts.title} (ID: ${opts.id})`);
    const tx = await program.methods
      .initializeCampaign(
        campaignId,
        opts.title,
        new anchor.BN(opts.stipend),
        parseInt(opts.maxGrantees, 10)
      )
      .accounts({
        campaign: campaignPDA,
        tokenMint: tokenMint,
        vault: vaultPDA,
        admin: admin.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    console.log(`Campaign initialized. Tx Signature: ${tx}`);
    console.log(`Campaign PDA: ${campaignPDA.toBase58()}`);
    console.log(`Vault PDA:    ${vaultPDA.toBase58()}`);
  });

programCli
  .command("approve")
  .requiredOption("-k, --keypair <path>", "Path to admin keypair JSON")
  .requiredOption("-i, --id <number>", "Campaign ID", "2026")
  .requiredOption("-a, --applicant <pubkey>", "Applicant public key")
  .action(async (opts) => {
    const admin = loadWallet(opts.keypair);
    const connection = new Connection(process.env.SOLANA_RPC_URL || "http://127.0.0.1:8899", "confirmed");
    const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), { commitment: "confirmed" });
    const program = new anchor.Program(idl, provider);

    const campaignId = new anchor.BN(opts.id);
    const applicantPubkey = new PublicKey(opts.applicant);

    const [campaignPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("campaign"), campaignId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [applicationPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("application"), campaignPDA.toBuffer(), applicantPubkey.toBuffer()],
      program.programId
    );

    const tx = await program.methods
      .approveApplication()
      .accounts({
        campaign: campaignPDA,
        application: applicationPDA,
        admin: admin.publicKey,
      })
      .rpc();

    console.log(`Applicant ${opts.applicant} approved! Tx: ${tx}`);

    const notifier = new EnterpriseNotifier();
    await notifier.sendWebhook("BUILDER_APPROVED", {
      campaignId: opts.id,
      applicant: opts.applicant,
      tx,
    });
  });

programCli.parse(process.argv);