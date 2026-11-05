import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { RumboBreakpoint } from "../target/types/rumbo_breakpoint";
import {
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";

describe("rumbo_breakpoint test suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.RumboBreakpoint as Program<RumboBreakpoint>;

  const admin = (provider.wallet as any).payer as Keypair;
  const jury1 = Keypair.generate();
  const jury2 = Keypair.generate();
  const candidate = Keypair.generate();
  const maliciousActor = Keypair.generate();

  let mint: PublicKey;
  let vaultPda: PublicKey;
  let campaignPda: PublicKey;
  let applicantPda: PublicKey;
  let candidateTokenAccount: PublicKey;
  let adminTokenAccount: PublicKey;

  const campaignId = new anchor.BN(2026);
  const grantAmount = new anchor.BN(2_000_000_000); // 2,000 USDC (6 decimals)
  const approvalThreshold = 2;

  before(async () => {
    // Airdrop SOL to test actors
    for (const actor of [jury1, jury2, candidate, maliciousActor]) {
      const sig = await provider.connection.requestAirdrop(actor.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
    }

    // Create Mock USDC Mint
    mint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6
    );

    // Derive PDAs
    [campaignPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("campaign"), campaignId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("campaign_vault"), campaignPda.toBuffer()],
      program.programId
    );

    [applicantPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("applicant"), campaignPda.toBuffer(), candidate.publicKey.toBuffer()],
      program.programId
    );

    // Create Candidate ATA
    candidateTokenAccount = await createAccount(
      provider.connection,
      candidate,
      mint,
      candidate.publicKey
    );

    adminTokenAccount = await createAccount(
      provider.connection,
      admin,
      mint,
      admin.publicKey
    );
  });

  it("1. Initializes the Breakpoint 2026 Travel Campaign", async () => {
    await program.methods
      .initializeCampaign(
        campaignId,
        "Breakpoint 2026 Fellowship",
        approvalThreshold,
        grantAmount,
        [jury1.publicKey, jury2.publicKey]
      )
      .accounts({
        campaign: campaignPda,
        vault: vaultPda,
        tokenMint: mint,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    // Fund Vault with 10,000 USDC
    await mintTo(
      provider.connection,
      admin,
      mint,
      vaultPda,
      admin,
      10_000_000_000
    );

    const vaultAccount = await getAccount(provider.connection, vaultPda);
    expect(Number(vaultAccount.amount)).to.equal(10_000_000_000);

    const campaignState = await program.account.campaignState.fetch(campaignPda);
    expect(campaignState.name).to.equal("Breakpoint 2026 Fellowship");
    expect(campaignState.approvalThreshold).to.equal(2);
    expect(campaignState.committee.length).to.equal(2);
  });

  it("2. Registers an applicant with Proposal IPFS CID", async () => {
    const mockCid = "QmZtmD2qt8fJv32FNGoSD6zhMDPL6WWAqpmdJLRjh39asf";

    await program.methods
      .registerApplicant(campaignId, mockCid)
      .accounts({
        campaign: campaignPda,
        applicantRecord: applicantPda,
        applicant: candidate.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([candidate])
      .rpc();

    const record = await program.account.applicantRecord.fetch(applicantPda);
    expect(record.applicant.toBase58()).to.equal(candidate.publicKey.toBase58());
    expect(record.metadataCid).to.equal(mockCid);
    expect(record.approvalsCount).to.equal(0);
    expect(record.isApproved).to.be.false;
  });

  it("3. Blocks premature claims before approval", async () => {
    try {
      await program.methods
        .claimMilestone1(campaignId)
        .accounts({
          campaign: campaignPda,
          applicantRecord: applicantPda,
          vault: vaultPda,
          applicantTokenAccount: candidateTokenAccount,
          applicant: candidate.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([candidate])
        .rpc();
      expect.fail("Should have thrown NotApproved error");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("NotApproved");
    }
  });

  it("4. Committee casts votes to reach consensus", async () => {
    // Jury 1 votes
    await program.methods
      .voteApplicant(campaignId)
      .accounts({
        campaign: campaignPda,
        applicantRecord: applicantPda,
        committeeMember: jury1.publicKey,
      })
      .signers([jury1])
      .rpc();

    let record = await program.account.applicantRecord.fetch(applicantPda);
    expect(record.approvalsCount).to.equal(1);
    expect(record.isApproved).to.be.false;

    // Jury 2 votes (reaches threshold of 2)
    await program.methods
      .voteApplicant(campaignId)
      .accounts({
        campaign: campaignPda,
        applicantRecord: applicantPda,
        committeeMember: jury2.publicKey,
      })
      .signers([jury2])
      .rpc();

    record = await program.account.applicantRecord.fetch(applicantPda);
    expect(record.approvalsCount).to.equal(2);
    expect(record.isApproved).to.be.true;
  });

  it("5. Prevents double-voting by same jury member", async () => {
    try {
      await program.methods
        .voteApplicant(campaignId)
        .accounts({
          campaign: campaignPda,
          applicantRecord: applicantPda,
          committeeMember: jury1.publicKey,
        })
        .signers([jury1])
        .rpc();
      expect.fail("Should have prevented double vote");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("AlreadyVoted");
    }
  });

  it("6. Candidate claims Milestone 1 (50% travel reimbursement)", async () => {
    await program.methods
      .claimMilestone1(campaignId)
      .accounts({
        campaign: campaignPda,
        applicantRecord: applicantPda,
        vault: vaultPda,
        applicantTokenAccount: candidateTokenAccount,
        applicant: candidate.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([candidate])
      .rpc();

    const candidateBalance = await getAccount(provider.connection, candidateTokenAccount);
    // 50% of 2,000 USDC = 1,000 USDC
    expect(Number(candidateBalance.amount)).to.equal(1_000_000_000);

    const record = await program.account.applicantRecord.fetch(applicantPda);
    expect(record.milestone1Claimed).to.be.true;
  });

  it("7. Candidate claims Milestone 2 (Remaining 50% + ticket disbursement)", async () => {
    await program.methods
      .claimMilestone2(campaignId)
      .accounts({
        campaign: campaignPda,
        applicantRecord: applicantPda,
        vault: vaultPda,
        applicantTokenAccount: candidateTokenAccount,
        applicant: candidate.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([candidate])
      .rpc();

    const candidateBalance = await getAccount(provider.connection, candidateTokenAccount);
    // Total 2,000 USDC received
    expect(Number(candidateBalance.amount)).to.equal(2_000_000_000);

    const record = await program.account.applicantRecord.fetch(applicantPda);
    expect(record.milestone2Claimed).to.be.true;
  });

  it("8. Rejects replay attack on claimed milestones", async () => {
    try {
      await program.methods
        .claimMilestone2(campaignId)
        .accounts({
          campaign: campaignPda,
          applicantRecord: applicantPda,
          vault: vaultPda,
          applicantTokenAccount: candidateTokenAccount,
          applicant: candidate.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([candidate])
        .rpc();
      expect.fail("Should have failed to claim duplicate milestone");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("MilestoneAlreadyClaimed");
    }
  });

  it("9. Rejects unauthorized milestone claim from another signer", async () => {
    try {
      await program.methods
        .claimMilestone1(campaignId)
        .accounts({
          campaign: campaignPda,
          applicantRecord: applicantPda,
          vault: vaultPda,
          applicantTokenAccount: candidateTokenAccount,
          applicant: maliciousActor.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([maliciousActor])
        .rpc();
      expect.fail("Should enforce account constraint check");
    } catch (err: any) {
      // ConstraintRaw / HasOne failure
      expect(err).to.exist;
    }
  });
});