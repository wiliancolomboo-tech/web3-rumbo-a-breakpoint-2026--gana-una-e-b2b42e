import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { RumboProtocol } from "../target/types/rumbo_protocol";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { assert, expect } from "chai";

describe("rumbo-protocol tests", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.RumboProtocol as Program<RumboProtocol>;

  const admin = Keypair.generate();
  const committee1 = Keypair.generate();
  const committee2 = Keypair.generate();
  const builder = Keypair.generate();
  const maliciousActor = Keypair.generate();

  let tokenMint: PublicKey;
  let programStatePda: PublicKey;
  let vaultPda: PublicKey;

  const PROGRAM_STATE_SEED = Buffer.from("program_state");
  const APPLICATION_SEED = Buffer.from("grant_application");
  const VAULT_SEED = Buffer.from("escrow_vault");

  before(async () => {
    // Airdrop SOL to test actors
    for (const actor of [admin, committee1, committee2, builder, maliciousActor]) {
      const sig = await provider.connection.requestAirdrop(actor.publicKey, 10 * LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig, "confirmed");
    }

    // Derive PDAs
    [programStatePda] = PublicKey.findProgramAddressSync([PROGRAM_STATE_SEED], program.programId);
    [vaultPda] = PublicKey.findProgramAddressSync([VAULT_SEED, programStatePda.toBuffer()], program.programId);

    // Create Mock USDC Token Mint
    tokenMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6
    );
  });

  it("1. Initializes global program with 2-of-2 committee quorum", async () => {
    const requiredAttestations = 2;
    const committee = [committee1.publicKey, committee2.publicKey];

    await program.methods
      .initializeProgram(requiredAttestations, committee)
      .accounts({
        admin: admin.publicKey,
        tokenMint: tokenMint,
        programState: programStatePda,
        vault: vaultPda,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      } as any)
      .signers([admin])
      .rpc();

    const state = await program.account.programState.fetch(programStatePda);
    assert.equal(state.admin.toBase58(), admin.publicKey.toBase58());
    assert.equal(state.requiredAttestations, 2);
    assert.equal(state.committee.length, 2);
    assert.equal(state.totalApplications.toNumber(), 0);

    // Fund the escrow vault with 5,000 mock USDC
    await mintTo(
      provider.connection,
      admin,
      tokenMint,
      vaultPda,
      admin,
      5000 * 1_000_000
    );

    const vaultAccount = await getAccount(provider.connection, vaultPda);
    assert.equal(Number(vaultAccount.amount), 5000 * 1_000_000);
  });

  it("2. Submits builder application with milestone tranches", async () => {
    const stateBefore = await program.account.programState.fetch(programStatePda);
    const appId = stateBefore.totalApplications;

    const appIdBuffer = Buffer.alloc(8);
    appIdBuffer.writeBigUInt64LE(BigInt(appId.toNumber()));

    const [applicationPda] = PublicKey.findProgramAddressSync(
      [APPLICATION_SEED, programStatePda.toBuffer(), appIdBuffer],
      program.programId
    );

    // Milestone 1 (Flight): 1,200 USDC | Milestone 2 (Lodging/Demo): 800 USDC
    const milestones = [new anchor.BN(1200 * 1e6), new anchor.BN(800 * 1e6)];
    const uri = "https://ipfs.io/ipfs/QmRumboBreakpoint2026Applicant1";

    await program.methods
      .submitApplication(milestones, uri)
      .accounts({
        builder: builder.publicKey,
        programState: programStatePda,
        application: applicationPda,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([builder])
      .rpc();

    const app = await program.account.grantApplication.fetch(applicationPda);
    assert.equal(app.builder.toBase58(), builder.publicKey.toBase58());
    assert.equal(app.totalAllocated.toNumber(), 2000 * 1e6);
    assert.equal(app.milestonesCompleted, 0);
  });

  it("3. Enforces authorization: Malicious actor cannot attest milestones", async () => {
    const appId = new anchor.BN(0);
    const appIdBuffer = Buffer.alloc(8);
    appIdBuffer.writeBigUInt64LE(BigInt(0));

    const [applicationPda] = PublicKey.findProgramAddressSync(
      [APPLICATION_SEED, programStatePda.toBuffer(), appIdBuffer],
      program.programId
    );

    try {
      await program.methods
        .attestMilestone(appId, 0)
        .accounts({
          committeeMember: maliciousActor.publicKey,
          programState: programStatePda,
          application: applicationPda,
        } as any)
        .signers([maliciousActor])
        .rpc();
      assert.fail("Should have failed with UnauthorizedCommitteeMember");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("UnauthorizedCommitteeMember");
    }
  });

  it("4. Milestone quorum check: 1-of-2 attestations fails release", async () => {
    const appId = new anchor.BN(0);
    const appIdBuffer = Buffer.alloc(8);
    appIdBuffer.writeBigUInt64LE(BigInt(0));

    const [applicationPda] = PublicKey.findProgramAddressSync(
      [APPLICATION_SEED, programStatePda.toBuffer(), appIdBuffer],
      program.programId
    );

    // First committee member signs
    await program.methods
      .attestMilestone(appId, 0)
      .accounts({
        committeeMember: committee1.publicKey,
        programState: programStatePda,
        application: applicationPda,
      } as any)
      .signers([committee1])
      .rpc();

    // Create builder token account
    const builderAta = await createAccount(
      provider.connection,
      builder,
      tokenMint,
      builder.publicKey
    );

    // Attempt premature release
    try {
      await program.methods
        .releaseMilestoneFunds(appId)
        .accounts({
          caller: builder.publicKey,
          programState: programStatePda,
          application: applicationPda,
          builder: builder.publicKey,
          vault: vaultPda,
          builderTokenAccount: builderAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .signers([builder])
        .rpc();
      assert.fail("Should have failed with InsufficientAttestations");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("InsufficientAttestations");
    }
  });

  it("5. Reaches quorum and executes instant milestone payout", async () => {
    const appId = new anchor.BN(0);
    const appIdBuffer = Buffer.alloc(8);
    appIdBuffer.writeBigUInt64LE(BigInt(0));

    const [applicationPda] = PublicKey.findProgramAddressSync(
      [APPLICATION_SEED, programStatePda.toBuffer(), appIdBuffer],
      program.programId
    );

    // Second committee member signs
    await program.methods
      .attestMilestone(appId, 0)
      .accounts({
        committeeMember: committee2.publicKey,
        programState: programStatePda,
        application: applicationPda,
      } as any)
      .signers([committee2])
      .rpc();

    const builderAta = await createAccount(
      provider.connection,
      admin,
      tokenMint,
      builder.publicKey
    ).catch(async () => {
      // Return existing account if created earlier
      const accounts = await provider.connection.getTokenAccountsByOwner(builder.publicKey, { mint: tokenMint });
      return accounts.value[0].pubkey;
    });

    // Execute release
    await program.methods
      .releaseMilestoneFunds(appId)
      .accounts({
        caller: builder.publicKey,
        programState: programStatePda,
        application: applicationPda,
        builder: builder.publicKey,
        vault: vaultPda,
        builderTokenAccount: builderAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([builder])
      .rpc();

    const builderTokenBal = await getAccount(provider.connection, builderAta);
    assert.equal(Number(builderTokenBal.amount), 1200 * 1e6);

    const app = await program.account.grantApplication.fetch(applicationPda);
    assert.equal(app.milestonesCompleted, 1);
    assert.equal(app.totalClaimed.toNumber(), 1200 * 1e6);
  });
});