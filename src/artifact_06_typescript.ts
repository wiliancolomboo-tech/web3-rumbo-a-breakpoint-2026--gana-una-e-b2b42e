import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { expect } from "chai";
import crypto from "crypto";

describe("rumbo_breakpoint e2e test suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.RumboBreakpoint as Program<any>;

  const authority = (provider.wallet as anchor.Wallet).payer;
  const builder = Keypair.generate();
  const cohortId = "BP2026-LATAM-ROUND-1";

  let vaultMint: PublicKey;
  let authorityTokenAccount: PublicKey;
  let builderTokenAccount: PublicKey;
  let cohortPda: PublicKey;
  let cohortBump: number;
  let vaultAccountPda: PublicKey;
  let applicationPda: PublicKey;

  const maxStipend = new anchor.BN(1_500 * 1_000_000); // 1,500 USDC
  const fundAmount = new anchor.BN(10_000 * 1_000_000); // 10,000 USDC
  const requestedStipend = new anchor.BN(1_500 * 1_000_000);
  const milestoneCount = 3;

  before(async () => {
    // 1. Airdrop SOL to builder
    const sig = await provider.connection.requestAirdrop(
      builder.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig);

    // 2. Create USDC Mock Mint
    vaultMint = await createMint(
      provider.connection,
      authority,
      authority.publicKey,
      null,
      6
    );

    // 3. Derive Cohort & Vault PDAs
    [cohortPda, cohortBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("cohort"), Buffer.from(cohortId)],
      program.programId
    );

    [vaultAccountPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), cohortPda.toBuffer()],
      program.programId
    );

    // 4. Create Token Accounts & Mint Supply
    authorityTokenAccount = await createAccount(
      provider.connection,
      authority,
      vaultMint,
      authority.publicKey
    );

    builderTokenAccount = await createAccount(
      provider.connection,
      authority,
      vaultMint,
      builder.publicKey
    );

    await mintTo(
      provider.connection,
      authority,
      vaultMint,
      authorityTokenAccount,
      authority,
      20_000 * 1_000_000
    );

    [applicationPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("application"), cohortPda.toBuffer(), builder.publicKey.toBuffer()],
      program.programId
    );
  });

  it("1. Initializes the Breakpoint 2026 Cohort", async () => {
    const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 86400 * 30);
    const ticketQuota = 10;

    await program.methods
      .initializeCohort(cohortId, ticketQuota, maxStipend, deadline)
      .accounts({
        authority: authority.publicKey,
        cohort: cohortPda,
        vaultMint: vaultMint,
        vaultAccount: vaultAccountPda,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const cohortData = await program.account.cohort.fetch(cohortPda);
    expect(cohortData.cohortId).to.equal(cohortId);
    expect(cohortData.ticketQuota).to.equal(10);
    expect(cohortData.authority.toBase58()).to.equal(authority.publicKey.toBase58());
  });

  it("2. Funds the Cohort PDA Escrow with 10,000 USDC", async () => {
    await program.methods
      .fundCohort(fundAmount)
      .accounts({
        funder: authority.publicKey,
        cohort: cohortPda,
        funderTokenAccount: authorityTokenAccount,
        vaultAccount: vaultAccountPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const vaultBalance = await getAccount(provider.connection, vaultAccountPda);
    expect(Number(vaultBalance.amount)).to.equal(fundAmount.toNumber());
  });

  it("3. Builder submits travel grant proposal with 3 milestones", async () => {
    const proposalHash = Array.from(crypto.createHash("sha256").update("Solana Pay POS Mobile").digest());

    await program.methods
      .submitApplication(proposalHash, requestedStipend, milestoneCount)
      .accounts({
        builder: builder.publicKey,
        cohort: cohortPda,
        application: applicationPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([builder])
      .rpc();

    const appData = await program.account.application.fetch(applicationPda);
    expect(appData.builder.toBase58()).to.equal(builder.publicKey.toBase58());
    expect(appData.milestonesCount).to.equal(3);
    expect(appData.status).to.deep.equal({ submitted: {} });
  });

  it("4. Foundation reviews and approves application & awards ticket voucher", async () => {
    await program.methods
      .reviewApplication(true)
      .accounts({
        authority: authority.publicKey,
        cohort: cohortPda,
        application: applicationPda,
      })
      .rpc();

    const appData = await program.account.application.fetch(applicationPda);
    expect(appData.status).to.deep.equal({ approved: {} });
    expect(appData.ticketAwarded).to.be.true;

    const cohortData = await program.account.cohort.fetch(cohortPda);
    expect(cohortData.ticketsAwarded).to.equal(1);
    expect(cohortData.totalFundsAllocated.toNumber()).to.equal(requestedStipend.toNumber());
  });

  it("5. Builder submits milestone #1 proof", async () => {
    const proofHash = Array.from(crypto.createHash("sha256").update("github.com/pr/1").digest());

    await program.methods
      .submitMilestoneProof(proofHash)
      .accounts({
        builder: builder.publicKey,
        application: applicationPda,
      })
      .signers([builder])
      .rpc();

    const appData = await program.account.application.fetch(applicationPda);
    expect(appData.currentMilestone).to.equal(1);
    expect(appData.milestonesCompleted).to.equal(0);
  });

  it("6. Reviewer verifies and releases 1st tranche (500 USDC)", async () => {
    const initialBalance = await getAccount(provider.connection, builderTokenAccount);

    await program.methods
      .releaseMilestoneStipend()
      .accounts({
        reviewer: authority.publicKey,
        cohort: cohortPda,
        application: applicationPda,
        grantee: builder.publicKey,
        granteeTokenAccount: builderTokenAccount,
        vaultAccount: vaultAccountPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const finalBalance = await getAccount(provider.connection, builderTokenAccount);
    const diff = Number(finalBalance.amount) - Number(initialBalance.amount);
    expect(diff).to.equal(500 * 1_000_000); // 1,500 / 3 = 500 USDC

    const appData = await program.account.application.fetch(applicationPda);
    expect(appData.milestonesCompleted).to.equal(1);
  });

  it("7. Fails when builder tries to claim next tranche before submitting proof", async () => {
    try {
      await program.methods
        .releaseMilestoneStipend()
        .accounts({
          reviewer: authority.publicKey,
          cohort: cohortPda,
          application: applicationPda,
          grantee: builder.publicKey,
          granteeTokenAccount: builderTokenAccount,
          vaultAccount: vaultAccountPda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      expect.fail("Should have thrown NoMilestonePendingRelease");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("NoMilestonePendingRelease");
    }
  });

  it("8. Fails when unauthorized caller attempts to review application", async () => {
    const impostor = Keypair.generate();
    try {
      await program.methods
        .reviewApplication(false)
        .accounts({
          authority: impostor.publicKey,
          cohort: cohortPda,
          application: applicationPda,
        })
        .signers([impostor])
        .rpc();
      expect.fail("Should have failed with unauthorized error");
    } catch (err: any) {
      expect(err).to.exist;
    }
  });
});