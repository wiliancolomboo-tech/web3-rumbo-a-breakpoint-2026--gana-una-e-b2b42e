import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { expect } from "chai";
import { RumboProtocol } from "../target/types/rumbo_protocol";

describe("RumboProtocol: Breakpoint 2026 Travel & Grant Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.RumboProtocol as Program<RumboProtocol>;

  const committee = Keypair.generate();
  const builderAlice = Keypair.generate();
  const maliciousActor = Keypair.generate();

  const poolName = "Breakpoint-Latam-2026";
  const totalStipend = new anchor.BN(5 * LAMPORTS_PER_SOL);
  const maxBuilders = 10;
  const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 86400 * 30); // 30 days

  let grantPoolPda: PublicKey;
  let vaultPda: PublicKey;
  let aliceApplicationPda: PublicKey;
  let aliceTicketPda: PublicKey;

  before(async () => {
    // Airdrop accounts
    for (const kp of [committee, builderAlice, maliciousActor]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 20 * LAMPORTS_PER_SOL);
      const latestBlockhash = await provider.connection.getLatestBlockhash();
      await provider.connection.confirmTransaction({
        signature: sig,
        ...latestBlockhash,
      });
    }

    [grantPoolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("grant_pool"), committee.publicKey.toBuffer(), Buffer.from(poolName)],
      program.programId
    );

    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), grantPoolPda.toBuffer()],
      program.programId
    );

    [aliceApplicationPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("application"), grantPoolPda.toBuffer(), builderAlice.publicKey.toBuffer()],
      program.programId
    );

    [aliceTicketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("ticket"), grantPoolPda.toBuffer(), builderAlice.publicKey.toBuffer()],
      program.programId
    );
  });

  it("1. Initializes the Breakpoint 2026 Grant Pool and Escrows SOL", async () => {
    await program.methods
      .initializeGrantPool(poolName, totalStipend, maxBuilders, deadline)
      .accounts({
        grantPool: grantPoolPda,
        vault: vaultPda,
        authority: committee.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([committee])
      .rpc();

    // Fund the PDA vault with 15 SOL (sponsoring 3 full builders)
    const fundTx = new anchor.web3.Transaction().add(
      anchor.web3.SystemProgram.transfer({
        fromPubkey: committee.publicKey,
        toPubkey: vaultPda,
        lamports: 15 * LAMPORTS_PER_SOL,
      })
    );
    await provider.sendAndConfirm(fundTx, [committee]);

    const poolAccount = await program.account.grantPool.fetch(grantPoolPda);
    expect(poolAccount.poolName).to.equal(poolName);
    expect(poolAccount.totalStipendPerBuilder.toString()).to.equal(totalStipend.toString());
    expect(poolAccount.maxBuilders).to.equal(maxBuilders);

    const vaultBalance = await provider.connection.getBalance(vaultPda);
    expect(vaultBalance).to.be.at.least(15 * LAMPORTS_PER_SOL);
  });

  it("2. Allows Builder Alice to submit her travel application", async () => {
    await program.methods
      .applyForGrant("Alice Builder", "alice.dev@solana.org")
      .accounts({
        grantPool: grantPoolPda,
        application: aliceApplicationPda,
        builder: builderAlice.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([builderAlice])
      .rpc();

    const application = await program.account.builderApplication.fetch(aliceApplicationPda);
    expect(application.builderName).to.equal("Alice Builder");
    expect(application.contactEmail).to.equal("alice.dev@solana.org");
    expect(application.milestoneProgress).to.equal(0);
    expect(application.ticketIssued).to.be.false;
  });

  it("3. Prevents unauthorized actors from evaluating milestones", async () => {
    const proofHash = new Array(32).fill(1);
    try {
      await program.methods
        .evaluateMilestone(0, true, proofHash)
        .accounts({
          grantPool: grantPoolPda,
          application: aliceApplicationPda,
          authority: maliciousActor.publicKey,
        })
        .signers([maliciousActor])
        .rpc();
      expect.fail("Unauthorized evaluation should have failed");
    } catch (err: any) {
      expect(err.toString()).to.include("UnauthorizedCommittee");
    }
  });

  it("4. Committee approves Milestone 0 (Flight Ticket Proof)", async () => {
    const proofHash = new Array(32).fill(2);
    await program.methods
      .evaluateMilestone(0, true, proofHash)
      .accounts({
        grantPool: grantPoolPda,
        application: aliceApplicationPda,
        authority: committee.publicKey,
      })
      .signers([committee])
      .rpc();

    const application = await program.account.builderApplication.fetch(aliceApplicationPda);
    expect(application.milestones[0].approved).to.be.true;
    expect(application.milestones[0].paid).to.be.false;
    expect(application.milestoneProgress).to.equal(1);
  });

  it("5. Releases 30% stipend disbursement to Alice directly from vault PDA", async () => {
    const aliceBalanceBefore = await provider.connection.getBalance(builderAlice.publicKey);

    await program.methods
      .releaseMilestoneFunds(0)
      .accounts({
        grantPool: grantPoolPda,
        vault: vaultPda,
        application: aliceApplicationPda,
        builder: builderAlice.publicKey,
        authority: committee.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([committee])
      .rpc();

    const aliceBalanceAfter = await provider.connection.getBalance(builderAlice.publicKey);
    const expectedTranche = (5 * LAMPORTS_PER_SOL * 3000) / 10000; // 1.5 SOL

    expect(aliceBalanceAfter - aliceBalanceBefore).to.equal(expectedTranche);

    const application = await program.account.builderApplication.fetch(aliceApplicationPda);
    expect(application.milestones[0].paid).to.be.true;
    expect(application.fundsClaimed.toNumber()).to.equal(expectedTranche);
  });

  it("6. Prevents double-claiming milestone funds", async () => {
    try {
      await program.methods
        .releaseMilestoneFunds(0)
        .accounts({
          grantPool: grantPoolPda,
          vault: vaultPda,
          application: aliceApplicationPda,
          builder: builderAlice.publicKey,
          authority: committee.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([committee])
        .rpc();
      expect.fail("Should have prevented double payment");
    } catch (err: any) {
      expect(err.toString()).to.include("MilestoneAlreadyPaid");
    }
  });

  it("7. Issues non-transferable Breakpoint ticket pass to Alice", async () => {
    await program.methods
      .issueTicketCredential()
      .accounts({
        grantPool: grantPoolPda,
        application: aliceApplicationPda,
        ticketPass: aliceTicketPda,
        builder: builderAlice.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([builderAlice])
      .rpc();

    const ticket = await program.account.ticketPass.fetch(aliceTicketPda);
    expect(ticket.builder.toBase58()).to.equal(builderAlice.publicKey.toBase58());
    expect(ticket.ticketId).to.include("BP2026-");

    const application = await program.account.builderApplication.fetch(aliceApplicationPda);
    expect(application.ticketIssued).to.be.true;
  });

  it("8. Prevents early clawback before deadline expiration", async () => {
    try {
      await program.methods
        .clawbackUnclaimed()
        .accounts({
          grantPool: grantPoolPda,
          vault: vaultPda,
          authority: committee.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([committee])
        .rpc();
      expect.fail("Clawback must be locked prior to deadline");
    } catch (err: any) {
      expect(err.toString()).to.include("ClawbackLocked");
    }
  });
});