import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";
import { RumboBreakpoint } from "../target/types/rumbo_breakpoint";
import crypto from "crypto";

describe("rumbo_breakpoint", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.RumboBreakpoint as Program<RumboBreakpoint>;

  const admin = Keypair.generate();
  const evaluator = Keypair.generate();
  const builderAlice = Keypair.generate();
  const builderBob = Keypair.generate();

  const seasonId = 2026;
  const maxTickets = 50;
  const totalStipendCap = new anchor.BN(10 * LAMPORTS_PER_SOL);
  const minScoreThreshold = 75;

  let campaignPda: PublicKey;
  let campaignBump: number;
  let vaultPda: PublicKey;
  let vaultBump: number;

  before(async () => {
    // Airdrop funds to actors
    for (const actor of [admin, evaluator, builderAlice, builderBob]) {
      const sig = await provider.connection.requestAirdrop(actor.publicKey, 5 * LAMPORTS_PER_SOL);
      const latestBlockhash = await provider.connection.getLatestBlockhash();
      await provider.connection.confirmTransaction({
        signature: sig,
        ...latestBlockhash,
      });
    }

    const seasonBytes = Buffer.alloc(4);
    seasonBytes.writeUInt32LE(seasonId, 0);

    [campaignPda, campaignBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("campaign"), admin.publicKey.toBuffer(), seasonBytes],
      program.programId
    );

    [vaultPda, vaultBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("campaign_vault"), campaignPda.toBuffer()],
      program.programId
    );
  });

  it("1. Initializes Breakpoint 2026 Campaign and funds Vault PDA", async () => {
    await program.methods
      .initializeCampaign(seasonId, maxTickets, totalStipendCap, minScoreThreshold)
      .accounts({
        campaign: campaignPda,
        vault: vaultPda,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    // Deposit 5 SOL into Vault PDA for stipend liquidity
    const tx = new anchor.web3.Transaction().add(
      SystemProgram.transfer({
        fromPubkey: admin.publicKey,
        toPubkey: vaultPda,
        lamports: 5 * LAMPORTS_PER_SOL,
      })
    );
    await provider.sendAndConfirm(tx, [admin]);

    const campaignAccount = await program.account.campaign.fetch(campaignPda);
    expect(campaignAccount.admin.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(campaignAccount.seasonId).to.equal(seasonId);
    expect(campaignAccount.maxTickets).to.equal(maxTickets);
    expect(campaignAccount.ticketsAwarded).to.equal(0);
    expect(campaignAccount.minScoreThreshold).to.equal(minScoreThreshold);
  });

  it("2. Builder submits grant application for travel & ticket support", async () => {
    const [aliceAppPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("application"), campaignPda.toBuffer(), builderAlice.publicKey.toBuffer()],
      program.programId
    );

    const hashBuffer = crypto.createHash("sha256").update("github.com/alice/solana-zk-rollup").digest();
    const commitHashArray = Array.from(hashBuffer);

    const requestedStipend = new anchor.BN(2 * LAMPORTS_PER_SOL);

    await program.methods
      .applyForGrant("Alice Developer", "alice-sol", commitHashArray, requestedStipend)
      .accounts({
        application: aliceAppPda,
        campaign: campaignPda,
        applicant: builderAlice.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([builderAlice])
      .rpc();

    const app = await program.account.application.fetch(aliceAppPda);
    expect(app.applicant.toBase58()).to.equal(builderAlice.publicKey.toBase58());
    expect(app.githubHandle).to.equal("alice-sol");
    expect(app.requestedStipend.toString()).to.equal(requestedStipend.toString());
    expect(JSON.stringify(app.status)).to.include("submitted");
  });

  it("3. Evaluation committee scores and attests applicant above threshold", async () => {
    const [aliceAppPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("application"), campaignPda.toBuffer(), builderAlice.publicKey.toBuffer()],
      program.programId
    );

    const score = 92;
    const approvedAmount = new anchor.BN(1.5 * LAMPORTS_PER_SOL);

    await program.methods
      .attestContribution(score, approvedAmount)
      .accounts({
        campaign: campaignPda,
        application: aliceAppPda,
        admin: admin.publicKey,
        evaluator: evaluator.publicKey,
      })
      .signers([admin, evaluator])
      .rpc();

    const app = await program.account.application.fetch(aliceAppPda);
    expect(app.score).to.equal(score);
    expect(JSON.stringify(app.status)).to.include("approved");
    expect(app.approvedStipend.toString()).to.equal(approvedAmount.toString());
  });

  it("4. Releases travel stipend lamports directly from PDA Vault to builder", async () => {
    const [aliceAppPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("application"), campaignPda.toBuffer(), builderAlice.publicKey.toBuffer()],
      program.programId
    );

    const initialBalance = await provider.connection.getBalance(builderAlice.publicKey);

    await program.methods
      .disburseTravelStipend()
      .accounts({
        campaign: campaignPda,
        vault: vaultPda,
        application: aliceAppPda,
        applicant: builderAlice.publicKey,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    const finalBalance = await provider.connection.getBalance(builderAlice.publicKey);
    expect(finalBalance).to.be.greaterThan(initialBalance);

    const app = await program.account.application.fetch(aliceAppPda);
    expect(JSON.stringify(app.status)).to.include("funded");
    expect(app.approvedStipend.toNumber()).to.equal(0);
  });

  it("5. Mints Soulbound Breakpoint Ticket PDA receipt for attendee", async () => {
    const [aliceAppPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("application"), campaignPda.toBuffer(), builderAlice.publicKey.toBuffer()],
      program.programId
    );

    const [ticketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("ticket"), campaignPda.toBuffer(), builderAlice.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .claimBreakpointTicket()
      .accounts({
        campaign: campaignPda,
        application: aliceAppPda,
        ticket: ticketPda,
        applicant: builderAlice.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([builderAlice])
      .rpc();

    const ticket = await program.account.breakpointTicket.fetch(ticketPda);
    expect(ticket.owner.toBase58()).to.equal(builderAlice.publicKey.toBase58());
    expect(ticket.ticketNumber).to.equal(1);

    const campaign = await program.account.campaign.fetch(campaignPda);
    expect(campaign.ticketsAwarded).to.equal(1);
  });

  it("6. Rejects double-claim of Breakpoint Ticket (Anti-Sybil/Exploit Check)", async () => {
    const [aliceAppPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("application"), campaignPda.toBuffer(), builderAlice.publicKey.toBuffer()],
      program.programId
    );

    const [ticketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("ticket"), campaignPda.toBuffer(), builderAlice.publicKey.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .claimBreakpointTicket()
        .accounts({
          campaign: campaignPda,
          application: aliceAppPda,
          ticket: ticketPda,
          applicant: builderAlice.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([builderAlice])
        .rpc();
      expect.fail("Should have thrown error on double claim");
    } catch (err: any) {
      expect(err.toString()).to.include("TicketAlreadyClaimed");
    }
  });
});