import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { RumboProtocol } from "../target/types/rumbo_protocol";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import { assert, expect } from "chai";
import * as crypto from "crypto";

describe("rumbo_protocol integration test suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.RumboProtocol as Program<RumboProtocol>;

  const admin = Keypair.generate();
  const juror1 = Keypair.generate();
  const juror2 = Keypair.generate();
  const applicant = Keypair.generate();
  const unauthorizedJuror = Keypair.generate();

  let vaultMint: PublicKey;
  let adminTokenAccount: PublicKey;
  let applicantTokenAccount: PublicKey;
  let campaignPda: PublicKey;
  let vaultPda: PublicKey;
  let applicationPda: PublicKey;

  const TOTAL_TICKETS = 50;
  const QUORUM_REQUIRED = 2; // 2 out of 2 jurors must vote
  const TOTAL_STIPEND = new anchor.BN(2_000_000_000); // 2,000 USDC (6 decimals)

  before(async () => {
    // 1. Airdrop SOL to test actors
    const airdropSigners = [admin, juror1, juror2, applicant, unauthorizedJuror];
    for (const actor of airdropSigners) {
      const sig = await provider.connection.requestAirdrop(actor.publicKey, 5 * anchor.web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
    }

    // 2. Create USDC Mock Mint
    vaultMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6
    );

    // 3. Find Program PDAs
    [campaignPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("rumbo_campaign"), admin.publicKey.toBuffer()],
      program.programId
    );

    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("rumbo_vault"), admin.publicKey.toBuffer()],
      program.programId
    );

    [applicationPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("grant_applicant"), campaignPda.toBuffer(), applicant.publicKey.toBuffer()],
      program.programId
    );

    // 4. Create Token Accounts
    adminTokenAccount = await createAccount(
      provider.connection,
      admin,
      vaultMint,
      admin.publicKey
    );

    applicantTokenAccount = await createAccount(
      provider.connection,
      applicant,
      vaultMint,
      applicant.publicKey
    );

    // Mint $10,000 USDC to admin
    await mintTo(
      provider.connection,
      admin,
      vaultMint,
      adminTokenAccount,
      admin.publicKey,
      10_000_000_000
    );
  });

  it("1. Initializes Campaign with Jury Quorum and Vault PDA", async () => {
    await program.methods
      .initializeCampaign(
        QUORUM_REQUIRED,
        TOTAL_TICKETS,
        [juror1.publicKey, juror2.publicKey]
      )
      .accounts({
        campaign: campaignPda,
        vaultMint: vaultMint,
        vault: vaultPda,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([admin])
      .rpc();

    const campaignState = await program.account.campaignState.fetch(campaignPda);
    assert.equal(campaignState.admin.toBase58(), admin.publicKey.toBase58());
    assert.equal(campaignState.quorumRequired, QUORUM_REQUIRED);
    assert.equal(campaignState.totalTicketQuota, TOTAL_TICKETS);
    assert.equal(campaignState.allocatedTickets, 0);
  });

  it("2. Funds Escrow Vault with USDC", async () => {
    const fundAmount = new anchor.BN(5_000_000_000); // 5,000 USDC

    await program.methods
      .fundEscrow(fundAmount)
      .accounts({
        campaign: campaignPda,
        vault: vaultPda,
        funder: admin.publicKey,
        funderTokenAccount: adminTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([admin])
      .rpc();

    const vaultAccount = await getAccount(provider.connection, vaultPda);
    assert.equal(vaultAccount.amount.toString(), fundAmount.toString());
  });

  it("3. Developer Applies for Rumbo a Breakpoint Grant", async () => {
    const mockHash = crypto.createHash("sha256").update("github.com/latam-dev/solana-defi").digest();
    const hashArray = Array.from(mockHash);

    await program.methods
      .applyGrant(TOTAL_STIPEND, hashArray)
      .accounts({
        campaign: campaignPda,
        grantApplication: applicationPda,
        applicant: applicant.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([applicant])
      .rpc();

    const appState = await program.account.grantApplicationState.fetch(applicationPda);
    assert.equal(appState.applicant.toBase58(), applicant.publicKey.toBase58());
    assert.equal(appState.stipendTotal.toString(), TOTAL_STIPEND.toString());
    assert.equal(appState.currentMilestone, 0);
    assert.isFalse(appState.ticketAwarded);
  });

  it("4. Submits Milestone 1 Proof (Prototype Delivered)", async () => {
    const proof1 = Array.from(crypto.createHash("sha256").update("commit-sha-release-v1").digest());

    await program.methods
      .submitMilestoneProof(0, proof1)
      .accounts({
        grantApplication: applicationPda,
        applicant: applicant.publicKey,
      })
      .signers([applicant])
      .rpc();

    const appState = await program.account.grantApplicationState.fetch(applicationPda);
    assert.deepEqual(appState.milestones[0].proofHash, proof1);
  });

  it("5. Rejects Unauthorized Juror Vote", async () => {
    try {
      await program.methods
        .voteMilestone(0, true)
        .accounts({
          campaign: campaignPda,
          grantApplication: applicationPda,
          juror: unauthorizedJuror.publicKey,
        })
        .signers([unauthorizedJuror])
        .rpc();
      assert.fail("Should have thrown UnauthorizedJuror");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("UnauthorizedJuror");
    }
  });

  it("6. Juror 1 and Juror 2 Approve Milestone 1 (Quorum Reached)", async () => {
    // Juror 1 Vote
    await program.methods
      .voteMilestone(0, true)
      .accounts({
        campaign: campaignPda,
        grantApplication: applicationPda,
        juror: juror1.publicKey,
      })
      .signers([juror1])
      .rpc();

    // Juror 2 Vote
    await program.methods
      .voteMilestone(0, true)
      .accounts({
        campaign: campaignPda,
        grantApplication: applicationPda,
        juror: juror2.publicKey,
      })
      .signers([juror2])
      .rpc();

    const appState = await program.account.grantApplicationState.fetch(applicationPda);
    assert.equal(appState.milestones[0].approvalsCount, 2);
    // MilestoneStatus::Approved is index 2
    assert.deepEqual(appState.milestones[0].status, { approved: {} });
  });

  it("7. Disburses Tranche 1 (30% of $2,000 = $600 USDC)", async () => {
    const expectedTranche1 = 600_000_000; // 600 USDC

    await program.methods
      .disburseMilestoneFunds(0)
      .accounts({
        campaign: campaignPda,
        vault: vaultPda,
        grantApplication: applicationPda,
        applicantTokenAccount: applicantTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const applicantAta = await getAccount(provider.connection, applicantTokenAccount);
    assert.equal(applicantAta.amount.toString(), expectedTranche1.toString());

    const appState = await program.account.grantApplicationState.fetch(applicationPda);
    assert.equal(appState.currentMilestone, 1);
    assert.isFalse(appState.ticketAwarded);
  });

  it("8. Simulates Milestone 2 & 3 Completion -> Awards Breakpoint 2026 Ticket", async () => {
    // --- Milestone 2: Flight Itinerary Proof (40% = $800) ---
    const proof2 = Array.from(crypto.createHash("sha256").update("latam-airlines-booking-ref").digest());
    await program.methods
      .submitMilestoneProof(1, proof2)
      .accounts({ grantApplication: applicationPda, applicant: applicant.publicKey })
      .signers([applicant])
      .rpc();

    await program.methods
      .voteMilestone(1, true)
      .accounts({ campaign: campaignPda, grantApplication: applicationPda, juror: juror1.publicKey })
      .signers([juror1])
      .rpc();

    await program.methods
      .voteMilestone(1, true)
      .accounts({ campaign: campaignPda, grantApplication: applicationPda, juror: juror2.publicKey })
      .signers([juror2])
      .rpc();

    await program.methods
      .disburseMilestoneFunds(1)
      .accounts({
        campaign: campaignPda,
        vault: vaultPda,
        grantApplication: applicationPda,
        applicantTokenAccount: applicantTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    // --- Milestone 3: Check-in Badge at Breakpoint 2026 (30% = $600) ---
    const proof3 = Array.from(crypto.createHash("sha256").update("breakpoint-venue-nfc-checkin").digest());
    await program.methods
      .submitMilestoneProof(2, proof3)
      .accounts({ grantApplication: applicationPda, applicant: applicant.publicKey })
      .signers([applicant])
      .rpc();

    await program.methods
      .voteMilestone(2, true)
      .accounts({ campaign: campaignPda, grantApplication: applicationPda, juror: juror1.publicKey })
      .signers([juror1])
      .rpc();

    await program.methods
      .voteMilestone(2, true)
      .accounts({ campaign: campaignPda, grantApplication: applicationPda, juror: juror2.publicKey })
      .signers([juror2])
      .rpc();

    await program.methods
      .disburseMilestoneFunds(2)
      .accounts({
        campaign: campaignPda,
        vault: vaultPda,
        grantApplication: applicationPda,
        applicantTokenAccount: applicantTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    // Verify 100% of funds disbursed ($2,000 USDC) & Ticket Awarded
    const applicantAtaFinal = await getAccount(provider.connection, applicantTokenAccount);
    assert.equal(applicantAtaFinal.amount.toString(), TOTAL_STIPEND.toString());

    const finalAppState = await program.account.grantApplicationState.fetch(applicationPda);
    assert.isTrue(finalAppState.ticketAwarded);

    const campaignState = await program.account.campaignState.fetch(campaignPda);
    assert.equal(campaignState.allocatedTickets, 1);
  });
});