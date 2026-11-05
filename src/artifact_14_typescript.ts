// File: tests/rumbo-breakpoint.ts
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { RumboBreakpoint } from "../target/types/rumbo_breakpoint";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { assert, expect } from "chai";

describe("Rumbo a Breakpoint 2026 Protocol Tests", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.RumboBreakpoint as Program<RumboBreakpoint>;

  const admin = (provider.wallet as any).payer as Keypair;
  const checkinOracle = Keypair.generate();
  const applicantOne = Keypair.generate();
  const reviewerOne = Keypair.generate();
  const reviewerTwo = Keypair.generate();

  const roundId = new anchor.BN(2026);
  const grantAmount = new anchor.BN(4 * LAMPORTS_PER_SOL); // 4 SOL: 2 SOL Tranche 1 + 2 SOL Tranche 2

  let globalConfigPda: PublicKey;
  let roundPda: PublicKey;
  let vaultPda: PublicKey;
  let applicantPda: PublicKey;

  before(async () => {
    // AirDrop Lamports to test participants
    const airdropSigners = [applicantOne, reviewerOne, reviewerTwo, checkinOracle];
    for (const s of airdropSigners) {
      const sig = await provider.connection.requestAirdrop(s.publicKey, 5 * LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
    }

    [globalConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("global_config")],
      program.programId
    );

    [roundPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("round"), roundId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), roundPda.toBuffer()],
      program.programId
    );

    [applicantPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("applicant"), roundPda.toBuffer(), applicantOne.publicKey.toBuffer()],
      program.programId
    );
  });

  it("1. Initializes Global Program Config", async () => {
    await program.methods
      .initializeGlobal(checkinOracle.publicKey)
      .accounts({
        globalConfig: globalConfigPda,
        admin: admin.publicKey,
        checkinOracle: checkinOracle.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const configAccount = await program.account.globalConfig.fetch(globalConfigPda);
    assert.ok(configAccount.admin.equals(admin.publicKey));
    assert.ok(configAccount.checkinOracle.equals(checkinOracle.publicKey));
    assert.equal(configAccount.totalRounds.toNumber(), 0);
  });

  it("2. Initializes Scholarship Round with Escrow Vault", async () => {
    const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour in future
    const minReviews = 2;
    const passScore = 75;

    await program.methods
      .initializeRound(
        roundId,
        grantAmount,
        new anchor.BN(deadline),
        minReviews,
        passScore
      )
      .accounts({
        globalConfig: globalConfigPda,
        round: roundPda,
        escrowVault: vaultPda,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // Fund the escrow vault with 10 SOL
    const tx = new anchor.web3.Transaction().add(
      SystemProgram.transfer({
        fromPubkey: admin.publicKey,
        toPubkey: vaultPda,
        lamports: 10 * LAMPORTS_PER_SOL,
      })
    );
    await provider.sendAndConfirm(tx);

    const round = await program.account.scholarshipRound.fetch(roundPda);
    assert.equal(round.roundId.toNumber(), 2026);
    assert.equal(round.passScoreThreshold, 75);
    assert.equal(round.minReviewsRequired, 2);
  });

  it("3. Applicant submits application with IPFS hash", async () => {
    const dummyCidBytes = new Array(32).fill(7); // Mock 32-byte CID

    await program.methods
      .apply(dummyCidBytes)
      .accounts({
        round: roundPda,
        applicantRecord: applicantPda,
        applicant: applicantOne.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([applicantOne])
      .rpc();

    const record = await program.account.applicantRecord.fetch(applicantPda);
    assert.ok(record.applicant.equals(applicantOne.publicKey));
    assert.equal(record.tranche1Lamports.toNumber(), 2 * LAMPORTS_PER_SOL);
    assert.equal(record.tranche2Lamports.toNumber(), 2 * LAMPORTS_PER_SOL);
  });

  it("4. Reviewers score candidate", async () => {
    const [reviewPda1] = PublicKey.findProgramAddressSync(
      [Buffer.from("review"), applicantPda.toBuffer(), reviewerOne.publicKey.toBuffer()],
      program.programId
    );

    const [reviewPda2] = PublicKey.findProgramAddressSync(
      [Buffer.from("review"), applicantPda.toBuffer(), reviewerTwo.publicKey.toBuffer()],
      program.programId
    );

    // Reviewer 1 scores 80
    await program.methods
      .submitReview(80)
      .accounts({
        round: roundPda,
        applicantRecord: applicantPda,
        reviewRecord: reviewPda1,
        reviewer: reviewerOne.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([reviewerOne])
      .rpc();

    // Reviewer 2 scores 90
    await program.methods
      .submitReview(90)
      .accounts({
        round: roundPda,
        applicantRecord: applicantPda,
        reviewRecord: reviewPda2,
        reviewer: reviewerTwo.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([reviewerTwo])
      .rpc();

    const record = await program.account.applicantRecord.fetch(applicantPda);
    assert.equal(record.reviewCount, 2);
    assert.equal(record.scoreSum, 170); // 80 + 90
  });

  it("5. Finalize applicant approval after quorum reached", async () => {
    await program.methods
      .finalize()
      .accounts({
        round: roundPda,
        applicantRecord: applicantPda,
        authority: admin.publicKey,
      })
      .rpc();

    const record = await program.account.applicantRecord.fetch(applicantPda);
    // Average = 85 >= 75 -> Approved
    expect(record.status).to.deep.equal({ approved: {} });
  });

  it("6. Applicant claims Tranche 1 (50% travel prep funding)", async () => {
    const balBefore = await provider.connection.getBalance(applicantOne.publicKey);

    await program.methods
      .claimTranche1()
      .accounts({
        round: roundPda,
        applicantRecord: applicantPda,
        escrowVault: vaultPda,
        applicant: applicantOne.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([applicantOne])
      .rpc();

    const balAfter = await provider.connection.getBalance(applicantOne.publicKey);
    assert.isAbove(balAfter, balBefore + 1.99 * LAMPORTS_PER_SOL);

    const record = await program.account.applicantRecord.fetch(applicantPda);
    expect(record.status).to.deep.equal({ tranche1Disbursed: {} });
  });

  it("7. Fails when unauthorized key tries to sign Tranche 2 check-in", async () => {
    const impostor = Keypair.generate();
    try {
      await program.methods
        .claimTranche2()
        .accounts({
          globalConfig: globalConfigPda,
          round: roundPda,
          applicantRecord: applicantPda,
          escrowVault: vaultPda,
          checkinAuthority: impostor.publicKey,
          applicant: applicantOne.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([impostor, applicantOne])
        .rpc();
      assert.fail("Should have failed with UnauthorizedSigner");
    } catch (err: any) {
      assert.include(err.toString(), "UnauthorizedSigner");
    }
  });

  it("8. Successfully claims Tranche 2 with verified Breakpoint check-in signature", async () => {
    await program.methods
      .claimTranche2()
      .accounts({
        globalConfig: globalConfigPda,
        round: roundPda,
        applicantRecord: applicantPda,
        escrowVault: vaultPda,
        checkinAuthority: checkinOracle.publicKey,
        applicant: applicantOne.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([checkinOracle, applicantOne])
      .rpc();

    const record = await program.account.applicantRecord.fetch(applicantPda);
    expect(record.status).to.deep.equal({ fullyCompleted: {} });
  });
});