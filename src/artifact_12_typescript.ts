import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { RumboProtocol } from "../target/types/rumbo_protocol";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";

describe("rumbo_protocol test suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.RumboProtocol as Program<RumboProtocol>;

  const competitionId = "breakpoint-2026-latam";
  const awardAmount = new anchor.BN(2 * LAMPORTS_PER_SOL);
  const jurorThreshold = 2;

  let competitionPda: PublicKey;
  let vaultPda: PublicKey;
  let applicantPda: PublicKey;

  const hacker = Keypair.generate();
  const jurorA = Keypair.generate();
  const jurorB = Keypair.generate();
  const unauthorizedUser = Keypair.generate();

  before(async () => {
    // Airdrop funds to actors
    const airdropPromises = [hacker, jurorA, jurorB, unauthorizedUser].map(async (account) => {
      const sig = await provider.connection.requestAirdrop(account.publicKey, 5 * LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
    });
    await Promise.all(airdropPromises);

    [competitionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("competition"), Buffer.from(competitionId)],
      program.programId
    );

    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("rumbo_vault"), competitionPda.toBuffer()],
      program.programId
    );

    [applicantPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("applicant"), competitionPda.toBuffer(), hacker.publicKey.toBuffer()],
      program.programId
    );
  });

  it("1. Initializes a new competition and funds vault escrow", async () => {
    const currentSlot = await provider.connection.getSlot();
    const deadlineSlot = new anchor.BN(currentSlot + 1000);

    await program.methods
      .initializeCompetition(competitionId, awardAmount, jurorThreshold, deadlineSlot)
      .accounts({
        competition: competitionPda,
        vault: vaultPda,
        authority: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // Fund vault PDA with 2 SOL
    const tx = new anchor.web3.Transaction().add(
      SystemProgram.transfer({
        fromPubkey: provider.wallet.publicKey,
        toPubkey: vaultPda,
        lamports: 2 * LAMPORTS_PER_SOL,
      })
    );
    await provider.sendAndConfirm(tx);

    const compState = await program.account.competitionState.fetch(competitionPda);
    expect(compState.competitionId).to.equal(competitionId);
    expect(compState.jurorThreshold).to.equal(jurorThreshold);

    const vaultBalance = await provider.connection.getBalance(vaultPda);
    expect(vaultBalance).to.be.at.least(2 * LAMPORTS_PER_SOL);
  });

  it("2. Hacker registers as an applicant", async () => {
    await program.methods
      .registerApplicant("solana_builder_latam", "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi")
      .accounts({
        competition: competitionPda,
        application: applicantPda,
        applicant: hacker.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([hacker])
      .rpc();

    const applicationState = await program.account.applicationState.fetch(applicantPda);
    expect(applicationState.applicant.toBase58()).to.equal(hacker.publicKey.toBase58());
    expect(applicationState.githubHandle).to.equal("solana_builder_latam");
    expect(applicationState.votesCount).to.equal(0);
  });

  it("3. Juror A and Juror B vote to achieve consensus approval", async () => {
    const [votePdaA] = PublicKey.findProgramAddressSync(
      [Buffer.from("vote"), competitionPda.toBuffer(), hacker.publicKey.toBuffer(), jurorA.publicKey.toBuffer()],
      program.programId
    );

    // Juror A votes 90/100
    await program.methods
      .voteApplicant(90)
      .accounts({
        competition: competitionPda,
        application: applicantPda,
        applicant: hacker.publicKey,
        jurorVote: votePdaA,
        juror: jurorA.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([jurorA])
      .rpc();

    let applicationState = await program.account.applicationState.fetch(applicantPda);
    expect(applicationState.votesCount).to.equal(1);
    expect(applicationState.scoreAggregate.toNumber()).to.equal(90);

    const [votePdaB] = PublicKey.findProgramAddressSync(
      [Buffer.from("vote"), competitionPda.toBuffer(), hacker.publicKey.toBuffer(), jurorB.publicKey.toBuffer()],
      program.programId
    );

    // Juror B votes 80/100 (Average = 85 >= 75 => Approved)
    await program.methods
      .voteApplicant(80)
      .accounts({
        competition: competitionPda,
        application: applicantPda,
        applicant: hacker.publicKey,
        jurorVote: votePdaB,
        juror: jurorB.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([jurorB])
      .rpc();

    applicationState = await program.account.applicationState.fetch(applicantPda);
    expect(applicationState.votesCount).to.equal(2);
    expect(applicationState.scoreAggregate.toNumber()).to.equal(170);
    expect(applicationState.status).to.deep.equal({ approved: {} });
  });

  it("4. Hacker claims Milestone 0 (Tranche 1: 40% for flights/hotel)", async () => {
    const initialHackerBalance = await provider.connection.getBalance(hacker.publicKey);

    await program.methods
      .claimTravelMilestone(0)
      .accounts({
        competition: competitionPda,
        application: applicantPda,
        vault: vaultPda,
        applicant: hacker.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([hacker])
      .rpc();

    const postHackerBalance = await provider.connection.getBalance(hacker.publicKey);
    const expectedTranche = 0.8 * LAMPORTS_PER_SOL; // 40% of 2 SOL

    // Account for minor transaction fee
    expect(postHackerBalance - initialHackerBalance).to.be.closeTo(expectedTranche, 0.01 * LAMPORTS_PER_SOL);

    const applicationState = await program.account.applicationState.fetch(applicantPda);
    expect(applicationState.milestonesClaimed).to.equal(1); // 1 << 0 = 1
  });

  it("5. Rejects double-claim of the same milestone", async () => {
    try {
      await program.methods
        .claimTravelMilestone(0)
        .accounts({
          competition: competitionPda,
          application: applicantPda,
          vault: vaultPda,
          applicant: hacker.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([hacker])
        .rpc();
      expect.fail("Should have thrown error on double claim");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("MilestoneAlreadyClaimed");
    }
  });

  it("6. Rejects unauthorized caller trying to claim milestone for hacker", async () => {
    try {
      await program.methods
        .claimTravelMilestone(1)
        .accounts({
          competition: competitionPda,
          application: applicantPda,
          vault: vaultPda,
          applicant: unauthorizedUser.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([unauthorizedUser])
        .rpc();
      expect.fail("Should have thrown unauthorized signer error");
    } catch (err: any) {
      expect(err).to.exist;
    }
  });
});