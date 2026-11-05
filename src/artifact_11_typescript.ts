import { Command } from "commander";
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL, SystemProgram } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet, BN } from "@coral-xyz/anchor";
import bs58 from "bs58";
import dotenv from "dotenv";

dotenv.config();

const programCli = new Command();
programCli.name("rumbo-cli").description("CLI to manage Rumbo a Breakpoint 2026 competitions");

function getProvider() {
  const connection = new Connection(process.env.SOLANA_RPC_URL || "http://127.0.0.1:8899", "confirmed");
  const secretKey = bs58.decode(process.env.OPERATOR_PRIVATE_KEY || "");
  const keypair = Keypair.fromSecretKey(secretKey);
  const wallet = new Wallet(keypair);
  return new AnchorProvider(connection, wallet, { commitment: "confirmed" });
}

programCli
  .command("init-competition")
  .description("Create a new Breakpoint fellowship competition")
  .requiredOption("-i, --id <competitionId>", "Unique ID for competition")
  .requiredOption("-a, --amount <sol>", "Total award amount in SOL", "5.0")
  .requiredOption("-t, --threshold <jurors>", "Number of jurors needed", "2")
  .action(async (opts) => {
    const provider = getProvider();
    const programId = new PublicKey(process.env.PROGRAM_ID || "Rumbo111111111111111111111111111111111111111");
    
    // Read IDL dynamically in production
    const [competitionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("competition"), Buffer.from(opts.id)],
      programId
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("rumbo_vault"), competitionPda.toBuffer()],
      programId
    );

    console.log(`[CLI] Initializing competition: ${opts.id}`);
    console.log(`[CLI] Competition PDA: ${competitionPda.toBase58()}`);
    console.log(`[CLI] Vault PDA: ${vaultPda.toBase58()}`);

    // Fund the vault with grant funds
    const awardLamports = parseFloat(opts.amount) * LAMPORTS_PER_SOL;
    const tx = await provider.sendAndConfirm(
      new (await import("@solana/web3.js")).Transaction().add(
        SystemProgram.transfer({
          fromPubkey: provider.wallet.publicKey,
          toPubkey: vaultPda,
          lamports: awardLamports,
        })
      )
    );

    console.log(`✅ Vault funded successfully. Tx signature: ${tx}`);
  });

programCli.parse(process.argv);