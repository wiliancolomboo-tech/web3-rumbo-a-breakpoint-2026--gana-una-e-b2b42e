import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { RumboBreakpoint } from "../target/types/rumbo_breakpoint";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, SystemProgram, PublicKey } from "@solana/web3.js";
import { assert, expect } from "chai";

describe("Rumbo Breakpoint 2026 - Comprehensive Test Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.RumboBreakpoint as Program<RumboBreakpoint>;

  const authority = Keypair.generate();
  const builder = Keypair.generate();
  const unauthorizedUser = Keypair.generate();

  let usdcMint: PublicKey;
  let authorityTokenAccount: PublicKey;
  let builderTokenAccount: PublicKey;
  let poolPda: PublicKey;
  let vaultPda: PublicKey;
  let appPda: PublicKey;

  const poolId = new anchor.BN(2026);
  const totalTickets = 5;
  const grantAmount = new anchor.BN(2_500_000_000); // 2,500 USDC (6 decimals)
  const depositFunding = new anchor.BN(12_500_000_000); // 12,500 USDC

  before(async () => {
    // Airdrop SOL to test actors
    const airdropSigners = [authority, builder, unauthorizedUser];
    for (const signer of airdropSigners) {
      const sig = await provider.connection.requestAirdrop(signer.publicKey, 10_000_000_000);
      const latestBlockhash = await provider.connection.getLatestBlockhash();
      await provider.connection.confirmTransaction({
        signature: sig,
        ...latestBlockhash,
      });
    }

    // Create Mock USDC Token Mint
    usdcMint = await createMint(
      provider.connection,
      authority,
      authority.publicKey,
      null,
      6
    );

    // Create Token Accounts
    authorityTokenAccount = await createAccount(
      provider.connection,
      authority,
      usdcMint,
      authority.publicKey
    );

    builderTokenAccount = await createAccount(
      provider.connection,
      builder,
      usdcMint,
      builder.publicKey
    );

    // Mint USDC to Authority
    await mintTo(
      provider.connection,
      authority,
      usdcMint,
      authorityTokenAccount,
      authority,
      depositFunding.toNumber()
    );

    // Derive PDAs
    [poolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("travel_pool"), poolId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("grant_vault"), poolId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [appPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("builder_app"),
        poolPda.toBuffer(),
        builder.publicKey.toBuffer(),
      ],
      program.programId
    );
  });

  it("1. Initializes Breakpoint 2026 pool successfully", async () => {
    const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 86400 * 30); // 30 days future

    await program.methods
      .initializePool(poolId, totalTickets, grantAmount, deadline)
      .accounts({
        pool: poolPda,
        mint: usdcMint,
        vault: vaultPda,
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([authority])
      .rpc();

    const poolState = await program.account.grantPool.fetch(poolPda);
    assert.equal(poolState.totalTicketAllocation, totalTickets);
    assert.equal(poolState.remainingTickets, totalTickets);
    assert.equal(poolState.grantPerWinner.toString(), grantAmount.toString());
    assert.equal(poolState.authority.toBase58(), authority.publicKey.toBase58());
  });

  it("2. Deposits funding into the pool PDA vault", async () => {
    await program.methods
      .depositPoolFunds(depositFunding)
      .accounts({
        pool: poolPda,
        vault: vaultPda,
        funderTokenAccount: authorityTokenAccount,
        funder: authority.publicKey,
        authority: authority.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([authority])
      .rpc();

    const vaultInfo = await getAccount(provider.connection, vaultPda);
    assert.equal(vaultInfo.amount.toString(), depositFunding.toString());

    const poolState = await program.account.grantPool.fetch(poolPda);
    assert.equal(poolState.totalFunded.toString(), depositFunding.toString());
  });

  it("3. Builder submits Breakpoint grant application", async () => {
    const githubBytes = new Array(32).fill(0);
    const mockHandle = Buffer.from("superteam-builder");
    mockHandle.copy(Buffer.from(githubBytes));

    const commitBytes = new Array(32).fill(7);

    await program.methods
      .submitApplication(githubBytes, commitBytes)
      .accounts({
        application: appPda,
        pool: poolPda,
        builder: builder.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([builder])
      .rpc();

    const appState = await program.account.builderApplication.fetch(appPda);
    assert.equal(appState.builder.toBase58(), builder.publicKey.toBase58());
    assert.equal(appState.milestonesCompleted, 0);
    assert.deepEqual(appState.status, { underReview: {} });
  });

  it("4. Rejects out-of-order milestone progression (Edge Case)", async () => {
    const proofBytes = new Array(32).fill(9);

    try {
      // Trying to evaluate milestone #2 before completing milestone #1
      await program.methods
        .evaluateMilestone(2, true, proofBytes)
        .accounts({
          pool: poolPda,
          application: appPda,
          authority: authority.publicKey,
        })
        .signers([authority])
        .rpc();
      assert.fail("Should have thrown InvalidMilestoneSequence");
    } catch (err: any) {
      expect(err.toString()).to.include("InvalidMilestoneSequence");
    }
  });

  it("5. Sequentially approves milestones 1, 2, and 3", async () => {
    const proofBytes = new Array(32).fill(1);

    for (let milestone = 1; milestone <= 3; milestone++) {
      await program.methods
        .evaluateMilestone(milestone, true, proofBytes)
        .accounts({
          pool: poolPda,
          application: appPda,
          authority: authority.publicKey,
        })
        .signers([authority])
        .rpc();
    }

    const appState = await program.account.builderApplication.fetch(appPda);
    assert.equal(appState.milestonesCompleted, 3);
    assert.deepEqual(appState.status, { approved: {} });
  });

  it("6. Unauthorized entity cannot trigger grant and ticket disbursement", async () => {
    try {
      await program.methods
        .disburseGrantAndTicket()
        .accounts({
          pool: poolPda,
          vault: vaultPda,
          application: appPda,
          builder: builder.publicKey,
          builderTokenAccount: builderTokenAccount,
          authority: unauthorizedUser.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([unauthorizedUser])
        .rpc();
      assert.fail("Should have thrown Unauthorized error");
    } catch (err: any) {
      expect(err.toString()).to.include("Unauthorized");
    }
  });

  it("7. Disburses travel grant USDC and allocates Breakpoint 2026 ticket", async () => {
    const initialBuilderBalance = (
      await getAccount(provider.connection, builderTokenAccount)
    ).amount;

    await program.methods
      .disburseGrantAndTicket()
      .accounts({
        pool: poolPda,
        vault: vaultPda,
        application: appPda,
        builder: builder.publicKey,
        builderTokenAccount: builderTokenAccount,
        authority: authority.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([authority])
      .rpc();

    const finalBuilderBalance = (
      await getAccount(provider.connection, builderTokenAccount)
    ).amount;
    assert.equal(
      (finalBuilderBalance - initialBuilderBalance).toString(),
      grantAmount.toString()
    );

    const poolState = await program.account.grantPool.fetch(poolPda);
    assert.equal(poolState.remainingTickets, totalTickets - 1);
    assert.equal(poolState.totalDisbursed.toString(), grantAmount.toString());

    const appState = await program.account.builderApplication.fetch(appPda);
    assert.isTrue(appState.ticketAwarded);
    assert.deepEqual(appState.status, { completed: {} });
  });

  it("8. Prevents double-spending/double-claiming ticket awards", async () => {
    try {
      await program.methods
        .disburseGrantAndTicket()
        .accounts({
          pool: poolPda,
          vault: vaultPda,
          application: appPda,
          builder: builder.publicKey,
          builderTokenAccount: builderTokenAccount,
          authority: authority.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([authority])
        .rpc();
      assert.fail("Should have prevented double claiming");
    } catch (err: any) {
      expect(err.toString()).to.include("ApplicationNotApproved");
    }
  });
});