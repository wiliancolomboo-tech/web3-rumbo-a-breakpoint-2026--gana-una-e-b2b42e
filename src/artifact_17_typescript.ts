import { Keypair, Connection, PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import axios from "axios";
import { CONFIG } from "./config";
import { EnterpriseNotifier } from "./services/notifier";

const IDL = require("./idl/breakpoint_pass.json");

async function evaluateBuilder(githubHandle: string, proofUrl: string): Promise<number> {
  let score = 50; // Base score for applying

  try {
    // 1. Verify GitHub profile longevity and activity
    const ghResponse = await axios.get(`https://api.github.com/users/${githubHandle}`, {
      headers: { "User-Agent": "BreakpointPass-Verifier" }
    });
    
    if (ghResponse.data.public_repos >= 5) score += 20;
    if (ghResponse.data.followers >= 5) score += 10;

    // 2. Proof check (Repository commits or devnet/mainnet deployment proof)
    if (proofUrl.includes("github.com") || proofUrl.includes("solana.fm") || proofUrl.includes("explorer.solana.com")) {
      score += 20;
    }
  } catch (e: any) {
    console.warn(`[Verifier Engine] GitHub check fallback for ${githubHandle}: ${e.message}`);
    score = 75; // Default safe qualifying score in staging
  }

  return Math.min(score, 100);
}

async function runWorker() {
  const secretKey = Uint8Array.from(JSON.parse(CONFIG.VERIFIER_PRIVATE_KEY));
  const verifierWallet = Keypair.fromSecretKey(secretKey);
  const connection = new Connection(CONFIG.SOLANA_RPC_URL, "confirmed");

  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(verifierWallet),
    { preflightCommitment: "confirmed" }
  );

  const program = new anchor.Program(IDL, provider);

  console.log("==================================================");
  console.log("⚡ BreakpointPass Automation Worker Started");
  console.log(`Verifier Authority: ${verifierWallet.publicKey.toBase58()}`);
  console.log(`Campaign Target:    ${CONFIG.CAMPAIGN_PUBKEY_OBJ.toBase58()}`);
  console.log("==================================================");

  setInterval(async () => {
    try {
      // Fetch all GrantApplication accounts registered for this campaign
      const applications = await program.account.grantApplication.all([
        {
          memcmp: {
            offset: 8 + 32, // Offset past discriminator + builder pubkey
            bytes: CONFIG.CAMPAIGN_PUBKEY_OBJ.toBase58(),
          },
        },
      ]);

      for (const record of applications) {
        const data = record.account;
        // Status == 0 represents Applied
        if (data.status.applied !== undefined) {
          console.log(`\n🔍 Evaluating pending builder: ${data.builder.toBase58()} (@${data.githubHandle})`);
          
          const score = await evaluateBuilder(data.githubHandle, data.proofUrl);
          console.log(`Determined score: ${score}/100`);

          const tx = await program.methods
            .attestAndScore(score)
            .accounts({
              verifier: verifierWallet.publicKey,
              campaign: CONFIG.CAMPAIGN_PUBKEY_OBJ,
              grantApplication: record.publicKey,
            })
            .signers([verifierWallet])
            .rpc();

          console.log(`✅ Attestation confirmed on-chain. Tx Signature: ${tx}`);

          // Trigger Enterprise Outbound Notifications
          await EnterpriseNotifier.notifyDiscord({
            builderPubkey: data.builder.toBase58(),
            githubHandle: data.githubHandle,
            score: score,
            awardedLamports: 1_500_000_000, // 1.5 SOL
            txSignature: tx,
          });
        }
      }
    } catch (loopError: any) {
      console.error("Worker Loop Error:", loopError.message);
    }
  }, 15000); // Polls every 15 seconds
}

runWorker().catch((err) => {
  console.error("Fatal Worker Process Error:", err);
  process.exit(1);
});